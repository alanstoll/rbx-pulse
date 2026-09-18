import { z } from 'zod';

/** Identifier used for fact, milestone, flag and segment keys. Becomes a SQL column name. */
export const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, 'must be snake_case: lowercase letters, digits, underscores');

export const envelopePreset = z.enum(['raw', 'documentservice']);
export type EnvelopePreset = z.infer<typeof envelopePreset>;

export const timeUnit = z.enum(['seconds', 'millis']);
export type TimeUnit = z.infer<typeof timeUnit>;

/** A mount path: one identifier or a dotted chain of identifiers, e.g. "purchases" or "extras.purchases". */
export const mountPath = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}(\.[a-z][a-z0-9_]{0,62})*$/, 'must be a snake_case identifier or dotted path of identifiers');

/** How a datastore's keys are found on each sync run. */
export const discoveryMode = z.enum(['list', 'index']);
export type DiscoveryMode = z.infer<typeof discoveryMode>;

export const datastoreSyncSchema = z.object({
  /**
   * list: enumerate this store's own keys every run (cheap when the store is sparse).
   * index: fetch it for the players the last-login index reports as active (cheap when
   * the store is dense). Default: index when `sync.index` is configured, else list.
   */
  discovery: discoveryMode.optional(),
  /** Whether `pulse backfill` reads this store's revision history. */
  backfill: z.boolean().default(true),
});

export const datastoreSchema = z.object({
  /** DataStore name as registered in the game. */
  name: z.string().min(1),
  scope: z.string().min(1).default('global'),
  /** Key pattern with a {userId} placeholder, e.g. "Player_{userId}". */
  keyTemplate: z.string().regex(/\{userId\}/, 'keyTemplate must contain {userId}'),
  /** How to unwrap the stored value. */
  envelope: envelopePreset.default('raw'),
  /**
   * Supplemental stores only: path in the root document where this store's unwrapped
   * data appears, so expressions read it as if it were a field of the primary record.
   * Also the default `$stores` key (its last segment).
   */
  mount: mountPath.optional(),
  /** Key of this store under `$stores`. Defaults to the mount's last segment, else the name. */
  alias: identifier.optional(),
  /** Per-store sync behaviour. */
  sync: datastoreSyncSchema.prefault({}),
});
export type DatastoreConfig = z.infer<typeof datastoreSchema>;

/** The `$stores` key for a datastore. */
export function storeAlias(ds: Pick<DatastoreConfig, 'name' | 'alias' | 'mount'>): string {
  return ds.alias ?? ds.mount?.split('.').pop() ?? ds.name;
}

/** Effective key-discovery mode for a datastore: its own setting, else index when one is configured. */
export function discoveryOf(ds: Pick<DatastoreConfig, 'sync'>, game: { sync: { index?: unknown } }): DiscoveryMode {
  return ds.sync.discovery ?? (game.sync.index ? 'index' : 'list');
}

export const syncWindowSchema = z.object({
  /** "HH:MM" local to `timezone`. */
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().default('UTC'),
});

/**
 * Optional last-login index: an OrderedDataStore the game writes on every login with
 * a timestamp value. With it, incremental syncs fetch only players active since the
 * previous completed sync instead of every key.
 */
export const syncIndexSchema = z.object({
  orderedDatastore: z.string().min(1),
  scope: z.string().min(1).default('global'),
  /** Key pattern of the index entries; defaults to "{userId}". */
  keyTemplate: z.string().regex(/\{userId\}/, 'keyTemplate must contain {userId}').default('{userId}'),
  valueUnit: timeUnit.default('seconds'),
  /** Look back this far before the previous sync start, to absorb clock skew and in-flight saves. */
  marginMinutes: z.number().int().nonnegative().default(120),
});

export const syncSchema = z.object({
  index: syncIndexSchema.optional(),
  /** Share of the remaining rate-limit budget this tool may consume. */
  budgetFraction: z.number().gt(0).max(1).default(0.25),
  /** Hard ceiling on requests per minute regardless of budget. */
  maxRequestsPerMinute: z.number().int().positive().default(120),
  concurrency: z.number().int().positive().max(32).default(4),
  /**
   * Negative user ids belong to Studio test players (development servers only).
   * They are never real players, so they are skipped unless this is true.
   */
  includeTestPlayers: z.boolean().default(false),
  /** Optional time-of-day window; outside it, sync pauses. */
  window: syncWindowSchema.optional(),
});

export const gameSchema = z.object({
  universeId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform(String),
  /** Environment variable holding the Open Cloud API key. */
  apiKeyEnv: z.string().min(1).default('ROBLOX_API_KEY'),
  /** Override for tests and the mock server. */
  baseUrl: z.string().regex(/^https?:\/\//, 'must be an http(s) URL').default('https://apis.roblox.com'),
  datastores: z.array(datastoreSchema).min(1),
  sync: syncSchema.prefault({}),
});
export type GameConfig = z.infer<typeof gameSchema>;

export const factShape = z.enum(['scalar', 'keyed', 'events']);
export const factSemantics = z.enum(['counter', 'gauge', 'boolean', 'timestamp', 'label']);

export const factSchema = z
  .object({
    key: identifier,
    description: z.string().optional(),
    /** JSONata expression evaluated against the composite profile. */
    expr: z.string().min(1),
    shape: factShape.default('scalar'),
    semantics: factSemantics.optional(),
    /** Required for timestamp semantics and events shape. */
    unit: timeUnit.optional(),
  })
  .superRefine((f, ctx) => {
    if (f.shape !== 'events' && !f.semantics) {
      ctx.addIssue({ code: 'custom', path: ['semantics'], message: 'semantics is required for scalar and keyed facts' });
    }
    if ((f.semantics === 'timestamp' || f.shape === 'events') && !f.unit) {
      ctx.addIssue({ code: 'custom', path: ['unit'], message: 'unit (seconds|millis) is required for timestamps and events' });
    }
  });
export type FactConfig = z.infer<typeof factSchema>;

export const milestoneSchema = z.object({
  key: identifier,
  description: z.string().optional(),
  /** JSONata condition; truthy means reached. */
  when: z.string().min(1),
  /** Optional JSONata expression yielding the exact time it was reached. */
  at: z.string().min(1).optional(),
  unit: timeUnit.default('seconds'),
});
export type MilestoneConfig = z.infer<typeof milestoneSchema>;

export const flagSchema = milestoneSchema;
export type FlagConfig = z.infer<typeof flagSchema>;

export const segmentSchema = z
  .object({
    key: identifier,
    description: z.string().optional(),
    /** JSONata expression yielding true/false membership. */
    boolean: z.string().min(1).optional(),
    /** JSONata expression yielding a categorical label. */
    label: z.string().min(1).optional(),
  })
  .superRefine((s, ctx) => {
    const n = Number(Boolean(s.boolean)) + Number(Boolean(s.label));
    if (n !== 1) {
      ctx.addIssue({ code: 'custom', message: 'exactly one of `boolean` or `label` is required' });
    }
  });
export type SegmentConfig = z.infer<typeof segmentSchema>;

/** A JSONata variable name (used for constants bindings). camelCase is fine here. */
export const bindingName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid variable name (letters, digits, underscores)');

/** constants.yaml: a map of name -> JSON value, exposed to every expression as $name. */
export const constantsSchema = z.record(bindingName, z.unknown());

export const pulseConfigSchema = z.object({
  game: gameSchema,
  constants: constantsSchema.default({}),
  facts: z.array(factSchema).default([]),
  milestones: z.array(milestoneSchema).default([]),
  flags: z.array(flagSchema).default([]),
  segments: z.array(segmentSchema).default([]),
});
export type PulseConfig = z.infer<typeof pulseConfigSchema>;
