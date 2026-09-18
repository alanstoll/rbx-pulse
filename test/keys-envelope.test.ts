import { describe, expect, it } from 'vitest';
import { KeyTemplate } from '../src/keys.js';
import { detectEnvelope, unwrap } from '../src/envelope/index.js';

describe('KeyTemplate', () => {
  it('builds and parses', () => {
    const t = new KeyTemplate('Player_{userId}');
    expect(t.build(12345)).toBe('Player_12345');
    expect(t.parse('Player_12345')).toBe(12345);
    expect(t.parse('Other_1')).toBeUndefined();
    expect(t.parse('Player_abc')).toBeUndefined();
    expect(new KeyTemplate('{userId}').parse('-10')).toBe(-10);
    expect(new KeyTemplate('{userId}').parse('1779826131')).toBe(1779826131);
    expect(t.prefix).toBe('Player_');
  });

  it('escapes regex characters in the template', () => {
    const t = new KeyTemplate('u.{userId}.v1');
    expect(t.parse('u.7.v1')).toBe(7);
    expect(t.parse('uX7Xv1')).toBeUndefined();
  });
});

describe('envelopes', () => {
  const ds = { data: { a: 1 }, documentServiceSchemaVersion: 0, dataSchemaVersion: 3, lockTimestamp: 1789661566, isLocked: false, sessionLockId: 'x', lastCompatibleVersion: 0 };

  it('detects DocumentService', () => {
    expect(detectEnvelope(ds)).toBe('documentservice');
    expect(detectEnvelope({ a: 1 })).toBe('raw');
  });

  it('unwraps DocumentService and lifts metadata', () => {
    const u = unwrap('documentservice', ds);
    expect(u.data).toEqual({ a: 1 });
    expect(u.meta).toMatchObject({ dataSchemaVersion: 3, lockTimestamp: 1789661566 });
  });

  it('raw is identity', () => {
    expect(unwrap('raw', { a: 1 })).toEqual({ data: { a: 1 }, meta: {} });
  });

  it('rejects a non-envelope for documentservice', () => {
    expect(() => unwrap('documentservice', { a: 1 })).toThrow(/not a DocumentService envelope/);
  });
});
