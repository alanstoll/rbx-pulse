import { RateLimiter, parseRateHeaders, type RateInfo } from './limiter.js';

export interface EntryPage {
  ids: string[];
  nextPageToken?: string;
}

export interface Entry {
  id: string;
  value: unknown;
  createTime?: string;
  revisionId?: string;
  revisionCreateTime?: string;
  users?: string[];
  attributes?: unknown;
}

export interface OrderedEntry {
  id: string;
  value: number;
}

export interface OrderedPage {
  entries: OrderedEntry[];
  nextPageToken?: string;
}

export interface RevisionRef {
  revisionId: string;
  revisionCreateTime: string;
}

export interface RevisionPage {
  revisions: RevisionRef[];
  nextPageToken?: string;
}

export interface UserInfo {
  id: string;
  name?: string;
  displayName?: string;
  createTime?: string;
  locale?: string;
  premium?: boolean;
}

export class OpenCloudError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'OpenCloudError';
  }
  /** Auth and permission failures never succeed on retry; abort the run. */
  get fatal(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  universeId: string;
  limiter: RateLimiter;
  fetchImpl?: typeof fetch;
  /** Attempts for transient failures (5xx, network). 429 retries are unbounded but paced. */
  maxAttempts?: number;
  log?: (msg: string) => void;
}

export interface ClientStats {
  requests: number;
  throttled: number;
  retries: number;
  lastRate?: RateInfo;
}

/** Minimal Open Cloud v2 client: DataStore entries and revisions, OrderedDataStore listing, users. */
export class OpenCloudClient {
  readonly stats: ClientStats = { requests: 0, throttled: 0, retries: 0 };
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;

  constructor(private readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxAttempts = opts.maxAttempts ?? 5;
  }

  private get root(): string {
    return `${this.opts.baseUrl.replace(/\/$/, '')}/cloud/v2`;
  }

  /**
   * Always use the scoped form of the endpoints. The unscoped form lists ids as
   * "<scope>/<key>", which is ambiguous for keys containing slashes.
   */
  private entriesPath(datastore: string, scope: string): string {
    return `${this.root}/universes/${this.opts.universeId}/data-stores/${encodeURIComponent(datastore)}/scopes/${encodeURIComponent(scope)}/entries`;
  }

  private orderedPath(datastore: string, scope: string): string {
    return `${this.root}/universes/${this.opts.universeId}/ordered-data-stores/${encodeURIComponent(datastore)}/scopes/${encodeURIComponent(scope)}/entries`;
  }

  async listEntries(datastore: string, scope: string, pageToken?: string, maxPageSize = 256): Promise<EntryPage> {
    const url = new URL(this.entriesPath(datastore, scope));
    url.searchParams.set('maxPageSize', String(maxPageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const body = (await this.request(url)) as { dataStoreEntries?: { id: string; path?: string }[]; nextPageToken?: string };
    return {
      ids: (body.dataStoreEntries ?? []).map((e) => entryKey(e, scope)),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  /** Returns undefined when the entry does not exist (404). */
  async getEntry(datastore: string, scope: string, id: string): Promise<Entry | undefined> {
    const url = new URL(`${this.entriesPath(datastore, scope)}/${encodeURIComponent(id)}`);
    try {
      return (await this.request(url)) as Entry;
    } catch (err) {
      if (err instanceof OpenCloudError && err.status === 404) return undefined;
      throw err;
    }
  }

  /** The entry's value at a specific revision, via "<id>@<revisionId>". */
  async getEntryRevision(datastore: string, scope: string, id: string, revisionId: string): Promise<Entry | undefined> {
    const url = new URL(`${this.entriesPath(datastore, scope)}/${encodeURIComponent(id)}@${encodeURIComponent(revisionId)}`);
    try {
      const e = (await this.request(url)) as Entry;
      return { ...e, id: e.id.split('@')[0] ?? e.id };
    } catch (err) {
      if (err instanceof OpenCloudError && err.status === 404) return undefined;
      throw err;
    }
  }

  /** Revisions of an entry, newest first (as the service returns them). Retained about 30 days. */
  async listRevisions(datastore: string, scope: string, id: string, pageToken?: string, maxPageSize = 100): Promise<RevisionPage> {
    const url = new URL(`${this.entriesPath(datastore, scope)}/${encodeURIComponent(id)}:listRevisions`);
    url.searchParams.set('maxPageSize', String(maxPageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const body = (await this.request(url)) as { dataStoreEntries?: { revisionId: string; revisionCreateTime: string }[]; nextPageToken?: string };
    return {
      revisions: (body.dataStoreEntries ?? []).map((r) => ({ revisionId: r.revisionId, revisionCreateTime: r.revisionCreateTime })),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  /**
   * OrderedDataStore entries sorted by value. Needs the
   * `universe.ordered-data-store.scope.entry:read` scope on the API key.
   */
  async listOrderedEntries(datastore: string, scope: string, pageToken?: string, descending = true, maxPageSize = 100): Promise<OrderedPage> {
    const url = new URL(this.orderedPath(datastore, scope));
    url.searchParams.set('maxPageSize', String(maxPageSize));
    url.searchParams.set('orderBy', descending ? 'value desc' : 'value');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const body = (await this.request(url)) as {
      orderedDataStoreEntries?: { id: string; path?: string; value: number | string }[];
      entries?: { id: string; path?: string; value: number | string }[];
      nextPageToken?: string;
    };
    const list = body.orderedDataStoreEntries ?? body.entries ?? [];
    return {
      entries: list.map((e) => ({ id: entryKey(e, scope), value: Number(e.value) })),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  /** Public profile info for a user; undefined when not found. */
  async getUser(userId: number | string): Promise<UserInfo | undefined> {
    const url = new URL(`${this.root}/users/${userId}`);
    try {
      const u = (await this.request(url)) as UserInfo & { path?: string };
      return { id: String(u.id ?? userId), name: u.name, displayName: u.displayName, createTime: u.createTime, locale: u.locale, premium: u.premium };
    } catch (err) {
      if (err instanceof OpenCloudError && err.status === 404) return undefined;
      throw err;
    }
  }

  private async request(url: URL): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      await this.opts.limiter.acquire();
      this.stats.requests++;
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers: { 'x-api-key': this.opts.apiKey, accept: 'application/json' } });
      } catch (err) {
        attempt++;
        if (attempt >= this.maxAttempts) throw new OpenCloudError(`network error after ${attempt} attempts: ${(err as Error).message}`, 0);
        this.stats.retries++;
        await backoff(attempt);
        continue;
      }

      const rate = parseRateHeaders(res.headers);
      this.stats.lastRate = rate;
      this.opts.limiter.observe(rate);

      if (res.status === 429) {
        this.stats.throttled++;
        const retryAfter = Number(res.headers.get('retry-after') ?? rate.reset ?? 10);
        this.opts.limiter.pause((Number.isFinite(retryAfter) ? retryAfter : 10) * 1000, '429');
        this.opts.log?.(`429 from Open Cloud; pausing ${retryAfter}s`);
        await res.arrayBuffer().catch(() => undefined);
        continue;
      }

      if (res.status >= 500) {
        attempt++;
        await res.arrayBuffer().catch(() => undefined);
        if (attempt >= this.maxAttempts) throw new OpenCloudError(`server error ${res.status} after ${attempt} attempts`, res.status);
        this.stats.retries++;
        await backoff(attempt);
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        let code: string | undefined;
        let message = text;
        try {
          const j = JSON.parse(text) as { code?: string | number; message?: string };
          code = j.code === undefined ? undefined : String(j.code);
          message = j.message ?? text;
        } catch {
          /* not JSON */
        }
        throw new OpenCloudError(`${res.status} ${code ?? ''} ${message}`.trim(), res.status, code);
      }
      return text.length ? (JSON.parse(text) as unknown) : {};
    }
  }
}

/** The bare key: last segment of `path` when present, else `id` minus a "<scope>/" prefix. */
export function entryKey(e: { id: string; path?: string }, scope: string): string {
  if (e.path) {
    const marker = '/entries/';
    const i = e.path.lastIndexOf(marker);
    if (i >= 0) return decodeURIComponent(e.path.slice(i + marker.length));
  }
  return e.id.startsWith(`${scope}/`) ? e.id.slice(scope.length + 1) : e.id;
}

function backoff(attempt: number): Promise<void> {
  const ms = Math.min(30_000, 500 * 2 ** attempt) * (0.5 + Math.random());
  return new Promise((r) => setTimeout(r, ms));
}
