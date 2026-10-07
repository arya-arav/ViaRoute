import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import { prisma } from '@viaroute/db';
import { REDIS } from '../common/redis.module';
import { StorageService } from '../common/storage.service';
import { runsJobs } from '../config';

const PURGE_EVERY_MS = 60 * 60_000;
const BATCH = 500;
const QUEUE = 'recordings';

/** Copy a finished recording from the carrier's temporary URL into our storage. */
export interface RecordingDownload {
  callId: string;
  key: string;
  url: string;
  /** Carriers that protect recordings need these to download (kept only while the job waits). */
  headers?: Record<string, string>;
}

/**
 * Call recordings: copying them from the carrier (queued, done by workers so webhooks stay fast),
 * deleting on request, and deleting old ones by each account's retention setting.
 */
@Injectable()
export class RecordingsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RecordingsService.name);
  private timer?: NodeJS.Timeout;
  private queue!: Queue<RecordingDownload>;
  private worker?: Worker<RecordingDownload>;

  constructor(private storage: StorageService, @Inject(REDIS) private redis: Redis) {}

  onModuleInit() {
    const connection = { url: process.env.REDIS_URL ?? 'redis://localhost:6379' };
    this.queue = new Queue(QUEUE, { connection });
    if (!runsJobs) return; // API servers only queue; workers copy and clean up
    this.worker = new Worker(QUEUE, (job) => this.download(job), { connection, concurrency: Number(process.env.RECORDING_CONCURRENCY ?? 10) });
    this.worker.on('error', (e) => this.log.error(e.message));
    if (process.env.NODE_ENV === 'test') return; // tests call purgeExpired() directly
    this.timer = setInterval(() => void this.purgeExpired().catch((e) => this.log.error(e.message)), PURGE_EVERY_MS);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.worker?.close();
    await this.queue?.close();
  }

  /** Queues the copy. Carrier links expire (Telnyx: 10 min), so retries are quick. */
  async enqueueDownload(job: RecordingDownload) {
    await this.queue.add('download', job, {
      jobId: `rec-${job.callId}`, // one copy per call even if the carrier repeats the webhook
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: 1000,
    });
  }

  /** Stores audio we already have (simulator) right away. */
  async saveAudio(callId: string, key: string, audio: Buffer) {
    await this.storage.put(key, audio);
    await this.attach(callId, key);
  }

  private async download(job: Job<RecordingDownload>) {
    const { callId, key, url, headers } = job.data;
    const saved = await this.storage.putFromUrl(key, url, headers);
    if (!saved) throw new Error(`Recording for call ${callId} not copied yet`); // let BullMQ retry
    await this.attach(callId, saved);
  }

  private async attach(callId: string, key: string) {
    await prisma.call.update({ where: { id: callId }, data: { recordingUrl: key, recordingSize: await this.storage.size(key), recordingDeletedAt: null } });
  }

  /** Removes one call's recording (file and link). Returns false when there was none. */
  async remove(callId: string): Promise<boolean> {
    const call = await prisma.call.findUnique({ where: { id: callId }, select: { recordingUrl: true } });
    if (!call?.recordingUrl) return false;
    await this.storage.remove(call.recordingUrl);
    await prisma.call.update({ where: { id: callId }, data: { recordingUrl: null, recordingSize: null, recordingDeletedAt: new Date() } });
    return true;
  }

  /** Deletes recordings older than each account's retention. Safe to run from several servers. */
  async purgeExpired(now = new Date()): Promise<number> {
    const lock = await this.redis.set('lock:recordings:purge', '1', 'EX', 1800, 'NX');
    if (!lock) return 0;
    let removed = 0;
    try {
      const tenants = await prisma.tenant.findMany({ where: { recordingRetentionDays: { not: null } }, select: { id: true, recordingRetentionDays: true } });
      for (const t of tenants) {
        const before = new Date(now.getTime() - t.recordingRetentionDays! * 86400_000);
        for (;;) {
          const old = await prisma.call.findMany({
            where: { tenantId: t.id, recordingUrl: { not: null }, startedAt: { lt: before } },
            select: { id: true, recordingUrl: true },
            take: BATCH,
          });
          if (!old.length) break;
          for (const c of old) await this.storage.remove(c.recordingUrl!);
          await prisma.call.updateMany({ where: { id: { in: old.map((c) => c.id) } }, data: { recordingUrl: null, recordingSize: null, recordingDeletedAt: now } });
          removed += old.length;
          if (old.length < BATCH) break;
        }
      }
      if (removed) this.log.log(`Deleted ${removed} recording(s) past their retention`);
      return removed;
    } finally {
      await this.redis.del('lock:recordings:purge');
    }
  }
}
