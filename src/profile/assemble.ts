/**
 * Composite profile versions. A player's profile is the latest snapshot of each
 * configured datastore. A new version is cut whenever any component changes.
 *
 * Versions are ordered by the time the state was written (Roblox's revision time),
 * falling back to the local observation time. That keeps synced and backfilled
 * snapshots on one consistent clock. The observation time is carried separately: it
 * is the latest moment we know the previous state still held, hence the lower bound
 * for "when did this change happen".
 */

export interface SnapshotRef {
  id: number;
  datastore: string;
  observedAt: Date;
  revisionCreatedAt: Date | null;
}

export interface ComposedVersion {
  versionNo: number;
  components: Record<string, number>;
  maxSnapshotId: number;
  /** When this state began: the triggering snapshot's revision time (or observation time). */
  validFrom: Date;
  validTo: Date | null;
  /** When we observed this state (for backfilled snapshots, equal to the revision time). */
  observedAt: Date;
  revisionCreatedAt: Date | null;
}

const startOf = (s: SnapshotRef): number => (s.revisionCreatedAt ?? s.observedAt).getTime();

/**
 * Pure: turn a player's snapshots (any order) into the ordered version sequence.
 * With `primary` given, no version exists before the first primary snapshot:
 * supplemental snapshots written earlier are carried into that first version.
 */
export function composeVersions(snapshots: SnapshotRef[], primary?: string): ComposedVersion[] {
  const sorted = [...snapshots].sort((a, b) => startOf(a) - startOf(b) || a.id - b.id);
  const latest = new Map<string, SnapshotRef>();
  const versions: ComposedVersion[] = [];
  let prevKey = '';
  for (const s of sorted) {
    latest.set(s.datastore, s);
    if (primary !== undefined && !latest.has(primary)) continue;
    const components: Record<string, number> = {};
    for (const ds of [...latest.keys()].sort()) components[ds] = latest.get(ds)!.id;
    const key = JSON.stringify(components);
    if (key === prevKey) continue;
    prevKey = key;
    let rev: Date | null = null;
    for (const ref of latest.values()) {
      if (ref.revisionCreatedAt && (!rev || ref.revisionCreatedAt > rev)) rev = ref.revisionCreatedAt;
    }
    const validFrom = new Date(startOf(s));
    const prev = versions[versions.length - 1];
    if (prev) prev.validTo = validFrom;
    versions.push({
      versionNo: versions.length + 1,
      components,
      maxSnapshotId: Math.max(...Object.values(components)),
      validFrom,
      validTo: null,
      observedAt: s.observedAt,
      revisionCreatedAt: rev,
    });
  }
  return versions;
}

/** Key-order-independent identity of a component map (JSONB returns keys in its own order). */
const componentsKey = (c: Record<string, number>): string =>
  Object.keys(c)
    .sort()
    .map((k) => `${k}=${c[k]}`)
    .join(',');

/** True when `existing` (ordered by version_no) is a prefix of `computed`. */
export function isPrefix(existing: { versionNo: number; components: Record<string, number> }[], computed: ComposedVersion[]): boolean {
  if (existing.length > computed.length) return false;
  return existing.every((e, i) => e.versionNo === computed[i]!.versionNo && componentsKey(e.components) === componentsKey(computed[i]!.components));
}
