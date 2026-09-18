/**
 * A small stand-in for the Open Cloud v2 API, backed by JSONL datasets:
 * DataStore entries (list, get, revisions), an OrderedDataStore index, and users.
 * Implements an x-api-key check and a per-minute request budget with real
 * x-ratelimit headers and 429 responses, so the sync layer can be developed honestly.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readDataset, datasetMtime, readOrderedIndex, orderedIndexMtime } from './dataset.js';
import type { DemoEntry } from './generate.js';

export interface MockOptions {
  dataDir: string;
  universeId: string;
  apiKey: string;
  /** Requests per minute before 429. */
  rpm: number;
  /** Extra latency per request, ms. */
  latencyMs?: number;
}

interface LoadedStore {
  entries: DemoEntry[];
  byKey: Map<string, DemoEntry>;
  mtime: number;
}

interface LoadedIndex {
  entries: { key: string; value: number }[];
  mtime: number;
}

export interface MockStats {
  requests: number;
  throttled: number;
  unauthorized: number;
}

export class MockOpenCloud {
  private readonly stores = new Map<string, LoadedStore>();
  private readonly indexes = new Map<string, LoadedIndex>();
  private readonly windowHits: number[] = [];
  readonly stats: MockStats = { requests: 0, throttled: 0, unauthorized: 0 };
  private server?: Server;

  constructor(private readonly opts: MockOptions) {}

  async listen(port: number): Promise<number> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, resolve));
    const addr = this.server.address();
    return typeof addr === 'object' && addr ? addr.port : port;
  }

  /** Forget cached datasets, so rewritten files are re-read even within one mtime tick. */
  invalidate(): void {
    this.stores.clear();
    this.indexes.clear();
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => (this.server ? this.server.close((e) => (e ? reject(e) : resolve())) : resolve()));
  }

  private async store(name: string): Promise<LoadedStore | undefined> {
    const mtime = await datasetMtime(this.opts.dataDir, name);
    if (mtime === 0) return undefined;
    const cached = this.stores.get(name);
    if (cached && cached.mtime === mtime) return cached;
    const entries = await readDataset(this.opts.dataDir, name);
    const loaded: LoadedStore = { entries, byKey: new Map(entries.map((e) => [e.key, e])), mtime };
    this.stores.set(name, loaded);
    return loaded;
  }

  private async index(name: string): Promise<LoadedIndex | undefined> {
    const mtime = await orderedIndexMtime(this.opts.dataDir, name);
    if (mtime === 0) return undefined;
    const cached = this.indexes.get(name);
    if (cached && cached.mtime === mtime) return cached;
    const loaded: LoadedIndex = { entries: await readOrderedIndex(this.opts.dataDir, name), mtime };
    this.indexes.set(name, loaded);
    return loaded;
  }

  /** Sliding one-minute window. Returns [allowed, remaining, resetSeconds]. */
  private budget(): [boolean, number, number] {
    const now = Date.now();
    while (this.windowHits.length && this.windowHits[0]! <= now - 60_000) this.windowHits.shift();
    const used = this.windowHits.length;
    const remaining = Math.max(0, this.opts.rpm - used);
    const reset = this.windowHits.length ? Math.ceil((this.windowHits[0]! + 60_000 - now) / 1000) : 60;
    if (remaining === 0) return [false, 0, reset];
    this.windowHits.push(now);
    return [true, remaining - 1, reset];
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
    res.end(text);
  }

  private page<T>(items: T[], url: URL, max = 256): { items: T[]; next?: string } {
    const maxPageSize = Math.min(max, Math.max(1, Number(url.searchParams.get('maxPageSize') ?? 100)));
    const token = url.searchParams.get('pageToken');
    const offset = token ? Number(Buffer.from(token, 'base64url').toString('utf8')) : 0;
    const page = items.slice(offset, offset + maxPageSize);
    const next = offset + maxPageSize < items.length ? Buffer.from(String(offset + maxPageSize)).toString('base64url') : undefined;
    return { items: page, next };
  }

  private entryBody(e: DemoEntry, basePath: string, idOf: (k: string) => string, rev?: { revisionId: string; revisionCreateTime: string; value: unknown }): unknown {
    const revisionId = rev?.revisionId ?? e.revisionId;
    const suffix = rev ? `@${revisionId}` : '';
    return {
      path: `${basePath}/${encodeURIComponent(e.key)}${suffix}`,
      id: `${idOf(e.key)}${suffix}`,
      createTime: e.createTime,
      revisionId,
      revisionCreateTime: rev?.revisionCreateTime ?? e.revisionCreateTime,
      state: 'ACTIVE',
      etag: revisionId,
      value: rev ? rev.value : e.value,
      users: [`users/${e.userId}`],
      attributes: {},
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.stats.requests++;
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));

    if (req.headers['x-api-key'] !== this.opts.apiKey) {
      this.stats.unauthorized++;
      return this.json(res, 401, { code: 'UNAUTHENTICATED', message: 'invalid API key' });
    }

    const [allowed, remaining, reset] = this.budget();
    const rl = { 'x-ratelimit-limit': String(this.opts.rpm), 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': String(reset) };
    if (!allowed) {
      this.stats.throttled++;
      return this.json(res, 429, { code: 'RESOURCE_EXHAUSTED', message: 'rate limited' }, { ...rl, 'retry-after': String(reset) });
    }
    if (req.method !== 'GET') return this.json(res, 404, { code: 'NOT_FOUND', message: 'unknown route' }, rl);
    const url = new URL(req.url ?? '/', 'http://localhost');

    // ---- users
    const um = /^\/cloud\/v2\/users\/(-?\d+)$/.exec(url.pathname);
    if (um) {
      const uid = Number(um[1]);
      for (const name of this.stores.keys()) {
        const st = await this.store(name);
        const e = st?.entries.find((x) => x.userId === uid);
        if (e) {
          const premium = Boolean((e.value as { data?: { flags?: { premium?: boolean } } })?.data?.flags?.premium);
          return this.json(res, 200, { path: `users/${uid}`, id: String(uid), name: `demo_${uid}`, displayName: `Demo ${uid}`, createTime: e.createTime, locale: 'en_us', premium }, rl);
        }
      }
      return this.json(res, 404, { code: 'NOT_FOUND', message: 'user not found' }, rl);
    }

    // ---- ordered data stores
    const om = /^\/cloud\/v2\/universes\/(\d+)\/ordered-data-stores\/([^/]+)\/scopes\/([^/]+)\/entries$/.exec(url.pathname);
    if (om) {
      const [, universeId, dsName, scope] = om;
      if (universeId !== this.opts.universeId) return this.json(res, 403, { code: 'PERMISSION_DENIED', message: 'wrong universe' }, rl);
      const idx = await this.index(decodeURIComponent(dsName!));
      if (!idx) return this.json(res, 404, { code: 'NOT_FOUND', message: `ordered datastore ${dsName} not found` }, rl);
      const desc = (url.searchParams.get('orderBy') ?? '').includes('desc');
      const sorted = [...idx.entries].sort((a, b) => (desc ? b.value - a.value : a.value - b.value));
      const { items, next } = this.page(sorted, url, 100);
      const basePath = `universes/${universeId}/ordered-data-stores/${dsName}/scopes/${scope}/entries`;
      return this.json(res, 200, { orderedDataStoreEntries: items.map((e) => ({ path: `${basePath}/${encodeURIComponent(e.key)}`, id: e.key, value: e.value })), ...(next ? { nextPageToken: next } : {}) }, rl);
    }

    // ---- standard data stores
    const m = /^\/cloud\/v2\/universes\/(\d+)\/data-stores\/([^/]+)(?:\/scopes\/([^/]+))?\/entries(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return this.json(res, 404, { code: 'NOT_FOUND', message: 'unknown route' }, rl);
    const [, universeId, dsName, scope, rawEntry] = m;
    if (universeId !== this.opts.universeId) return this.json(res, 403, { code: 'PERMISSION_DENIED', message: 'wrong universe' }, rl);

    const store = await this.store(decodeURIComponent(dsName!));

    // Real API: paths always carry the scope; ids carry a "<scope>/" prefix on the unscoped route.
    const effScope = scope ?? 'global';
    const basePath = `universes/${universeId}/data-stores/${dsName}/scopes/${effScope}/entries`;
    const idOf = (key: string): string => (scope ? key : `${effScope}/${key}`);

    if (rawEntry === undefined) {
      // DataStores exist implicitly: listing one nothing was ever written to is an empty page.
      const { items, next } = this.page(store?.entries ?? [], url, 256);
      return this.json(res, 200, { dataStoreEntries: items.map((e) => ({ path: `${basePath}/${encodeURIComponent(e.key)}`, id: idOf(e.key) })), ...(next ? { nextPageToken: next } : {}) }, rl);
    }
    if (!store) return this.json(res, 404, { code: 'NOT_FOUND', message: 'entry not found' }, rl);

    // entries/{id}, entries/{id}@{rev}, entries/{id}:listRevisions
    const decoded = decodeURIComponent(rawEntry);
    const listRev = decoded.endsWith(':listRevisions');
    const base = listRev ? decoded.slice(0, -':listRevisions'.length) : decoded;
    const at = base.indexOf('@');
    const key = at >= 0 ? base.slice(0, at) : base;
    const revId = at >= 0 ? base.slice(at + 1) : undefined;
    const entry = store.byKey.get(key);
    if (!entry) return this.json(res, 404, { code: 'NOT_FOUND', message: 'entry not found' }, rl);

    const history = entry.revisions ?? [];
    if (listRev) {
      const all = [{ revisionId: entry.revisionId, revisionCreateTime: entry.revisionCreateTime, value: entry.value }, ...history];
      const { items, next } = this.page(all, url, 100);
      return this.json(
        res,
        200,
        {
          dataStoreEntries: items.map((r) => ({
            path: `${basePath}/${encodeURIComponent(entry.key)}@${r.revisionId}`,
            id: `${entry.key}@${r.revisionId}`,
            createTime: entry.createTime,
            revisionId: r.revisionId,
            revisionCreateTime: r.revisionCreateTime,
            state: 'ACTIVE',
            etag: r.revisionId,
          })),
          ...(next ? { nextPageToken: next } : {}),
        },
        rl,
      );
    }
    if (revId !== undefined) {
      if (revId === entry.revisionId) return this.json(res, 200, this.entryBody(entry, basePath, idOf, { revisionId: entry.revisionId, revisionCreateTime: entry.revisionCreateTime, value: entry.value }), rl);
      const r = history.find((h) => h.revisionId === revId);
      if (!r) return this.json(res, 404, { code: 'NOT_FOUND', message: 'revision not found' }, rl);
      return this.json(res, 200, this.entryBody(entry, basePath, idOf, r), rl);
    }
    return this.json(res, 200, this.entryBody(entry, basePath, idOf), rl);
  }
}
