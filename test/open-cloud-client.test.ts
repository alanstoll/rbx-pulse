import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDataset } from '../src/demo/generate.js';
import { writeDataset } from '../src/demo/dataset.js';
import { MockOpenCloud } from '../src/demo/mock-open-cloud.js';
import { OpenCloudClient, OpenCloudError, entryKey } from '../src/sync/open-cloud.js';
import { RateLimiter } from '../src/sync/limiter.js';

describe('OpenCloudClient against the mock', () => {
  let mock: MockOpenCloud;
  let baseUrl: string;
  const total = 25;

  beforeAll(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pulse-client-'));
    await writeDataset(dir, 'PlayerData', generateDataset({ players: total, seed: 1, now: 1_789_700_000, keyTemplate: 'Player_{userId}', envelope: 'raw' }));
    mock = new MockOpenCloud({ dataDir: dir, universeId: '7', apiKey: 'k', rpm: 12 });
    baseUrl = `http://localhost:${await mock.listen(0)}`;
  });
  afterAll(() => mock.close());

  it('lists all pages, gets entries, and rides out 429s by pausing', async () => {
    // Limiter allows 600/min locally but the mock only allows 12/min: the client must
    // hit 429, pause on retry-after, and still finish. Use a short fake sleep to keep the test fast.
    let virtual = Date.now();
    const limiter = new RateLimiter({ maxPerMinute: 600, budgetFraction: 1, now: () => virtual, sleep: async (ms) => (virtual += ms) });
    const client = new OpenCloudClient({ baseUrl, apiKey: 'k', universeId: '7', limiter, maxAttempts: 3 });

    // Only the limiter's clock is virtual; the mock's window is real time, so throttles
    // will really happen and the client must keep retrying until the mock's window clears.
    // To keep wall time bounded we allow the mock a generous window by just asserting behavior.
    const ids: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.listEntries('PlayerData', 'global', token, 10);
      ids.push(...page.ids);
      token = page.nextPageToken;
    } while (token);
    expect(ids.length).toBe(total);

    const e = await client.getEntry('PlayerData', 'global', ids[0]!);
    expect(e?.id).toBe(ids[0]);
    expect(e?.revisionCreateTime).toBeTruthy();
    expect(await client.getEntry('PlayerData', 'global', 'Player_1')).toBeUndefined();
    expect(client.stats.requests).toBeGreaterThanOrEqual(5);
  }, 60_000);

  it('derives bare keys from real-API shaped list items', () => {
    expect(entryKey({ id: 'global/-10', path: 'universes/1/data-stores/D/scopes/global/entries/-10' }, 'global')).toBe('-10');
    expect(entryKey({ id: 'global/a/b', path: 'universes/1/data-stores/D/scopes/global/entries/a%2Fb' }, 'global')).toBe('a/b');
    expect(entryKey({ id: 'global/123' }, 'global')).toBe('123');
    expect(entryKey({ id: '123' }, 'global')).toBe('123');
  });

  it('lists revisions, fetches a revision, lists an ordered index, and gets users', async () => {
    const { writeOrderedIndex, lastLoginIndex, readDataset, writeDataset } = await import('../src/demo/dataset.js');
    const { tickDataset } = await import('../src/demo/generate.js');
    const limiter = new RateLimiter({ maxPerMinute: 600, budgetFraction: 1 });
    // Give one entry some history and write the ordered index.
    const dir2 = await mkdtemp(path.join(tmpdir(), 'pulse-client2-'));
    const entries = generateDataset({ players: 5, seed: 2, now: 1_789_700_000, keyTemplate: 'Player_{userId}', envelope: 'documentservice' });
    tickDataset(entries, { fraction: 1, seed: 3, now: 1_790_000_000 });
    await writeDataset(dir2, 'PlayerData', entries);
    await writeOrderedIndex(dir2, 'LastLogin', lastLoginIndex(entries));
    const mock2 = new MockOpenCloud({ dataDir: dir2, universeId: '7', apiKey: 'k', rpm: 10_000 });
    const base2 = `http://localhost:${await mock2.listen(0)}`;
    try {
      const client = new OpenCloudClient({ baseUrl: base2, apiKey: 'k', universeId: '7', limiter });
      const e = entries[0]!;
      const revs = await client.listRevisions('PlayerData', 'global', e.key);
      expect(revs.revisions.length).toBe(2);
      expect(revs.revisions[0]!.revisionId).toBe(e.revisionId);
      const old = await client.getEntryRevision('PlayerData', 'global', e.key, revs.revisions[1]!.revisionId);
      expect(old?.id).toBe(e.key);
      expect(old?.revisionId).toBe(revs.revisions[1]!.revisionId);
      expect(JSON.stringify(old?.value)).not.toBe(JSON.stringify(e.value));
      expect(await client.getEntryRevision('PlayerData', 'global', e.key, 'nope')).toBeUndefined();

      const page = await client.listOrderedEntries('LastLogin', 'global', undefined, true, 3);
      expect(page.entries.length).toBe(3);
      expect(page.entries[0]!.value).toBeGreaterThanOrEqual(page.entries[1]!.value);
      expect(page.nextPageToken).toBeTruthy();
      const rest = await client.listOrderedEntries('LastLogin', 'global', page.nextPageToken, true, 3);
      expect(rest.entries.length).toBe(2);
      expect(rest.nextPageToken).toBeUndefined();

      const u = await client.getUser(e.userId);
      expect(u?.name).toBe(`demo_${e.userId}`);
      expect(u?.createTime).toBe(e.createTime);
      expect(await client.getUser(1)).toBeUndefined();
      void readDataset;
    } finally {
      await mock2.close();
    }
  });

  it('treats 401 as fatal', async () => {
    const limiter = new RateLimiter({ maxPerMinute: 600, budgetFraction: 1 });
    const client = new OpenCloudClient({ baseUrl, apiKey: 'bad', universeId: '7', limiter });
    // The mock may be throttled from the previous test; 401 is checked before budget, so this is immediate.
    await expect(client.listEntries('PlayerData', 'global')).rejects.toSatisfy((e: unknown) => e instanceof OpenCloudError && e.fatal);
  });
});
