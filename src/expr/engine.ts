import jsonata, { type Expression } from 'jsonata';

/**
 * JSONata with a few helpers that smooth over Lua-to-JSON serialization:
 * an empty Lua table arrives as `[]` even where a map is meant, and sparse
 * arrays are padded with `false`.
 */

type JsonValue = unknown;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Number of keys in a map, elements in an array, 0 for empty/missing. */
function size(v: JsonValue): number {
  if (v === undefined || v === null) return 0;
  if (Array.isArray(v)) return v.length;
  if (isPlainObject(v)) return Object.keys(v).length;
  return 1;
}

/** Map -> [{key, value}], tolerating `[]` for an empty map. */
function entries(v: JsonValue): { key: string; value: unknown }[] {
  if (!isPlainObject(v)) return [];
  return Object.entries(v).map(([key, value]) => ({ key, value }));
}

/** Keys of a map, tolerating `[]` for an empty map. */
function keysOf(v: JsonValue): string[] {
  return isPlainObject(v) ? Object.keys(v) : [];
}

/** True if an array (or set-like map) contains the value. */
function has(container: JsonValue, value: unknown): boolean {
  if (Array.isArray(container)) return container.includes(value);
  if (isPlainObject(container)) return Object.prototype.hasOwnProperty.call(container, String(value)) && container[String(value)] !== false;
  return false;
}

/** Elements of an array that are objects (drops `false` placeholders). */
function objects(v: JsonValue): unknown[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isPlainObject);
}

/** Unix seconds (or millis) -> ISO-8601 string. */
function fromUnix(n: unknown, unit: 'seconds' | 'millis' = 'seconds'): string | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  const ms = unit === 'millis' ? n : n * 1000;
  return new Date(ms).toISOString();
}

/** First argument unless it is missing/null, else the fallback. Absent mounts make sums undefined; this turns them into 0. */
function defaultTo(value: unknown, fallback: unknown): unknown {
  return value === undefined || value === null ? fallback : value;
}

/** Register helpers on a compiled expression. */
function registerHelpers(expr: Expression): void {
  expr.registerFunction('size', size);
  expr.registerFunction('entries', entries);
  expr.registerFunction('keysOf', keysOf);
  expr.registerFunction('has', has);
  expr.registerFunction('objects', objects);
  expr.registerFunction('fromUnix', fromUnix);
  expr.registerFunction('default', defaultTo);
}

const cache = new Map<string, Expression>();

/** Compile (and cache) a JSONata expression with helpers registered. Throws on syntax error. */
export function compile(source: string): Expression {
  const cached = cache.get(source);
  if (cached) return cached;
  const expr = jsonata(source);
  registerHelpers(expr);
  cache.set(source, expr);
  return expr;
}

/** Evaluate an expression against an input document. */
export async function evaluate(source: string, input: unknown, bindings?: Record<string, unknown>): Promise<unknown> {
  return compile(source).evaluate(input, bindings);
}

export const helpers = { size, entries, keysOf, has, objects, fromUnix, default: defaultTo };
