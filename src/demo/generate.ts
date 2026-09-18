/**
 * Synthetic "demo game" records. Deliberately generic, but shaped like real
 * Roblox save data: counters, gauges, booleans, keyed maps with timestamps,
 * a rolling activity log, and the Lua serialization quirks (`[]` for empty
 * maps, `false` placeholders in slot arrays).
 */

export interface DemoRevision {
  revisionId: string;
  revisionCreateTime: string; // ISO
  value: unknown;
}

export interface DemoEntry {
  key: string;
  userId: number;
  createTime: string; // ISO
  revisionCreateTime: string; // ISO
  revisionId: string;
  value: unknown;
  /** Previous revisions, newest first (the mock serves these as revision history). */
  revisions?: DemoRevision[];
}

export interface GenerateOptions {
  players: number;
  seed: number;
  /** Unix seconds "now" for the dataset. */
  now: number;
  keyTemplate: string;
  envelope: 'raw' | 'documentservice';
}

export interface TickOptions {
  /** Share of players that return and change between ticks. */
  fraction: number;
  seed: number;
  /** Unix seconds for the new "now". */
  now: number;
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const QUEST_CHAIN = ['q_intro', 'q_first_area', 'q_join_guild', 'q_first_boss', 'q_endgame'] as const;
const AREAS = ['meadow', 'forest', 'caves', 'summit', 'abyss'] as const;
const ITEM_COUNT = 40;

export function levelForXp(xp: number): number {
  return Math.floor(Math.sqrt(xp / 100)) + 1;
}

interface DemoRecord {
  profile: { createdAt: number; lastSeenAt: number; playtimeSeconds: number };
  stats: { coins: number; gems: number; xp: number; enemiesDefeated: number; distance: number };
  progress: {
    areas: Record<string, boolean> | never[];
    quests: { completed: Record<string, { at: number; count: number }> | never[]; active: string[] };
  };
  flags: { tutorialDone: boolean; joinedGuild: boolean; premium: boolean };
  collection: Record<string, { found: boolean; firstAt: number; count: number }> | never[];
  inventory: { slotCount: number; slots: ({ itemId: string; qty: number } | false)[] };
  recentEvents: { t: string; d: string | number; ts: number }[];
  settings: { music: boolean; muted: never[] };
}

function luaMap<T>(m: Record<string, T>): Record<string, T> | never[] {
  return Object.keys(m).length ? m : [];
}

function asMap<T>(m: Record<string, T> | never[]): Record<string, T> {
  return Array.isArray(m) ? {} : m;
}

function pushEvent(r: DemoRecord, t: string, d: string | number, ts: number): void {
  r.recentEvents.push({ t, d, ts });
  if (r.recentEvents.length > 10) r.recentEvents.splice(0, r.recentEvents.length - 10);
}

/** Simulate a play session of `seconds` starting at `start`, mutating the record. */
function playSession(r: DemoRecord, rand: () => number, start: number, seconds: number): void {
  const end = start + seconds;
  r.profile.playtimeSeconds += seconds;
  r.profile.lastSeenAt = end;
  r.stats.distance += Math.floor(seconds * (0.5 + rand()));
  r.stats.enemiesDefeated += Math.floor(seconds / 60);
  r.stats.coins += Math.floor(seconds / 10) - Math.floor(rand() * seconds / 20);
  if (r.stats.coins < 0) r.stats.coins = 0;
  if (rand() < 0.1) r.stats.gems += 1;

  const before = levelForXp(r.stats.xp);
  r.stats.xp += Math.floor(seconds * (0.3 + rand() * 0.7));
  const after = levelForXp(r.stats.xp);
  for (let l = before + 1; l <= after; l++) pushEvent(r, 'lvl', l, start + Math.floor((seconds * (l - before)) / (after - before + 1)));

  // Collection: find some items.
  const coll = asMap(r.collection);
  const finds = Math.floor(seconds / 300);
  for (let i = 0; i < finds; i++) {
    const id = `item_${String(1 + Math.floor(rand() * ITEM_COUNT)).padStart(3, '0')}`;
    const ts = start + Math.floor(rand() * seconds);
    const existing = coll[id];
    if (existing) existing.count += 1;
    else {
      coll[id] = { found: true, firstAt: ts, count: 1 };
      pushEvent(r, 'find', id, ts);
    }
  }
  r.collection = luaMap(coll);

  // Quest chain: complete the next quest with some probability, gated by playtime.
  const completed = asMap(r.progress.quests.completed);
  const nextIdx = QUEST_CHAIN.findIndex((q) => !completed[q]);
  if (nextIdx >= 0 && r.profile.playtimeSeconds > nextIdx * 1800 && rand() < 0.6) {
    const q = QUEST_CHAIN[nextIdx]!;
    const at = start + Math.floor(rand() * seconds);
    completed[q] = { at, count: 1 };
    pushEvent(r, 'quest', q, at);
    if (q === 'q_intro') r.flags.tutorialDone = true;
    if (q === 'q_join_guild') r.flags.joinedGuild = true;
    const areas = asMap(r.progress.areas);
    const area = AREAS[Math.min(nextIdx, AREAS.length - 1)]!;
    areas[area] = true;
    r.progress.areas = luaMap(areas);
    r.progress.quests.active = nextIdx + 1 < QUEST_CHAIN.length ? [QUEST_CHAIN[nextIdx + 1]!] : [];
  }
  r.progress.quests.completed = luaMap(completed);

  // Inventory: fill some slots.
  for (let i = 0; i < r.inventory.slots.length; i++) {
    if (r.inventory.slots[i] === false && rand() < 0.2) {
      r.inventory.slots[i] = { itemId: `item_${String(1 + Math.floor(rand() * ITEM_COUNT)).padStart(3, '0')}`, qty: 1 + Math.floor(rand() * 5) };
    }
  }
}

function newRecord(createdAt: number): DemoRecord {
  return {
    profile: { createdAt, lastSeenAt: createdAt, playtimeSeconds: 0 },
    stats: { coins: 100, gems: 0, xp: 0, enemiesDefeated: 0, distance: 0 },
    progress: { areas: luaMap({ meadow: true }), quests: { completed: [], active: ['q_intro'] } },
    flags: { tutorialDone: false, joinedGuild: false, premium: false },
    collection: [],
    inventory: { slotCount: 8, slots: Array.from({ length: 8 }, () => false as const) },
    recentEvents: [],
    settings: { music: true, muted: [] },
  };
}

function wrap(envelope: GenerateOptions['envelope'], data: DemoRecord, lastSeen: number): unknown {
  if (envelope === 'raw') return data;
  return {
    data,
    dataSchemaVersion: 0,
    documentServiceSchemaVersion: 0,
    isLocked: false,
    lastCompatibleVersion: 0,
    lockTimestamp: lastSeen,
    sessionLockId: `demo-${lastSeen}`,
  };
}

function unwrapDemo(value: unknown): DemoRecord {
  const v = value as { data?: DemoRecord } & DemoRecord;
  return (v.data ?? v) as DemoRecord;
}

const iso = (unix: number): string => new Date(unix * 1000).toISOString();

/** Build a dataset. Deterministic for a given seed. */
export function generateDataset(opts: GenerateOptions): DemoEntry[] {
  const rand = rng(opts.seed);
  const entries: DemoEntry[] = [];
  const DAY = 86400;
  for (let i = 0; i < opts.players; i++) {
    const userId = 100000 + Math.floor(rand() * 9_000_000);
    const createdAt = opts.now - Math.floor(rand() * 120 * DAY);
    const record = newRecord(createdAt);
    // Session count skews low: most players play a few times and stop.
    const sessions = rand() < 0.6 ? 1 + Math.floor(rand() * 3) : 3 + Math.floor(rand() * 30);
    let t = createdAt;
    for (let s = 0; s < sessions && t < opts.now; s++) {
      const len = 300 + Math.floor(rand() * 3000);
      playSession(record, rand, t, len);
      t += len + Math.floor(rand() * 5 * DAY);
    }
    record.flags.premium = rand() < 0.08;
    const lastSeen = record.profile.lastSeenAt;
    entries.push({
      key: opts.keyTemplate.replace('{userId}', String(userId)),
      userId,
      createTime: iso(createdAt),
      revisionCreateTime: iso(lastSeen),
      revisionId: `r${lastSeen}`,
      value: wrap(opts.envelope, record, lastSeen),
    });
  }
  // Dedup user ids (rare collisions).
  const seen = new Set<number>();
  return entries.filter((e) => (seen.has(e.userId) ? false : (seen.add(e.userId), true)));
}

// ---------------------------------------------------------------- supplemental store: purchases

/** One row of the demo's sparse purchase store: a flat list per player, no envelope. */
export interface DemoPurchase {
  at: number;
  currency: string;
  placeId: number;
  productId: number;
  productKey: string;
  purchaseId: string;
  robuxSpent: number;
}

const PRODUCTS = [
  { key: 'coins_small', currency: 'coins', robux: 49, id: 9001 },
  { key: 'coins_large', currency: 'coins', robux: 199, id: 9002 },
  { key: 'gems_pack', currency: 'gems', robux: 99, id: 9003 },
  { key: 'starter_bundle', currency: 'coins', robux: 0, id: 9004 }, // paid with in-game currency
] as const;
const PLACE_ID = 424242;

export interface PurchaseOptions {
  seed: number;
  /** Share of players who have any purchase (sparse by design). */
  fraction?: number;
  /** Key template of the purchase store; the demo uses a bare user id to show templates may differ. */
  keyTemplate?: string;
}

function purchaseEntry(userId: number, key: string, list: DemoPurchase[]): DemoEntry {
  const first = list[0]!.at;
  const last = list[list.length - 1]!.at;
  return { key, userId, createTime: iso(first), revisionCreateTime: iso(last), revisionId: `p${last}`, value: list };
}

function buyOne(rand: () => number, at: number): DemoPurchase {
  const p = PRODUCTS[Math.floor(rand() * PRODUCTS.length)]!;
  return { at, currency: p.currency, placeId: PLACE_ID, productId: p.id, productKey: p.key, purchaseId: Math.floor(rand() * 2 ** 48).toString(16).padStart(12, '0'), robuxSpent: p.robux };
}

/**
 * A supplemental datastore held by a small fraction of players: their purchase history,
 * timestamped between the player's first and last activity. Deterministic for a seed.
 */
export function generatePurchases(players: DemoEntry[], opts: PurchaseOptions): DemoEntry[] {
  const rand = rng(opts.seed);
  const fraction = opts.fraction ?? 0.05;
  const template = opts.keyTemplate ?? '{userId}';
  const out: DemoEntry[] = [];
  for (const e of players) {
    if (rand() >= fraction) continue;
    const from = Math.floor(new Date(e.createTime).getTime() / 1000);
    const to = Math.floor(new Date(e.revisionCreateTime).getTime() / 1000);
    const n = 1 + Math.floor(rand() * rand() * 6);
    const list: DemoPurchase[] = [];
    for (let i = 0; i < n; i++) list.push(buyOne(rand, from + Math.floor(rand() * Math.max(1, to - from))));
    list.sort((a, b) => a.at - b.at);
    out.push(purchaseEntry(e.userId, template.replace('{userId}', String(e.userId)), list));
  }
  return out;
}

/**
 * Advance the purchase store: some existing buyers buy again, and a few players buy for
 * the first time (a new key appears). Returns the number of entries changed or added.
 */
export function tickPurchases(purchases: DemoEntry[], players: DemoEntry[], opts: TickOptions & { keyTemplate?: string }): number {
  const rand = rng(opts.seed);
  const template = opts.keyTemplate ?? '{userId}';
  const have = new Set(purchases.map((p) => p.userId));
  let changed = 0;
  for (const p of purchases) {
    if (rand() >= opts.fraction) continue;
    const list = [...(p.value as DemoPurchase[])];
    const last = list[list.length - 1]!.at;
    list.push(buyOne(rand, last + 1 + Math.floor(rand() * Math.max(1, opts.now - last - 1))));
    p.revisions = [{ revisionId: p.revisionId, revisionCreateTime: p.revisionCreateTime, value: p.value }, ...(p.revisions ?? [])].slice(0, 30);
    Object.assign(p, purchaseEntry(p.userId, p.key, list), { createTime: p.createTime });
    changed++;
  }
  for (const e of players) {
    if (have.has(e.userId) || rand() >= opts.fraction * 0.1) continue;
    const at = opts.now - Math.floor(rand() * 3 * 86400);
    purchases.push(purchaseEntry(e.userId, template.replace('{userId}', String(e.userId)), [buyOne(rand, at)]));
    changed++;
  }
  return changed;
}

/** Advance the world: a fraction of players return and play more. Returns changed count. */
export function tickDataset(entries: DemoEntry[], opts: TickOptions): number {
  const rand = rng(opts.seed);
  const DAY = 86400;
  let changed = 0;
  for (const e of entries) {
    if (rand() >= opts.fraction) continue;
    const isWrapped = typeof e.value === 'object' && e.value !== null && 'data' in (e.value as object);
    const previousValue = JSON.parse(JSON.stringify(e.value)) as unknown;
    const record = unwrapDemo(e.value);
    const sessions = 1 + Math.floor(rand() * 4);
    // Sessions happen after the player's previous activity, so revision times stay
    // monotonic per player, as they are for real DataStore writes.
    let t = Math.max(opts.now - Math.floor(rand() * 6 * DAY), record.profile.lastSeenAt + 60);
    for (let s = 0; s < sessions; s++) {
      const len = 300 + Math.floor(rand() * 3000);
      playSession(record, rand, t, len);
      t += len + Math.floor(rand() * DAY);
    }
    const lastSeen = record.profile.lastSeenAt;
    // Keep the previous state as revision history (newest first, capped like the real 30-day window).
    e.revisions = [{ revisionId: e.revisionId, revisionCreateTime: e.revisionCreateTime, value: previousValue }, ...(e.revisions ?? [])].slice(0, 30);
    e.value = wrap(isWrapped ? 'documentservice' : 'raw', record, lastSeen);
    e.revisionCreateTime = iso(lastSeen);
    e.revisionId = `r${lastSeen}`;
    changed++;
  }
  return changed;
}
