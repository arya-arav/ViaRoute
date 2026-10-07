import { Injectable, NestMiddleware, NotFoundException } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { prisma } from '@viaroute/db';
import { config } from '../config';
import type { AppRequest } from './types';

/**
 * Works out which customer portal the request comes from.
 * The web app sends its own host in `X-Tenant-Host` (e.g. "acme.localhost:3000"
 * or "calls.bestleads.com"); falls back to the request's Host header.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  async use(req: AppRequest, _res: Response, next: NextFunction) {
    const raw = (req.header('x-tenant-host') ?? req.header('host') ?? '').toLowerCase();
    const host = raw.split(':')[0];
    req.tenant = null;

    const root = config.rootDomain;
    if (!host || host === config.mainHost || host === root || host === `www.${root}` || host === `app.${root}` || host === `api.${root}`) {
      return next();
    }

    if (host.endsWith(`.${root}`)) {
      const sub = host.slice(0, -(root.length + 1));
      req.tenant = await prisma.tenant.findUnique({ where: { subdomain: sub } });
    } else {
      const t = await prisma.tenant.findUnique({ where: { customDomain: host } });
      req.tenant = t?.customDomainVerifiedAt ? t : null; // unverified domains don't serve a portal
    }

    if (!req.tenant && config.unknownHostIsMainSite) return next();
    if (!req.tenant || req.tenant.status === 'CLOSED') {
      throw new NotFoundException('Portal not found');
    }
    next();
  }
}
