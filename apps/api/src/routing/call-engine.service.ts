import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { CallStatus, NumberStatus, Prisma, prisma, RepeatRouting, TenantStatus, TransactionType } from '@viaroute/db';
import { WalletService } from '../billing/wallet.service';
import { REDIS } from '../common/redis.module';
import { ProvidersService } from '../telephony/providers.service';
import { DEFAULT_PER_MINUTE } from '../config';
import { RecordingsService } from './recordings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { stateForNumber } from './area-codes';
import { AgentsService } from './agents.service';
import { fillWhisper, IVR_MAX_STEPS, type IvrAction, type IvrFlow } from './ivr';
import { SpamService } from './spam.service';
import { CALL_CONTROLS, type CallControl, type GatherEvent, type SharedCallControls, type HangupEvent, type InboundEvent, type LegEvent, type ProviderName, type RecordingEvent } from './call-control.types';
import { CapsService, type CapLimits } from './caps.service';
import { fillMacros, PostbackService } from './postback.service';
import { geoAllows, isOpen, orderByPriorityAndWeight, type GeoRules, type Schedule } from './rules';

export const RECORDING_NOTICE = 'This call may be recorded for quality assurance.';
export const NO_AGENT_MESSAGE = 'Sorry, no one is available to take your call right now. Please try again later.';
const STATE_TTL = 12 * 3600;

interface Candidate {
  routeId: string;
  buyerId: string | null;
  targetId: string | null;
  buyerName: string;
  destination: string;
  ringTimeoutSec: number;
  limits: CapLimits;
  /** Caps shared by every campaign: the target's, and the buyer's (main line + all its targets). */
  targetName: string | null;
  targetLimits: CapLimits | null;
  ownerName: string | null;
  buyerLimits: CapLimits | null;
  /** Set when this target is an in-house agent's softphone. */
  agentTargetId?: string;
}

const limitsOf = (x: { concurrencyCap: number | null; hourlyCap: number | null; dailyCap: number | null; monthlyCap: number | null }): CapLimits => ({
  concurrencyCap: x.concurrencyCap,
  hourlyCap: x.hourlyCap,
  dailyCap: x.dailyCap,
  monthlyCap: x.monthlyCap,
});

/** Who "had" a call, for repeat callers: the buyer, or the target when it has no buyer. */
const ownerKey = (x: { buyerId: string | null; targetId: string | null }) => (x.buyerId ? `b:${x.buyerId}` : x.targetId ? `t:${x.targetId}` : null);

/**
 * Repeat callers: DIFFERENT tries buyers/targets that haven't had this caller first (the others stay
 * as a last resort); SAME tries the one that had their last call first; NORMAL leaves the order alone.
 * `seen` is newest first.
 */
export function orderForRepeat<T extends { buyerId: string | null; targetId: string | null }>(candidates: T[], seen: string[], mode: RepeatRouting): T[] {
  if (!seen.length || mode === RepeatRouting.NORMAL) return candidates;
  if (mode === RepeatRouting.SAME) {
    const last = seen[0];
    return [...candidates.filter((c) => ownerKey(c) === last), ...candidates.filter((c) => ownerKey(c) !== last)];
  }
  const had = new Set(seen);
  return [...candidates.filter((c) => !had.has(ownerKey(c)!)), ...candidates.filter((c) => had.has(ownerKey(c)!))];
}

/** Live state of one call, kept in Redis while it's in progress. */
interface CallState {
  callId: string;
  tenantId: string;
  provider: ProviderName;
  /** Carrier account the call came in on (null = legacy .env account or simulator without one). */
  providerId?: string | null;
  timeZone: string;
  inboundId: string;
  trackingNumber: string;
  recordCalls: boolean;
  /** Spoken before recording; null = record without a notice. */
  recordingNotice?: string | null;
  startedAt: string;
  candidates: Candidate[];
  /** Buyers/targets that already talked to this caller in the duplicate window, newest first. */
  seen: string[];
  next: number;
  fallback: string | null;
  usingFallback: boolean;
  outboundId?: string;
  currentRouteId?: string;
  /** Counted against the account's concurrent-call limit (released when the call ends). */
  accountLine?: boolean;
  /** Cap scopes counted for the current dial: route id, "t:<target>", "b:<buyer>". */
  reservedScopes?: string[];
  reservedAt?: string;
  bridged: boolean;
  answeredAt?: string;
  connectedEndedAt?: string;
  /** The agent target being rung / talking (for their softphone). */
  agentTargetId?: string;
  /** For the buyer whisper. */
  campaignName?: string;
  callerNumber?: string;
  callerState?: string | null;
  whisperText?: string | null;
  /** IVR in progress (or finished: path/data stay for the whisper and reports). */
  ivr?: { flow: IvrFlow; node: string; retries: number; steps: number; path: string[]; data: Record<string, string>; choice?: string };
  /**
   * greeting = recording notice; ivr = phone menu; dialing = ringing buyers; whisper = message to the
   * buyer before connecting; closing = "no one available" / goodbye message.
   */
  phase: 'greeting' | 'ivr' | 'dialing' | 'whisper' | 'connected' | 'closing' | 'ended';
}

/**
 * The call router. Every carrier event for a call is processed one at a time (per-call lock):
 *
 *   inbound → checks (number, account, wallet, blocklist) → answer → [recording notice]
 *   → dial best buyer (priority, weight, hours, states, caps) → no answer? next buyer → … → fallback
 *   → buyer answers → bridge + record → hangup → duration, conversion, payout, usage charge, postback
 */
@Injectable()
export class CallEngine {
  private readonly log = new Logger(CallEngine.name);

  constructor(
    @Inject(CALL_CONTROLS) private controls: SharedCallControls,
    private providers: ProvidersService,
    private spam: SpamService,
    private agents: AgentsService,
    @Inject(REDIS) private redis: Redis,
    private caps: CapsService,
    private wallet: WalletService,
    private postbacks: PostbackService,
    private notifications: NotificationsService,
    private recordings: RecordingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  /** `viaProviderId`: the carrier account whose webhook URL received the event (if known). */
  async onInbound(provider: ProviderName, ev: InboundEvent, viaProviderId?: string): Promise<string | null> {
    if (await this.redis.get(legKey(ev.callControlId))) return null; // duplicate webhook

    const number = await prisma.phoneNumber.findFirst({
      where: { e164: ev.to, status: NumberStatus.ACTIVE },
      include: {
        tenant: { include: { plan: true } },
        campaign: { include: { routes: { where: { active: true }, include: { buyer: true, target: { include: { buyer: true, agent: true } } } } } },
      },
    });
    const carrier = await this.providers.byId(number?.providerId ?? viaProviderId);
    const cc = await this.controlFor(provider, carrier);
    if (!number) {
      this.log.warn(`Inbound call to unknown number ${ev.to}, rejecting`);
      await cc.reject(ev.callControlId).catch(() => {});
      return null;
    }

    const { tenant, campaign } = number;
    const call = await prisma.call.create({
      data: {
        tenantId: tenant.id,
        campaignId: campaign?.id,
        phoneNumberId: number.id,
        publisherId: number.publisherId,
        telnyxCallId: ev.callControlId,
        provider,
        providerId: carrier?.id,
        callerNumber: ev.from,
        attestation: ev.attestation?.toUpperCase().slice(0, 1) || null,
        callerState: stateForNumber(ev.from),
        dialedNumber: ev.to,
        startedAt: ev.at,
      },
    });
    await this.redis.set(legKey(ev.callControlId), call.id, 'EX', STATE_TTL);

    // --- Hard rejections (caller hears nothing billable) ---
    const blocked = await prisma.blockedNumber.findUnique({ where: { tenantId_e164: { tenantId: tenant.id, e164: ev.from } } });
    let reason: string | null =
      carrier?.status === 'DISABLED' ? 'carrier_disabled'
      : tenant.status === TenantStatus.SUSPENDED || tenant.status === TenantStatus.CLOSED ? 'account_suspended'
      : tenant.walletBalance.lte(0) ? 'no_balance'
      : !campaign ? 'number_not_assigned'
      : !campaign.active ? 'campaign_paused'
      : blocked ? 'blocked_caller'
      : null;

    // --- Spam protection: platform blocklist, hidden IDs, prefixes, caller rate, STIR/SHAKEN, spam score ---
    if (!reason && campaign) {
      const verdict = await this.spam.screen({ tenantId: tenant.id, campaign, callId: call.id, from: ev.from, attestation: ev.attestation, at: ev.at });
      reason = verdict.reason;
      if (verdict.score !== undefined || verdict.lineType !== undefined) {
        await prisma.call.update({ where: { id: call.id }, data: { spamScore: verdict.score ?? null, lineType: verdict.lineType ?? null } });
      }
    }
    if (reason) {
      await prisma.call.update({ where: { id: call.id }, data: { status: CallStatus.REJECTED, rejectReason: reason, endedAt: ev.at } });
      await cc.reject(ev.callControlId).catch((e) => this.log.warn(`reject failed: ${e.message}`));
      if (reason === 'no_balance') await this.notifications.checkLowBalance(tenant.id);
      return call.id;
    }

    // --- Account-wide concurrent call limit (set by the platform admin) ---
    let accountLine = false;
    if (tenant.maxConcurrentCalls) {
      const none = { hourlyCap: null, dailyCap: null, monthlyCap: null };
      if (await this.caps.reserve(accountScope(tenant.id), { concurrencyCap: tenant.maxConcurrentCalls, ...none }, tenant.timezone, ev.at)) {
        await prisma.call.update({ where: { id: call.id }, data: { status: CallStatus.REJECTED, rejectReason: 'account_limit', endedAt: ev.at } });
        await cc.reject(ev.callControlId).catch((e) => this.log.warn(`reject failed: ${e.message}`));
        return call.id;
      }
      accountLine = true;
    }

    // --- Repeat caller: the publisher isn't paid again; a buyer only pays once per caller ---
    const history =
      campaign!.duplicateWindowSec > 0
        ? await prisma.call.findMany({
            where: {
              tenantId: tenant.id,
              campaignId: campaign!.id,
              callerNumber: ev.from,
              id: { not: call.id },
              startedAt: { gte: new Date(ev.at.getTime() - campaign!.duplicateWindowSec * 1000) },
            },
            select: { buyerId: true, targetId: true, answeredAt: true },
            orderBy: { startedAt: 'desc' },
            take: 100,
          })
        : [];
    const duplicate = history.length > 0;
    const seen = [...new Set(history.filter((h) => h.answeredAt).map(ownerKey).filter((k): k is string => !!k))];
    if (duplicate) await prisma.call.update({ where: { id: call.id }, data: { duplicate: true } });

    // --- Eligible buyers, best first ---
    const callerState = stateForNumber(ev.from);
    const eligible = campaign!.routes.filter((r) => {
      const owner = r.target ? r.target.buyer : r.buyer;
      if (r.target ? !r.target.active : !r.buyer) return false;
      if (owner && !owner.active) return false;
      return isOpen(r.schedule as Schedule | null, ev.at, tenant.timezone) && geoAllows(r.geoRules as GeoRules | null, callerState);
    });
    // Agents ring only while Available, on a carrier that can reach their softphone.
    const agentRoutes = eligible.filter((r) => r.target?.destinationType === 'AGENT' && r.target.agent);
    const online = await this.agents.available(agentRoutes.map((r) => r.target!.id));
    const agentAddress = new Map<string, string>();
    for (const r of agentRoutes) {
      if (!online.has(r.target!.id)) continue;
      const address = await this.agents.addressFor(r.target!.agent!, provider, carrier);
      if (address) agentAddress.set(r.target!.id, address);
    }
    const reachable = eligible.filter((r) => r.target?.destinationType !== 'AGENT' || agentAddress.has(r.target.id));
    const ordered: Candidate[] = orderByPriorityAndWeight(reachable).map((r) => {
      const owner = r.target ? r.target.buyer : r.buyer;
      return {
        routeId: r.id,
        buyerId: owner?.id ?? null,
        targetId: r.targetId,
        buyerName: r.target ? (owner ? `${owner.name} · ${r.target.name}` : r.target.name) : r.buyer!.name,
        destination: (r.target && agentAddress.get(r.target.id)) ?? r.target?.destination ?? r.buyer!.destination,
        agentTargetId: r.target?.destinationType === 'AGENT' ? r.target.id : undefined,
        ringTimeoutSec: r.target?.ringTimeoutSec ?? r.buyer!.ringTimeoutSec,
        limits: limitsOf(r),
        targetName: r.target?.name ?? null,
        targetLimits: r.target ? limitsOf(r.target) : null,
        ownerName: owner?.name ?? null,
        buyerLimits: owner ? limitsOf(owner) : null,
      };
    });
    const candidates = orderForRepeat(ordered, seen, campaign!.repeatRouting);

    const state: CallState = {
      callId: call.id,
      tenantId: tenant.id,
      provider,
      providerId: carrier?.id ?? null,
      timeZone: tenant.timezone,
      inboundId: ev.callControlId,
      trackingNumber: ev.to,
      recordCalls: campaign!.recordCalls,
      recordingNotice: campaign!.recordCalls && campaign!.playRecordingNotice ? campaign!.recordingNotice?.trim() || RECORDING_NOTICE : null,
      startedAt: ev.at.toISOString(),
      candidates,
      seen,
      accountLine,
      next: 0,
      fallback: campaign!.fallbackNumber,
      usingFallback: false,
      bridged: false,
      phase: 'greeting',
      campaignName: campaign!.name,
      callerNumber: ev.from,
      callerState,
      whisperText: campaign!.whisperText,
      ...(ivrFlow(campaign!.ivr) ? { ivr: { flow: ivrFlow(campaign!.ivr)!, node: ivrFlow(campaign!.ivr)!.start, retries: 0, steps: 0, path: [], data: {} } } : {}),
    };

    await this.withLock(call.id, async () => {
      await cc.answer(ev.callControlId);
      if (state.recordingNotice) {
        await cc.speak(ev.callControlId, state.recordingNotice); // dial when it finishes
        await this.save(state);
      } else {
        await this.afterGreeting(state);
      }
    });
    return call.id;
  }

  async onSpeakEnded(ev: LegEvent) {
    await this.withState(ev.callControlId, async (s) => {
      if (s.phase === 'greeting') await this.afterGreeting(s);
      else if (s.phase === 'ivr' && ev.callControlId === s.inboundId) {
        const node = s.ivr?.flow.nodes.find((n) => n.id === s.ivr!.node);
        if (node?.type === 'say') await this.ivrAction(s, node.next);
      } else if (s.phase === 'whisper' && ev.callControlId === s.outboundId) await this.connect(s, ev.at);
      else if (s.phase === 'closing') await (await this.cc(s)).hangup(s.inboundId);
    });
  }

  /** Keypad digits from an IVR prompt. */
  async onGathered(ev: GatherEvent) {
    await this.withState(ev.callControlId, async (s) => {
      if (s.phase !== 'ivr' || ev.callControlId !== s.inboundId || !s.ivr) return;
      const node = s.ivr.flow.nodes.find((n) => n.id === s.ivr!.node);
      if (!node || node.type === 'say') return;
      const digits = (ev.digits ?? '').replace(/[^0-9*#]/g, '').replace(/#$/, '');
      if (node.type === 'menu') {
        const opt = node.options.find((o) => o.digit === digits[0]);
        if (opt) {
          s.ivr.path.push(`${node.name}: ${opt.label}`);
          s.ivr.retries = 0;
          return this.ivrAction(s, opt.action, opt.label);
        }
      } else if (digits.length >= node.minDigits && digits.length <= node.maxDigits) {
        s.ivr.data[node.variable] = digits;
        s.ivr.path.push(`${node.name}: entered`);
        s.ivr.retries = 0;
        return this.ivrAction(s, node.next);
      }
      // Nothing, or a wrong key: ask again, then give up with the fallback.
      if (s.ivr.retries < (node.retries ?? 2)) {
        s.ivr.retries++;
        return this.runIvrNode(s, node.id);
      }
      s.ivr.retries = 0;
      s.ivr.path.push(`${node.name}: no answer`);
      return this.ivrAction(s, node.fallback);
    });
  }

  /** Softphone buttons for an agent's leg. Simulated calls are driven here; real ones also accept hang up. */
  async agentAction(legId: string, action: 'answer' | 'decline' | 'hangup'): Promise<boolean> {
    const callId = await this.redis.get(legKey(legId));
    const raw = callId ? await this.redis.get(stateKey(callId)) : null;
    if (!raw) return false;
    const s = JSON.parse(raw) as CallState;
    if (s.outboundId !== legId) return false;
    if (s.provider === 'simulator') {
      if (action === 'answer') this.controls.simulator.agentAnswer(legId);
      else this.controls.simulator.agentEnd(legId, action === 'decline' ? 'busy' : 'normal_clearing');
      return true;
    }
    if (action === 'answer') return false; // real calls are answered in the carrier's SDK
    await (await this.cc(s)).hangup(legId);
    return true;
  }

  /** Is this carrier leg the caller or a buyer? (Markup carriers need it to answer webhooks.) */
  async legRole(callControlId: string): Promise<'caller' | 'buyer' | null> {
    const callId = await this.redis.get(legKey(callControlId));
    const raw = callId ? await this.redis.get(stateKey(callId)) : null;
    if (!raw) return null;
    return (JSON.parse(raw) as CallState).inboundId === callControlId ? 'caller' : 'buyer';
  }

  async onAnswered(ev: LegEvent) {
    await this.withState(ev.callControlId, async (s) => {
      if (ev.callControlId !== s.outboundId || s.bridged || s.phase === 'ended' || s.phase === 'whisper') return;
      // Buyer whisper first ("Auto insurance call from Florida"), then connect.
      if (s.whisperText && !s.usingFallback) {
        s.phase = 'whisper';
        await this.save(s);
        const text = fillWhisper(s.whisperText, { campaign: s.campaignName, caller: s.callerNumber ?? '', state: s.callerState, choice: s.ivr?.choice, data: s.ivr?.data });
        await (await this.cc(s)).speak(s.outboundId, text);
        return;
      }
      await this.connect(s, ev.at);
    });
  }

  /** Bridges the caller to the buyer who answered. */
  private async connect(s: CallState, at: Date) {
    if (!s.outboundId || s.bridged) return;
    const cc = await this.cc(s);
    await cc.bridge(s.inboundId, s.outboundId);
    s.bridged = true;
    s.answeredAt = at.toISOString();
    s.phase = 'connected';
    await this.save(s);
    if (s.agentTargetId) await this.agents.markActive(s.agentTargetId, s.outboundId);
    if (s.recordCalls) await cc.recordStart(s.inboundId).catch((e) => this.log.warn(`record_start: ${e.message}`));
    await prisma.call.update({ where: { id: s.callId }, data: { status: CallStatus.IN_PROGRESS, answeredAt: at } });
  }

  // ---------------------------------------------------------------------------
  // IVR
  // ---------------------------------------------------------------------------

  /** After the recording notice: the phone menu if the campaign has one, else straight to buyers. */
  private async afterGreeting(s: CallState) {
    if (s.ivr) await this.runIvrNode(s, s.ivr.node);
    else await this.dialNext(s);
  }

  private async runIvrNode(s: CallState, nodeId: string): Promise<void> {
    const ivr = s.ivr!;
    const node = ivr.flow.nodes.find((n) => n.id === nodeId);
    if (!node || ++ivr.steps > IVR_MAX_STEPS) return this.ivrAction(s, { type: 'hangup' });
    ivr.node = node.id;
    s.phase = 'ivr';
    await this.save(s);
    const cc = await this.cc(s);
    if (node.type === 'say') return cc.speak(s.inboundId, node.text);
    const prompt = ivr.retries > 0 && node.invalidPrompt ? `${node.invalidPrompt} ${node.prompt}` : node.prompt;
    await cc.gather(s.inboundId, {
      prompt,
      minDigits: node.type === 'menu' ? 1 : node.minDigits,
      maxDigits: node.type === 'menu' ? 1 : node.maxDigits,
      timeoutSec: node.timeoutSec ?? (node.type === 'menu' ? 6 : 10),
    });
  }

  private async ivrAction(s: CallState, action: IvrAction, choice?: string): Promise<void> {
    const ivr = s.ivr!;
    if (choice) ivr.choice = choice;
    await prisma.call.update({ where: { id: s.callId }, data: { ivrPath: ivr.path.join(' > ').slice(0, 1000) || null, ivrData: ivr.data } });
    if (action.type === 'goto') {
      ivr.retries = 0;
      return this.runIvrNode(s, action.node);
    }
    if (action.type === 'route') {
      const buyers = action.buyerIds ?? [];
      const targets = action.targetIds ?? [];
      if (buyers.length || targets.length) {
        s.candidates = s.candidates.filter((c) => (c.targetId && targets.includes(c.targetId)) || (c.buyerId && buyers.includes(c.buyerId)));
      }
      return this.dialNext(s);
    }
    // Hang up, with a goodbye message if there is one.
    s.phase = 'closing';
    await this.save(s);
    const cc = await this.cc(s);
    if (action.message) await cc.speak(s.inboundId, action.message);
    else await cc.hangup(s.inboundId);
  }

  async onHangup(ev: HangupEvent) {
    await this.withState(ev.callControlId, async (s) => {
      if (s.phase === 'ended') return;
      const cc = await this.cc(s);

      if (ev.callControlId === s.inboundId) {
        // Caller hung up.
        if (s.outboundId) {
          if (!s.bridged) await this.releaseReservation(s);
          await cc.hangup(s.outboundId);
        }
        await this.finalize(s, ev);
        return;
      }

      if (ev.callControlId === s.outboundId) {
        if (s.bridged) {
          // Buyer hung up after talking: end the caller's leg; finalize on its hangup event.
          s.connectedEndedAt = ev.at.toISOString();
          await this.save(s);
          await cc.hangup(s.inboundId);
        } else {
          // Buyer didn't pick up (timeout, busy, rejected): try the next one.
          await this.releaseReservation(s);
          s.outboundId = undefined;
          await this.dialNext(s);
        }
      }
    });
  }

  async onRecordingSaved(ev: RecordingEvent) {
    const callId = await this.redis.get(legKey(ev.callControlId));
    if (!callId) return;
    const call = await prisma.call.findUnique({ where: { id: callId }, select: { tenantId: true } });
    if (!call) return;
    const ext = ev.contentType.includes('wav') ? 'wav' : 'mp3';
    const key = `recordings/${call.tenantId}/${callId}.${ext}`;
    // Audio we already hold is stored now; a carrier link is copied by a worker so this webhook returns fast.
    if (ev.audio) await this.recordings.saveAudio(callId, key, ev.audio);
    else if (ev.url) await this.recordings.enqueueDownload({ callId, key, url: ev.url, headers: ev.headers });
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  private async dialNext(s: CallState) {
    const cc = await this.cc(s);
    s.phase = 'dialing';

    while (s.next < s.candidates.length) {
      const c = s.candidates[s.next++];
      const now = new Date();
      // Campaign route caps, then the target's and the buyer's caps shared by every campaign.
      const scopes = [
        { key: c.routeId, limits: c.limits, name: c.buyerName, where: 'on this campaign' },
        ...(c.targetId && c.targetLimits ? [{ key: `t:${c.targetId}`, limits: c.targetLimits, name: c.targetName!, where: 'across all campaigns' }] : []),
        ...(c.buyerId && c.buyerLimits ? [{ key: `b:${c.buyerId}`, limits: c.buyerLimits, name: c.ownerName!, where: 'across all campaigns' }] : []),
      ];
      const taken: string[] = [];
      let blocked = false;
      for (const sc of scopes) {
        const full = await this.caps.reserve(sc.key, sc.limits, s.timeZone, now);
        if (full) {
          if (full !== 'concurrency') await this.notifyCapReached(s, sc.key, sc.name, sc.where, full);
          blocked = true;
          break;
        }
        taken.push(sc.key);
      }
      if (blocked) {
        for (const k of taken) await this.caps.releaseAll(k, s.timeZone, now);
        continue;
      }
      try {
        s.outboundId = await cc.dial({ linkTo: s.inboundId, to: c.destination, from: s.trackingNumber, timeoutSec: c.ringTimeoutSec });
      } catch (e) {
        this.log.warn(`Dial to ${c.buyerName} failed: ${(e as Error).message}`);
        for (const k of taken) await this.caps.releaseAll(k, s.timeZone, now);
        continue;
      }
      s.currentRouteId = c.routeId;
      s.reservedScopes = taken;
      s.agentTargetId = c.agentTargetId;
      if (c.agentTargetId) {
        await this.agents.trackLeg(c.agentTargetId, {
          legId: s.outboundId,
          callId: s.callId,
          caller: s.callerNumber ?? '',
          callerState: s.callerState ?? null,
          campaign: s.campaignName ?? null,
          ivrPath: s.ivr?.path.join(' > ') || null,
          state: 'ringing',
          since: new Date().toISOString(),
          simulated: s.provider === 'simulator',
        });
      }
      s.reservedAt = now.toISOString();
      await this.redis.set(legKey(s.outboundId), s.callId, 'EX', STATE_TTL);
      await this.save(s);
      await prisma.call.update({
        where: { id: s.callId },
        data: { attempts: { increment: 1 }, buyerId: c.buyerId, targetId: c.targetId, routeId: c.routeId, outboundCallId: s.outboundId },
      });
      return;
    }

    // Every buyer tried: last resort is the campaign's fallback number.
    if (s.fallback && !s.usingFallback) {
      s.usingFallback = true;
      s.currentRouteId = undefined;
      s.reservedScopes = [];
      try {
        s.outboundId = await cc.dial({ linkTo: s.inboundId, to: s.fallback, from: s.trackingNumber, timeoutSec: 30 });
        await this.redis.set(legKey(s.outboundId), s.callId, 'EX', STATE_TTL);
        await this.save(s);
        await prisma.call.update({
          where: { id: s.callId },
          data: { attempts: { increment: 1 }, buyerId: null, targetId: null, routeId: null, outboundCallId: s.outboundId },
        });
        return;
      } catch (e) {
        this.log.warn(`Fallback dial failed: ${(e as Error).message}`);
      }
    }

    // Nobody can take it.
    s.phase = 'closing';
    s.outboundId = undefined;
    await this.save(s);
    await prisma.call.update({ where: { id: s.callId }, data: { rejectReason: 'no_buyer_available' } });
    await cc.speak(s.inboundId, NO_AGENT_MESSAGE);
  }

  private async releaseReservation(s: CallState) {
    if (s.agentTargetId && s.outboundId) await this.agents.dropLeg(s.agentTargetId, s.outboundId);
    if (s.currentRouteId && s.reservedAt && !s.usingFallback) {
      for (const k of scopesOf(s)) await this.caps.releaseAll(k, s.timeZone, new Date(s.reservedAt));
    }
  }

  // ---------------------------------------------------------------------------
  // Finishing a call: duration, conversion, money
  // ---------------------------------------------------------------------------

  private async finalize(s: CallState, ev: HangupEvent) {
    s.phase = 'ended';
    await this.save(s);
    if (s.accountLine) await this.caps.releaseConcurrency(accountScope(s.tenantId));
    if (s.agentTargetId && s.outboundId) await this.agents.dropLeg(s.agentTargetId, s.outboundId);
    if (s.bridged && s.currentRouteId && !s.usingFallback) {
      for (const k of scopesOf(s)) await this.caps.releaseConcurrency(k);
    }

    const call = await prisma.call.findUniqueOrThrow({
      where: { id: s.callId },
      include: { campaign: true, publisher: true, route: true, tenant: { include: { plan: true } }, phoneNumber: true, carrier: true },
    });

    const endAt = ev.at;
    const durationSec = Math.max(0, Math.round((endAt.getTime() - new Date(s.startedAt).getTime()) / 1000));
    const connectedEnd = s.connectedEndedAt ? new Date(s.connectedEndedAt) : endAt;
    const connectedSec = s.bridged && s.answeredAt ? Math.max(0, Math.round((connectedEnd.getTime() - new Date(s.answeredAt).getTime()) / 1000)) : 0;

    // A buyer pays once per caller: a repeat caller is a new sale only for a buyer/target that hasn't had them.
    // The publisher is paid once per caller, whoever takes the repeat call.
    const soldToBuyer = s.bridged && !s.usingFallback;
    const alreadyHad = (s.seen ?? []).includes(ownerKey(call) ?? '');
    const converted = soldToBuyer && !alreadyHad && !!call.campaign && connectedSec >= call.campaign.convertAfterSeconds;
    const revenue = converted ? call.route?.revenueOverride ?? call.campaign!.revenue : new Prisma.Decimal(0);
    const payout = converted && !call.duplicate && call.publisher ? call.publisher.payoutOverride ?? call.campaign!.payout : new Prisma.Decimal(0);

    // Usage: caller leg + buyer leg, each rounded up to the minute.
    const minutes = Math.ceil(durationSec / 60) + Math.ceil(connectedSec / 60);
    const rate = call.tenant.perMinuteRate ?? call.tenant.plan?.perMinuteRate ?? new Prisma.Decimal(DEFAULT_PER_MINUTE);
    const cost = rate.mul(minutes);
    // What the carrier charges us: the caller's leg inbound, the buyer's leg outbound.
    const carrierCost = call.carrier
      ? call.carrier.inboundPerMinute.mul(Math.ceil(durationSec / 60)).add(call.carrier.outboundPerMinute.mul(Math.ceil(connectedSec / 60)))
      : new Prisma.Decimal(0);

    // The call's result and its usage charge are saved together: a finished call is always billed.
    await prisma.$transaction(async (tx) => {
      await tx.call.update({
        where: { id: call.id },
        data: {
          status: s.bridged ? CallStatus.COMPLETED : CallStatus.NO_ANSWER,
          durationSec,
          connectedSec,
          converted,
          revenue,
          payout,
          cost,
          carrierCost,
          hangupCause: ev.cause,
          endedAt: endAt,
          ...(s.usingFallback && s.bridged ? { rejectReason: 'sent_to_fallback' } : {}),
        },
      });
      if (cost.gt(0)) {
        await this.wallet.charge(call.tenantId, cost, TransactionType.CALL_USAGE, `Call from ${call.callerNumber} (${minutes} min)`, call.id, tx);
      }
    });
    if (cost.gt(0)) await this.notifications.checkLowBalance(call.tenantId);
    await this.spam.afterCall({ tenantId: call.tenantId, campaign: call.campaign, callerNumber: call.callerNumber, durationSec, converted }).catch((e) => this.log.warn(`auto-block: ${(e as Error).message}`));

    if (payout.gt(0) && call.publisher?.postbackUrl) {
      const url = fillMacros(call.publisher.postbackUrl, {
        call_id: call.id,
        caller: call.callerNumber,
        duration: durationSec,
        connected: connectedSec,
        payout: payout.toFixed(2),
        revenue: revenue.toFixed(2),
        converted: 1,
        campaign: call.campaign!.name,
        campaign_id: call.campaign!.id,
        publisher: call.publisher.name,
        publisher_id: call.publisher.id,
        tracking_number: call.dialedNumber ?? '',
        ivr_path: call.ivrPath ?? '',
        ...Object.fromEntries(Object.entries((call.ivrData ?? {}) as Record<string, string>).map(([k, v]) => [`ivr_${k}`, v])),
      });
      await this.postbacks.send(call.tenantId, call.id, url);
    }
  }

  private async notifyCapReached(s: CallState, scope: string, name: string, where: string, cap: string) {
    const period = new Date().toISOString().slice(0, cap === 'hourly' ? 13 : cap === 'daily' ? 10 : 7);
    await this.notifications.notify(s.tenantId, {
      type: 'cap_reached',
      title: `${name} reached its ${cap} cap ${where}`,
      body: 'Calls are going to the next buyer or target until the cap resets.',
      link: scope.startsWith('t:') ? '/targets' : scope.startsWith('b:') ? '/buyers' : '/campaigns',
      dedupeKey: `cap:${scope}:${cap}:${period}`,
      dedupeSec: 32 * 86400,
    });
  }

  // ---------------------------------------------------------------------------
  // State & locking
  // ---------------------------------------------------------------------------

  private async cc(s: CallState): Promise<CallControl> {
    return this.controlFor(s.provider, await this.providers.byId(s.providerId));
  }

  /** The simulator for simulated calls; otherwise the carrier account's own client (Telnyx or Custom API). */
  private async controlFor(provider: ProviderName, carrier: Awaited<ReturnType<ProvidersService['byId']>>): Promise<CallControl> {
    return provider === 'simulator' ? this.controls.simulator : this.providers.callControl(carrier);
  }

  private async save(s: CallState) {
    await this.redis.set(stateKey(s.callId), JSON.stringify(s), 'EX', STATE_TTL);
  }

  private async withState(callControlId: string, fn: (s: CallState) => Promise<void>) {
    const callId = await this.redis.get(legKey(callControlId));
    if (!callId) return;
    await this.withLock(callId, async () => {
      const raw = await this.redis.get(stateKey(callId));
      if (raw) await fn(JSON.parse(raw) as CallState);
    });
  }

  /** Carrier events for one call can arrive at the same time; handle them one by one. */
  private async withLock(callId: string, fn: () => Promise<void>) {
    const key = `lock:call:${callId}`;
    const token = Math.random().toString(36).slice(2);
    const deadline = Date.now() + 10_000;
    while (!(await this.redis.set(key, token, 'PX', 15_000, 'NX'))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock on call ${callId}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    try {
      await fn();
    } catch (e) {
      this.log.error(`Call ${callId}: ${(e as Error).message}`, (e as Error).stack);
    } finally {
      if ((await this.redis.get(key)) === token) await this.redis.del(key);
    }
  }
}

const legKey = (callControlId: string) => `leg:${callControlId}`;
const accountScope = (tenantId: string) => `acct:${tenantId}`;
/** Scopes to release; older call states only had the route. */
/** A campaign's IVR, when it's switched on. */
const ivrFlow = (v: unknown): IvrFlow | null => {
  const f = v as IvrFlow | null;
  return f && f.enabled && Array.isArray(f.nodes) && f.nodes.length ? f : null;
};
const scopesOf = (s: CallState) => s.reservedScopes ?? (s.currentRouteId ? [s.currentRouteId] : []);
const stateKey = (callId: string) => `callstate:${callId}`;
