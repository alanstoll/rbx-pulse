/**
 * Keep the config documentation and the published JSON Schema files in step with the
 * zod schemas that actually validate config.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configJsonSchemas } from '../src/config/json-schema.js';

/** Every property name that appears anywhere in a JSON Schema. */
function propertyNames(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => propertyNames(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'properties' && v && typeof v === 'object') Object.keys(v as object).forEach((p) => out.add(p));
      propertyNames(v, out);
    }
  }
  return out;
}

describe('config documentation', () => {
  const schemas = configJsonSchemas();

  it('schema/*.json match the zod schemas (run `pulse config schema` to refresh)', async () => {
    for (const [name, json] of Object.entries(schemas)) {
      const onDisk = JSON.parse(await readFile(path.resolve('schema', name), 'utf8')) as unknown;
      expect(onDisk, name).toEqual(json);
    }
  });

  it('docs/CONFIG.md mentions every config field', async () => {
    const doc = await readFile(path.resolve('docs/CONFIG.md'), 'utf8');
    const missing = [...propertyNames(schemas)].filter((p) => !doc.includes(`\`${p}\``) && !doc.includes(`\`sync.${p}\``));
    expect(missing).toEqual([]);
  });

  it('docs/EXPRESSIONS.md documents every helper', async () => {
    const { helpers } = await import('../src/expr/engine.js');
    const doc = await readFile(path.resolve('docs/EXPRESSIONS.md'), 'utf8');
    for (const name of Object.keys(helpers)) expect(doc, name).toContain(`$${name}(`);
  });
});
