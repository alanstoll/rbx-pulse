/**
 * Request pacing that protects the live game.
 *
 * Roblox's DataStore budget is per universe and shared between game servers and
 * Open Cloud. Two rules apply:
 *   1. Never exceed `maxPerMinute` (a hard ceiling from config).
 *   2. Consume at most `budgetFraction` of the limit reported by the rate-limit
 *      headers, and pause entirely whenever `remaining` falls below the share
 *      reserved for the game, i.e. (1 - budgetFraction) * limit.
 * Without headers, rule 1 alone applies.
 */

export interface RateInfo {
  limit?: number;
  remaining?: number;
  /** Seconds until the window resets. */
  reset?: number;
}

export interface LimiterOptions {
  maxPerMinute: number;
  budgetFraction: number;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimiter {
  private ratePerMinute: number;
  private nextAt = 0;
  private pausedUntil = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly stats = { acquired: 0, pauses: 0, pausedMs: 0 };

  constructor(private readonly opts: LimiterOptions) {
    this.ratePerMinute = opts.maxPerMinute;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Current effective rate, requests per minute. */
  get rate(): number {
    return this.ratePerMinute;
  }

  /** Feed headers from every response. */
  observe(info: RateInfo): void {
    if (info.limit && info.limit > 0) {
      const share = Math.max(1, Math.floor(info.limit * this.opts.budgetFraction));
      this.ratePerMinute = Math.min(this.opts.maxPerMinute, share);
      const reserved = info.limit - share;
      if (info.remaining !== undefined && info.remaining <= reserved) {
        this.pause((info.reset ?? 60) * 1000, 'remaining budget at or below the game reserve');
      }
    }
  }

  /** Hard pause, e.g. after a 429. */
  pause(ms: number, _reason?: string): void {
    const until = this.now() + Math.min(Math.max(ms, 1000), 120_000);
    if (until > this.pausedUntil) {
      this.pausedUntil = until;
      this.stats.pauses++;
    }
  }

  /** Wait until a request may be sent. */
  async acquire(): Promise<void> {
    for (;;) {
      const t = this.now();
      const wait = Math.max(this.pausedUntil, this.nextAt) - t;
      if (wait <= 0) break;
      if (this.pausedUntil > t) this.stats.pausedMs += wait;
      await this.sleep(wait);
    }
    // Drift-free pacing: schedule from the previous slot, not from "now", so timer
    // lag does not accumulate. After idle time, restart from now.
    const interval = 60_000 / this.ratePerMinute;
    const t = this.now();
    this.nextAt = (this.nextAt < t - interval ? t : this.nextAt) + interval;
    this.stats.acquired++;
  }
}

/**
 * Roblox sends these headers in a structured form, e.g.
 * `x-ratelimit-limit: 1000000, 1000000;w=60, 2000000;w=60`. The first number is the
 * limit for the current window. Note that this is the API-key level limit, not the
 * per-universe DataStore throttle, which is not reported in headers.
 */
export function parseRateHeaders(headers: Headers): RateInfo {
  const num = (name: string): number | undefined => {
    const v = headers.get(name);
    if (v === null) return undefined;
    const first = v.split(',')[0]?.split(';')[0]?.trim() ?? '';
    const n = Number(first);
    return Number.isFinite(n) && first !== '' ? n : undefined;
  };
  return { limit: num('x-ratelimit-limit'), remaining: num('x-ratelimit-remaining'), reset: num('x-ratelimit-reset') };
}
