// Stand-in for @cloudflare/containers so the Worker's own logic can run in Node.
export class Container<Env = unknown> {
  sleepAfter: string | number = '10m';
  envVars: Record<string, string> = {};
  enableInternet = true;
  constructor(public ctx: unknown, public env: Env) {}
  async onActivityExpired() {}
  onError(e: unknown): unknown { throw e; }
}
