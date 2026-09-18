import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/load.js';

const DEMO = path.resolve('examples/demo-game/config');

describe('config loading', () => {
  it('loads the demo config', async () => {
    const cfg = await loadConfig(DEMO);
    expect(cfg.game.universeId).toBe('1');
    expect(cfg.game.datastores[0]?.envelope).toBe('documentservice');
    expect(cfg.facts.length).toBeGreaterThan(10);
    expect(cfg.milestones.map((m) => m.key)[0]).toBe('finished_tutorial');
    expect(cfg.segments.find((s) => s.key === 'join_week')?.label).toBeTruthy();
  });

  it('reports every problem, with file and path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pulse-cfg-'));
    await writeFile(
      path.join(dir, 'game.yaml'),
      ['universeId: 1', 'datastores:', '  - name: PlayerData', '    keyTemplate: "NoPlaceholder"', ''].join('\n'),
    );
    await writeFile(
      path.join(dir, 'facts.yaml'),
      ['- key: BadKey', '  expr: a.b', '- key: ts', '  semantics: timestamp', '  expr: "a.("', ''].join('\n'),
    );
    await writeFile(path.join(dir, 'segments.yaml'), ['- key: s', '  boolean: a', '  label: b', ''].join('\n'));

    let err: ConfigError | undefined;
    try {
      await loadConfig(dir);
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msgs = err!.issues.map((i) => `${i.file}:${i.path}:${i.message}`).join('\n');
    expect(msgs).toContain('game.yaml:datastores.0.keyTemplate');
    expect(msgs).toContain('facts.yaml:[0].key');
    expect(msgs).toContain('facts.yaml:[0].semantics');
    expect(msgs).toContain('facts.yaml:[1].unit');
    expect(msgs).toContain('segments.yaml:[0]');
  });

  it('catches bad JSONata after structural validation passes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pulse-cfg-'));
    await writeFile(path.join(dir, 'game.yaml'), ['universeId: 1', 'datastores:', '  - name: D', '    keyTemplate: "P_{userId}"', ''].join('\n'));
    await writeFile(path.join(dir, 'facts.yaml'), ['- key: x', '  semantics: gauge', '  expr: "a.("', '- key: x', '  semantics: gauge', '  expr: b', ''].join('\n'));
    const err = await loadConfig(dir).catch((e: unknown) => e as ConfigError);
    expect(err).toBeInstanceOf(ConfigError);
    const text = (err as ConfigError).message;
    expect(text).toMatch(/invalid JSONata/);
    expect(text).toMatch(/duplicate key "x"/);
  });

  it('rejects a segment key that is also a fact key', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pulse-cfg-'));
    await writeFile(path.join(dir, 'game.yaml'), ['universeId: 1', 'datastores:', '  - name: D', '    keyTemplate: "P_{userId}"', ''].join('\n'));
    await writeFile(path.join(dir, 'facts.yaml'), ['- key: premium', '  semantics: boolean', '  expr: a', ''].join('\n'));
    await writeFile(path.join(dir, 'segments.yaml'), ['- key: premium', '  boolean: a', '- key: valid_to', '  boolean: a', ''].join('\n'));
    const err = await loadConfig(dir).catch((e: unknown) => e as ConfigError);
    expect((err as ConfigError).message).toMatch(/also a fact key/);
    expect((err as ConfigError).message).toMatch(/reserved column/);
  });

  it('requires game.yaml', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pulse-cfg-'));
    await expect(loadConfig(dir)).rejects.toThrow(/game.yaml: required file is missing/);
  });
});
