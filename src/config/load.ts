import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZodType } from 'zod';
import {
  constantsSchema,
  factSchema,
  flagSchema,
  gameSchema,
  milestoneSchema,
  segmentSchema,
  pulseConfigSchema,
  storeAlias,
  type PulseConfig,
} from './schema.js';
import { compile } from '../expr/engine.js';
import { RESERVED_COLUMNS } from '../profile/views.js';

export interface ConfigIssue {
  file: string;
  path: string;
  message: string;
}

export class ConfigError extends Error {
  constructor(public readonly issues: ConfigIssue[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  ${i.file}${i.path ? ` at ${i.path}` : ''}: ${i.message}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const FILES = {
  game: { file: 'game.yaml', schema: gameSchema, required: true, list: false },
  facts: { file: 'facts.yaml', schema: factSchema, required: false, list: true },
  milestones: { file: 'milestones.yaml', schema: milestoneSchema, required: false, list: true },
  flags: { file: 'flags.yaml', schema: flagSchema, required: false, list: true },
  segments: { file: 'segments.yaml', schema: segmentSchema, required: false, list: true },
  constants: { file: 'constants.yaml', schema: constantsSchema, required: false, list: false },
} as const;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readYaml(file: string, issues: ConfigIssue[], name: string): Promise<unknown> {
  try {
    const text = await readFile(file, 'utf8');
    return parseYaml(text) ?? null;
  } catch (err) {
    issues.push({ file: name, path: '', message: `cannot read or parse: ${(err as Error).message}` });
    return undefined;
  }
}

function validate(schema: ZodType, raw: unknown, file: string, issues: ConfigIssue[], prefix = ''): unknown {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    const p = [prefix, ...issue.path.map(String)].filter(Boolean).join('.');
    issues.push({ file, path: p, message: issue.message });
  }
  return undefined;
}

function checkExpr(expr: string, file: string, where: string, issues: ConfigIssue[]): void {
  try {
    compile(expr);
  } catch (err) {
    issues.push({ file, path: where, message: `invalid JSONata: ${(err as Error).message}` });
  }
}

function checkUnique(items: { key: string }[], file: string, issues: ConfigIssue[]): void {
  const seen = new Map<string, number>();
  items.forEach((item, i) => {
    const prev = seen.get(item.key);
    if (prev !== undefined) {
      issues.push({ file, path: `[${i}].key`, message: `duplicate key "${item.key}" (first defined at [${prev}])` });
    } else {
      seen.set(item.key, i);
    }
  });
}

/**
 * Load and validate a config directory. Throws ConfigError listing every problem
 * found, not just the first.
 */
export async function loadConfig(dir: string): Promise<PulseConfig> {
  const issues: ConfigIssue[] = [];
  const raw: Record<string, unknown> = {};

  for (const [section, spec] of Object.entries(FILES)) {
    const file = path.join(dir, spec.file);
    if (!(await exists(file))) {
      if (spec.required) issues.push({ file: spec.file, path: '', message: 'required file is missing' });
      continue;
    }
    const parsed = await readYaml(file, issues, spec.file);
    if (parsed === undefined) continue;

    if (spec.list) {
      if (parsed === null) {
        raw[section] = [];
        continue;
      }
      if (!Array.isArray(parsed)) {
        issues.push({ file: spec.file, path: '', message: 'expected a YAML list' });
        continue;
      }
      const out: unknown[] = [];
      parsed.forEach((item, i) => {
        const v = validate(spec.schema, item, spec.file, issues, `[${i}]`);
        if (v !== undefined) out.push(v);
      });
      raw[section] = out;
    } else {
      const v = validate(spec.schema, parsed ?? {}, spec.file, issues);
      if (v !== undefined) raw[section] = v;
    }
  }

  if (issues.length) throw new ConfigError(issues);

  const config = pulseConfigSchema.parse(raw);

  // Cross-checks: expressions compile, keys unique, datastore aliases and mounts distinct.
  const dsNames = new Set<string>();
  const mounts: string[] = [];
  config.game.datastores.forEach((ds, i) => {
    const alias = storeAlias(ds);
    if (dsNames.has(alias)) {
      issues.push({ file: 'game.yaml', path: `datastores[${i}]`, message: `duplicate datastore alias "${alias}"` });
    }
    dsNames.add(alias);
    if (i === 0) {
      if (ds.mount) issues.push({ file: 'game.yaml', path: `datastores[${i}].mount`, message: 'the first (primary) datastore is the root document and cannot be mounted' });
    } else if (ds.mount) {
      for (const other of mounts) {
        if (other === ds.mount || other.startsWith(`${ds.mount}.`) || ds.mount.startsWith(`${other}.`)) {
          issues.push({ file: 'game.yaml', path: `datastores[${i}].mount`, message: `mount "${ds.mount}" overlaps with mount "${other}"` });
        }
      }
      mounts.push(ds.mount);
    }
    if (ds.sync.discovery === 'index' && !config.game.sync.index) {
      issues.push({ file: 'game.yaml', path: `datastores[${i}].sync.discovery`, message: '"index" discovery requires sync.index (a last-login OrderedDataStore)' });
    }
  });

  for (const name of Object.keys(config.constants)) {
    if (['meta', 'entry', 'stores'].includes(name)) issues.push({ file: 'constants.yaml', path: name, message: 'reserved binding name' });
  }
  checkUnique(config.facts, 'facts.yaml', issues);
  checkUnique([...config.milestones, ...config.flags], 'milestones.yaml/flags.yaml', issues);
  checkUnique(config.segments, 'segments.yaml', issues);
  const factKeys = new Set(config.facts.map((f) => f.key));
  config.segments.forEach((s, i) => {
    if (factKeys.has(s.key)) issues.push({ file: 'segments.yaml', path: `[${i}].key`, message: `"${s.key}" is also a fact key; facts and segments share the wide view's columns` });
    if (RESERVED_COLUMNS.has(s.key)) issues.push({ file: 'segments.yaml', path: `[${i}].key`, message: `"${s.key}" is a reserved column name in the generated views` });
  });

  config.facts.forEach((f, i) => {
    checkExpr(f.expr, 'facts.yaml', `[${i}].expr (${f.key})`, issues);
    if (RESERVED_COLUMNS.has(f.key)) issues.push({ file: 'facts.yaml', path: `[${i}].key`, message: `"${f.key}" is a reserved column name in the generated views` });
  });
  config.milestones.forEach((m, i) => {
    checkExpr(m.when, 'milestones.yaml', `[${i}].when (${m.key})`, issues);
    if (m.at) checkExpr(m.at, 'milestones.yaml', `[${i}].at (${m.key})`, issues);
  });
  config.flags.forEach((m, i) => {
    checkExpr(m.when, 'flags.yaml', `[${i}].when (${m.key})`, issues);
    if (m.at) checkExpr(m.at, 'flags.yaml', `[${i}].at (${m.key})`, issues);
  });
  config.segments.forEach((s, i) => {
    const expr = s.boolean ?? s.label ?? '';
    checkExpr(expr, 'segments.yaml', `[${i}] (${s.key})`, issues);
  });

  if (issues.length) throw new ConfigError(issues);
  return config;
}

/** Resolve the config directory from a CLI flag, env var, or default. */
export function resolveConfigDir(flag?: string): string {
  return path.resolve(flag ?? process.env.PULSE_CONFIG_DIR ?? './config');
}
