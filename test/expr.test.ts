import { describe, expect, it } from 'vitest';
import { evaluate, compile } from '../src/expr/engine.js';

describe('JSONata helpers', () => {
  it('$size treats [] and {} and missing as empty', async () => {
    expect(await evaluate('$size(a)', { a: [] })).toBe(0);
    expect(await evaluate('$size(a)', { a: {} })).toBe(0);
    expect(await evaluate('$size(a)', {})).toBe(0);
    expect(await evaluate('$size(a)', { a: { x: 1, y: 2 } })).toBe(2);
    expect(await evaluate('$size(a)', { a: [1, 2, 3] })).toBe(3);
  });

  it('$entries tolerates [] for an empty map', async () => {
    expect(await evaluate('$entries(m)', { m: [] })).toEqual([]);
    expect([...((await evaluate('$entries(m).key', { m: { a: 1, b: 2 } })) as string[])]).toEqual(['a', 'b']);
  });

  it('$objects drops false placeholders', async () => {
    const slots = [{ itemId: 'x' }, false, false, { itemId: 'y' }];
    expect(await evaluate('$count($objects(slots))', { slots })).toBe(2);
  });

  it('$has works on arrays and set-like maps', async () => {
    expect(await evaluate('$has(tools, "Shovel")', { tools: ['Torch', 'Shovel'] })).toBe(true);
    expect(await evaluate('$has(areas, "caves")', { areas: { caves: true } })).toBe(true);
    expect(await evaluate('$has(areas, "caves")', { areas: [] })).toBe(false);
  });

  it('$fromUnix converts seconds and millis', async () => {
    expect(await evaluate('$fromUnix(0)', {})).toBeUndefined();
    expect(await evaluate('$fromUnix(1786737517)', {})).toBe('2026-08-14T19:58:37.000Z');
    expect(await evaluate('$fromUnix(1786737517000, "millis")', {})).toBe('2026-08-14T19:58:37.000Z');
  });

  it('compile throws on syntax errors', () => {
    expect(() => compile('a.(')).toThrow();
  });
});
