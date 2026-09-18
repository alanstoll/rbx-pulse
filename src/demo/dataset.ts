import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DemoEntry } from './generate.js';

/** Demo datasets live as one JSONL file per datastore: <dir>/<datastore>.jsonl */
export function datasetPath(dir: string, datastore: string): string {
  return path.join(dir, `${datastore}.jsonl`);
}

/** Ordered "index" datastores: <dir>/<name>.ordered.jsonl with {key, value} lines. */
export function orderedIndexPath(dir: string, name: string): string {
  return path.join(dir, `${name}.ordered.jsonl`);
}

export async function writeDataset(dir: string, datastore: string, entries: DemoEntry[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = datasetPath(dir, datastore);
  await writeFile(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return file;
}

export async function readDataset(dir: string, datastore: string): Promise<DemoEntry[]> {
  const text = await readFile(datasetPath(dir, datastore), 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim().length)
    .map((l) => JSON.parse(l) as DemoEntry);
}

async function mtime(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

export function datasetMtime(dir: string, datastore: string): Promise<number> {
  return mtime(datasetPath(dir, datastore));
}

export function orderedIndexMtime(dir: string, name: string): Promise<number> {
  return mtime(orderedIndexPath(dir, name));
}

/** Write a last-login style index: one {key, value} line per entry. */
export async function writeOrderedIndex(dir: string, name: string, entries: { key: string; value: number }[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = orderedIndexPath(dir, name);
  await writeFile(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return file;
}

export async function readOrderedIndex(dir: string, name: string): Promise<{ key: string; value: number }[]> {
  const text = await readFile(orderedIndexPath(dir, name), 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim().length)
    .map((l) => JSON.parse(l) as { key: string; value: number });
}

/** Derive the demo's LastLogin index from the records' last-seen timestamps. */
export function lastLoginIndex(entries: DemoEntry[]): { key: string; value: number }[] {
  return entries.map((e) => {
    const v = e.value as { data?: { profile?: { lastSeenAt?: number } }; profile?: { lastSeenAt?: number } };
    const last = v.data?.profile?.lastSeenAt ?? v.profile?.lastSeenAt ?? 0;
    return { key: String(e.userId), value: last };
  });
}
