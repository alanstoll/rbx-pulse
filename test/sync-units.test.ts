import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash } from '../src/sync/hash.js';
import { RateLimiter, parseRateHeaders } from '../src/sync/limiter.js';
import { msUntilOpen } from '../src/sync/window.js';

describe('content hashing', () => {
  it('is independent of key order and stable', () => {
    const a = { b: 1, a: { d: [1, { z: 1, y: 2 }], c: 2 } };
    const b = { a: { c: 2, d: [1, { y: 2, z: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(contentHash([])).not.toBe(contentHash({}));
  });
});

describe('RateLimiter', () => {
  function fakeClock() {
    let t = 0;
    const slept: number[] = [];
    return {
      now: () => t,
      sleep: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
      advance: (ms: number) => (t += ms),
      slept,
    };
  }

  it('paces to maxPerMinute without headers', async () => {
    const clock = fakeClock();
    const l = new RateLimiter({ maxPerMinute: 120, budgetFraction: 0.5, now: clock.now, sleep: clock.sleep });
    await l.acquire();
    await l.acquire();
    await l.acquire();
    // 120/min = one every 500ms; second and third acquires wait.
    expect(clock.slept).toEqual([500, 500]);
  });

  it('takes only its budget fraction of the reported limit', () => {
    const l = new RateLimiter({ maxPerMinute: 1000, budgetFraction: 0.25 });
    l.observe({ limit: 400, remaining: 400, reset: 60 });
    expect(l.rate).toBe(100);
    l.observe({ limit: 8000, remaining: 8000, reset: 60 });
    expect(l.rate).toBe(1000); // capped by maxPerMinute
  });

  it('pauses when remaining budget falls into the game reserve', async () => {
    const clock = fakeClock();
    const l = new RateLimiter({ maxPerMinute: 1000, budgetFraction: 0.25, now: clock.now, sleep: clock.sleep });
    l.observe({ limit: 400, remaining: 300, reset: 30 }); // reserve is 300: at the line -> pause
    await l.acquire();
    expect(l.stats.pauses).toBe(1);
    expect(clock.slept[0]).toBe(30_000);
  });

  it('does not pause while the game still has its reserve', async () => {
    const clock = fakeClock();
    const l = new RateLimiter({ maxPerMinute: 1000, budgetFraction: 0.25, now: clock.now, sleep: clock.sleep });
    l.observe({ limit: 400, remaining: 301, reset: 30 });
    await l.acquire();
    expect(l.stats.pauses).toBe(0);
  });

  it('clamps explicit pauses to 1s..120s', () => {
    const clock = fakeClock();
    const l = new RateLimiter({ maxPerMinute: 60, budgetFraction: 1, now: clock.now, sleep: clock.sleep });
    l.pause(10);
    l.pause(999_999);
    expect(l.stats.pauses).toBe(2);
  });
});

describe('parseRateHeaders', () => {
  it('reads plain and structured header values', () => {
    expect(parseRateHeaders(new Headers({ 'x-ratelimit-limit': '300', 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': '7' }))).toEqual({ limit: 300, remaining: 12, reset: 7 });
    expect(parseRateHeaders(new Headers({ 'x-ratelimit-limit': '1000000, 1000000;w=60, 2000000;w=60', 'x-ratelimit-remaining': '999999' }))).toEqual({ limit: 1000000, remaining: 999999, reset: undefined });
    expect(parseRateHeaders(new Headers({}))).toEqual({ limit: undefined, remaining: undefined, reset: undefined });
  });
});

describe('sync window', () => {
  it('is open without a window', () => {
    expect(msUntilOpen(undefined)).toBe(0);
  });

  it('handles same-day and overnight windows in UTC', () => {
    const at = (h: number, m = 0) => new Date(Date.UTC(2026, 0, 1, h, m));
    const day = { start: '02:00', end: '06:00', timezone: 'UTC' };
    expect(msUntilOpen(day, at(3))).toBe(0);
    expect(msUntilOpen(day, at(7))).toBe(19 * 60 * 60_000);
    expect(msUntilOpen(day, at(1, 30))).toBe(30 * 60_000);
    const night = { start: '22:00', end: '04:00', timezone: 'UTC' };
    expect(msUntilOpen(night, at(23))).toBe(0);
    expect(msUntilOpen(night, at(3))).toBe(0);
    expect(msUntilOpen(night, at(12))).toBe(10 * 60 * 60_000);
  });

  it('respects the timezone', () => {
    // 03:00 UTC is 22:00 previous day in America/New_York (EST, UTC-5).
    const w = { start: '21:00', end: '23:00', timezone: 'America/New_York' };
    expect(msUntilOpen(w, new Date(Date.UTC(2026, 0, 2, 3, 0)))).toBe(0);
    expect(msUntilOpen(w, new Date(Date.UTC(2026, 0, 2, 12, 0)))).toBeGreaterThan(0);
  });
});
