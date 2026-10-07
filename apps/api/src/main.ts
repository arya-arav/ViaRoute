import 'reflect-metadata';
import { appRole, config } from './config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createServer } from 'http';
import { AppModule } from './app.module';
import { ensurePlans, ensureSuperAdmin } from './cli/bootstrap-admin';
import { configureApp } from './setup';

/** APP_ROLE=worker: queues and timers only, no web traffic (just /health for Docker and load balancers). */
async function startWorker() {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  const health = createServer((req, res) => {
    const ok = req.url === '/health';
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(ok ? JSON.stringify({ ok: true, role: 'worker', time: new Date().toISOString() }) : '{}');
  });
  health.listen(config.port);
  const close = () => health.close();
  process.once('SIGTERM', close).once('SIGINT', close);
  Logger.log(`⚙️  Worker ready (postbacks, recordings, renewals, clean-up) — health on :${config.port}`, 'Bootstrap');
}

async function bootstrap() {
  if (appRole === 'worker') return startWorker();

  // rawBody: needed to check Telnyx and Stripe webhook signatures.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  configureApp(app);
  app.enableShutdownHooks();

  // Platforms without a terminal (xCloud, Coolify…): create the first admin from the environment.
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    if (ADMIN_PASSWORD.length < 12) Logger.warn('ADMIN_PASSWORD must be 12+ characters; admin not created', 'Bootstrap');
    else {
      await ensurePlans();
      const result = await ensureSuperAdmin(ADMIN_EMAIL, ADMIN_PASSWORD, false);
      if (result === 'created') Logger.log(`Super Admin ${ADMIN_EMAIL} created`, 'Bootstrap');
    }
  }

  await app.listen(config.port);
  Logger.log(
    `🚀 API ready on http://localhost:${config.port} (role: ${appRole}) — main site: ${config.mainHost}, portals: *.${config.rootDomain}`,
    'Bootstrap',
  );
}
bootstrap();
