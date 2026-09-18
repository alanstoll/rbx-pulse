/**
 * JSON Schema for each config file, derived from the zod schemas so editors can validate
 * and autocomplete YAML (put `# yaml-language-server: $schema=<path>` at the top of a
 * file). `pulse config schema` writes them to schema/; a test keeps the files current.
 */
import { z } from 'zod';
import { constantsSchema, factSchema, flagSchema, gameSchema, milestoneSchema, segmentSchema } from './schema.js';

export const CONFIG_FILES = {
  'game.yaml': gameSchema,
  'facts.yaml': z.array(factSchema),
  'milestones.yaml': z.array(milestoneSchema),
  'flags.yaml': z.array(flagSchema),
  'segments.yaml': z.array(segmentSchema),
  'constants.yaml': constantsSchema,
} as const;

/** Schema file name for a config file: game.yaml -> game.json. */
export const schemaFileName = (configFile: string): string => configFile.replace(/\.yaml$/, '.json');

export function configJsonSchemas(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [file, schema] of Object.entries(CONFIG_FILES)) {
    // io: 'input' describes what the YAML may contain (before defaults and transforms).
    const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    out[schemaFileName(file)] = { $id: `https://github.com/knightav/rbx-pulse/schema/${schemaFileName(file)}`, title: `rbx-pulse ${file}`, ...json };
  }
  return out;
}
