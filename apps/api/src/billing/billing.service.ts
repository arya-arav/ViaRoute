import { BadRequestException, Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import Stripe from 'stripe';
import { NumberStatus, Prisma, prisma, Role, TenantStatus, TransactionType, type Tenant } from '@viaroute/db';
import { REDIS } from '../common/redis.module';
import { config, portalOrigin, runsJobs } from '../config';
import { NotificationsService } from '../notifications/notifications.service';
import { InsufficientFundsError, WalletService } from './wallet.service';

const RENEW_EVERY_MS = 10 * 60_000;

export function addMonth(d: Date) {
  const n = new Date(d);
  n.setUTCMonth(n.getUTCMonth() + 1);
  return n;
}

@Injectable()
export class BillingService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(BillingService.name);
  readonly stripe: Stripe | null = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;
  private timer?: NodeJS.Timeout;

  constructor(
    private wallet: WalletService,
    private notifications: NotificationsService,
    @Inject(REDIS) private redis: Redis,
  ) {}

  get testMode() {
    return !this.stripe;
  }

  onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test') return; // tests call runRenewals() directly
    if (!runsJobs) return; // workers run renewals
    this.timer = setInterval(() => this.runRenewals().catch((e) => this.log.error(e.message)), RENEW_EVERY_MS);
    this.timer.unref();
    void this.runRenewals().catch((e) => this.log.error(e.message));
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // ---------------------------------------------------------------------------
  // Top-ups
  // ---------------------------------------------------------------------------

  /** Starts a Stripe Checkout payment, or credits instantly in test mode. */
  async startTopup(tenant: Tenant, amount: number): Promise<{ url?: string; credited?: boolean }> {
    if (!this.stripe) {
      await this.creditTopup(tenant.id, amount, `test_${Date.now()}_${Math.random().toString(36).slice(2)}`, 'Test-mode top-up');
      return { credited: true };
    }
    const origin = portalOrigin(tenant);
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: { currency: 'usd', unit_amount: Math.round(amount * 100), product_data: { name: `Wallet top-up — ${tenant.name}` } },
        },
      ],
      metadata: { tenantId: tenant.id, purpose: 'wallet_topup' },
      success_url: `${origin}/billing?topup=success`,
      cancel_url: `${origin}/billing?topup=cancelled`,
    });
    return { url: session.url ?? undefined };
  }

  /** Stripe webhook: verifies the signature, then credits paid top-ups (idempotent per session). */
  async handleStripeWebhook(raw: Buffer | undefined, signature: string | undefined) {
    if (!this.stripe || !config.stripeWebhookSecret) throw new BadRequestException('Stripe is not configured');
    if (!raw || !signature) throw new BadRequestException('Missing signature');
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(raw, signature, config.stripeWebhookSecret);
    } catch {
      throw new BadRequestException('Invalid signature');
    }
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const s = event.data.object as Stripe.Checkout.Session;
      if (s.payment_status === 'paid' && s.metadata?.purpose === 'wallet_topup' && s.metadata.tenantId && s.amount_total) {
        await this.creditTopup(s.metadata.tenantId, s.amount_total / 100, s.id, 'Card payment');
      }
    }
    return { received: true };
  }

  private async creditTopup(tenantId: string, amount: number, ref: string, description: string) {
    try {
      await this.wallet.credit(tenantId, amount, TransactionType.TOPUP, `${description} ($${amount.toFixed(2)})`, ref);
    } catch (e) {
      // Same Stripe session delivered twice: already credited.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return;
      throw e;
    }
    await this.notifications.notify(tenantId, { type: 'payment', title: `$${amount.toFixed(2)} added to your wallet`, body: description, link: '/billing', email: true });
    // A suspended account that can now pay is renewed right away.
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    // (Not when the platform admin suspended it: that has a reason and only the admin lifts it.)
    if (t?.status === TenantStatus.SUSPENDED && !t.suspendReason && t.billingRenewsAt && t.billingRenewsAt <= new Date()) await this.renew(t);
  }

  // ---------------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------------

  /** Plan changes apply now; the new price is charged at the next renewal. */
  async changePlan(tenant: Tenant, code: string) {
    const plan = await prisma.plan.findUnique({ where: { code } });
    if (!plan || !plan.active) throw new BadRequestException('Plan not found');
    if (plan.id === tenant.planId) return plan;
    const staff = await prisma.user.count({ where: { tenantId: tenant.id, role: { in: [Role.TENANT_ADMIN, Role.MANAGER] } } });
    if (plan.maxUsers !== null && staff > plan.maxUsers) {
      throw new BadRequestException(`The ${plan.name} plan allows ${plan.maxUsers} users and you have ${staff}. Remove team members first.`);
    }
    await prisma.tenant.update({ where: { id: tenant.id }, data: { planId: plan.id } });
    await prisma.auditLog.create({ data: { tenantId: tenant.id, action: 'billing.plan_change', meta: { plan: code } } });
    return plan;
  }

  // ---------------------------------------------------------------------------
  // Monthly renewals (subscription + number rental, paid from the wallet)
  // ---------------------------------------------------------------------------

  /** Renews every account that is due. Safe to run from several servers (Redis lock). */
  async runRenewals() {
    const lock = await this.redis.set('lock:billing:renewals', '1', 'EX', 300, 'NX');
    if (!lock) return 0;
    try {
      const now = new Date();
      // Accounts from before billing existed get their dates set, not an immediate charge.
      await prisma.tenant.updateMany({
        where: { status: TenantStatus.TRIAL, trialEndsAt: null },
        data: { trialEndsAt: new Date(now.getTime() + config.trialDays * 86400_000) },
      });
      await prisma.tenant.updateMany({
        where: { status: TenantStatus.ACTIVE, billingRenewsAt: null },
        data: { billingRenewsAt: addMonth(now) },
      });
      const due = await prisma.tenant.findMany({
        where: {
          OR: [
            { status: TenantStatus.TRIAL, trialEndsAt: { lte: now } },
            { status: TenantStatus.ACTIVE, billingRenewsAt: { lte: now } },
          ],
        },
      });
      for (const t of due) await this.renew(t).catch((e) => this.log.error(`Renewal of ${t.subdomain} failed: ${e.message}`));
      return due.length;
    } finally {
      await this.redis.del('lock:billing:renewals');
    }
  }

  /** Charges one month. On success the account is (re)activated; if the wallet is short it is suspended. */
  async renew(t: Tenant) {
    const plan = t.planId ? await prisma.plan.findUnique({ where: { id: t.planId } }) : null;
    const numbers = await prisma.phoneNumber.findMany({
      where: { tenantId: t.id, status: { in: [NumberStatus.ACTIVE, NumberStatus.PENDING] } },
      select: { monthlyPrice: true },
    });
    const planPrice = plan?.monthlyPrice ?? new Prisma.Decimal(0);
    const rental = numbers.reduce((sum, n) => sum.add(n.monthlyPrice), new Prisma.Decimal(0));
    const total = planPrice.add(rental);
    const nextDate = addMonth(t.status === TenantStatus.ACTIVE && t.billingRenewsAt ? t.billingRenewsAt : new Date());

    try {
      await prisma.$transaction(async (tx) => {
        if (planPrice.gt(0)) await this.wallet.debit(t.id, planPrice, TransactionType.SUBSCRIPTION, `${plan!.name} plan — monthly`, tx);
        if (rental.gt(0)) await this.wallet.debit(t.id, rental, TransactionType.NUMBER_RENTAL, `Number rental — ${numbers.length} number(s)`, tx);
        await tx.tenant.update({ where: { id: t.id }, data: { status: TenantStatus.ACTIVE, billingRenewsAt: nextDate } });
      });
    } catch (e) {
      if (!(e instanceof InsufficientFundsError)) throw e;
      if (t.status !== TenantStatus.SUSPENDED) {
        await prisma.tenant.update({ where: { id: t.id }, data: { status: TenantStatus.SUSPENDED, billingRenewsAt: t.billingRenewsAt ?? new Date() } });
        await this.notifications.notify(t.id, {
          type: 'suspended',
          title: 'Payment needed — your account is paused',
          body: `Your monthly charge of $${total.toFixed(2)} couldn't be taken from your wallet. Add funds to reactivate; calls are paused until then.`,
          link: '/billing',
          email: true,
        });
      }
      return false;
    }

    if (t.status === TenantStatus.SUSPENDED) {
      await this.notifications.notify(t.id, { type: 'payment', title: 'Your account is active again', link: '/billing' });
    }
    await this.notifications.checkLowBalance(t.id);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Overview & statements
  // ---------------------------------------------------------------------------

  async overview(tenant: Tenant) {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id }, include: { plan: true } });
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const [plans, usage, numbers] = await Promise.all([
      prisma.plan.findMany({ where: { active: true }, orderBy: { monthlyPrice: 'asc' } }),
      prisma.transaction.groupBy({
        by: ['type'],
        where: { tenantId: t.id, createdAt: { gte: monthStart }, amount: { lt: 0 } },
        _sum: { amount: true },
      }),
      prisma.phoneNumber.aggregate({
        where: { tenantId: t.id, status: { in: [NumberStatus.ACTIVE, NumberStatus.PENDING] } },
        _sum: { monthlyPrice: true },
        _count: true,
      }),
    ]);
    return {
      testMode: this.testMode,
      status: t.status,
      walletBalance: t.walletBalance,
      lowBalanceThreshold: t.lowBalanceThreshold,
      trialEndsAt: t.trialEndsAt,
      billingRenewsAt: t.status === TenantStatus.TRIAL ? t.trialEndsAt : t.billingRenewsAt,
      plan: t.plan,
      plans,
      nextCharge: {
        plan: t.plan?.monthlyPrice ?? 0,
        numbers: numbers._sum.monthlyPrice ?? 0,
        numberCount: numbers._count,
      },
      spentThisMonth: Object.fromEntries(usage.map((u) => [u.type, u._sum.amount?.neg() ?? 0])),
    };
  }

  async statement(tenant: Tenant, month: string) {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m) throw new BadRequestException('Month must look like 2026-09');
    const from = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
    const to = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
    const [txs, opening] = await Promise.all([
      prisma.transaction.findMany({ where: { tenantId: tenant.id, createdAt: { gte: from, lt: to } }, orderBy: { createdAt: 'asc' } }),
      prisma.transaction.findFirst({ where: { tenantId: tenant.id, createdAt: { lt: from } }, orderBy: { createdAt: 'desc' } }),
    ]);
    const totals: Record<string, Prisma.Decimal> = {};
    for (const tx of txs) totals[tx.type] = (totals[tx.type] ?? new Prisma.Decimal(0)).add(tx.amount);
    return {
      month,
      tenant: { name: tenant.name, subdomain: tenant.subdomain },
      openingBalance: opening?.balanceAfter ?? 0,
      closingBalance: txs.length ? txs[txs.length - 1].balanceAfter : opening?.balanceAfter ?? 0,
      totals,
      transactions: txs,
    };
  }
}
