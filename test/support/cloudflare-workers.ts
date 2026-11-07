// Minimal Node stand-in for `cloudflare:workers` (see vitest.config.ts).
export class RpcTarget {}

export class WorkerEntrypoint<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
