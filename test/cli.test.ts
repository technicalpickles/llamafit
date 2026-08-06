import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  createProgram,
  createCliDeps,
  runCheckCommand,
  type CliDeps,
} from '../src/cli.js';
import { writeDiagnosticsBundle } from '../src/diagnostics.js';
import type { SystemMemoryState } from '../src/probes/types.js';
import { fixtureBackend, fixtureProbe } from './helpers/fixture-backend.js';

describe('createProgram', () => {
  it('names the program ollama-scope', () => {
    const program = createProgram();
    expect(program.name()).toBe('ollama-scope');
  });

  it('has a non-empty description', () => {
    const program = createProgram();
    expect(program.description().length).toBeGreaterThan(0);
  });
});

describe('createProgram subcommands', () => {
  it('registers a check command with --json and --query options', () => {
    const program = createProgram();
    const check = program.commands.find((c) => c.name() === 'check');
    expect(check).toBeDefined();
    const optionNames = check!.options.map((o) => o.long);
    expect(optionNames).toContain('--json');
    expect(optionNames).toContain('--query');
    expect(optionNames).toContain('--backend');
    expect(optionNames).toContain('--diagnose');
  });

  it('registers a bench command requiring a model argument', () => {
    const program = createProgram();
    const bench = program.commands.find((c) => c.name() === 'bench');
    expect(bench).toBeDefined();
    expect(bench!.registeredArguments.length).toBeGreaterThan(0);
    expect(bench!.options.map((o) => o.long)).toContain('--backend');
  });
});

const SYSTEM: SystemMemoryState = {
  totalGb: 24,
  usedGb: 12.5,
  wiredGb: 3.2,
  compressorGb: 1.1,
  unusedGb: 0.4,
  swapTotalGb: 2,
  swapUsedGb: 0.5,
  swapFreeGb: 1.5,
};

/** Every bundle written by a test lands in its own temp dir — never the repo cwd. */
function harness(overrides: Partial<CliDeps> = {}) {
  const bundleDir = mkdtempSync(join(tmpdir(), 'llmfit-cli-test-'));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = { code: 0 };
  const deps = createCliDeps({
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    setExitCode: (code) => {
      exit.code = code;
    },
    writeBundle: (input) => writeDiagnosticsBundle(input, { dir: bundleDir }),
    selectProbe: () => fixtureProbe(SYSTEM),
    ...overrides,
  });
  const bundles = () => readdirSync(bundleDir).filter((f) => f.startsWith('llmfit-diagnostics-'));
  return { deps, stdout, stderr, exit, bundleDir, bundles };
}

const CHECK_OPTS = { query: 'mlx', color: false };

describe('check command wiring', () => {
  it('exits 1 with agent prompt + issue link when no backend is detected', async () => {
    const h = harness({ detectBackends: async () => [] });

    await runCheckCommand(CHECK_OPTS, h.deps);

    const err = h.stderr.join('\n');
    expect(h.exit.code).toBe(1);
    expect(err).toContain("doesn't support yet");
    expect(err).toContain('paste this prompt');
    expect(err).toContain('issues/new?');
    expect(h.bundles()).toHaveLength(1);
    const bundle = JSON.parse(readFileSync(join(h.bundleDir, h.bundles()[0]), 'utf8'));
    expect(bundle.gaps[0].kind).toBe('no-backend-detected');
    expect(bundle.gaps[0].evidence.probed).toEqual(['ollama']);
    // Nothing on stdout: a failed run must not emit a half-table into a pipeline.
    expect(h.stdout).toEqual([]);
  });

  it('--backend with unknown id lists known backends and exits 1 without a bundle', async () => {
    const h = harness({
      allBackends: () => [fixtureBackend()],
      findBackend: () => null,
    });

    await runCheckCommand({ ...CHECK_OPTS, backend: 'vllm' }, h.deps);

    const err = h.stderr.join('\n');
    expect(h.exit.code).toBe(1);
    expect(err).toContain('vllm');
    expect(err).toContain('fixture');
    // An unknown id is user error, not a gap in llmfit: no prompt, no bundle.
    expect(err).not.toContain('paste this prompt');
    expect(h.bundles()).toEqual([]);
  });

  it('unknown platform produces unsupported-platform prompt', async () => {
    const h = harness({ selectProbe: () => null, platform: 'freebsd' });

    await runCheckCommand(CHECK_OPTS, h.deps);

    const err = h.stderr.join('\n');
    expect(h.exit.code).toBe(1);
    expect(err).toContain('add support for my platform');
    expect(err).toContain('issues/new?');
    expect(h.bundles()).toHaveLength(1);
    const bundle = JSON.parse(readFileSync(join(h.bundleDir, h.bundles()[0]), 'utf8'));
    expect(bundle.gaps[0].kind).toBe('unsupported-platform');
    expect(bundle.platform.platform).toBe('freebsd');
    // No probe ran, so there is no probe evidence to attach.
    expect(bundle.probeEvidence).toBeNull();
  });

  it('--diagnose writes a bundle even when nothing failed', async () => {
    const backend = fixtureBackend();
    const h = harness({
      detectBackends: async () => [
        { backend, detection: { detected: true, version: '0.0.0', evidence: {} } },
      ],
    });

    await runCheckCommand({ ...CHECK_OPTS, diagnose: true }, h.deps);

    expect(h.exit.code).toBe(0);
    expect(h.stdout.join('\n')).toContain('MODEL');
    expect(h.bundles()).toHaveLength(1);
    const bundle = JSON.parse(readFileSync(join(h.bundleDir, h.bundles()[0]), 'utf8'));
    expect(bundle.gaps).toEqual([]);
    expect(h.stderr.join('\n')).toContain(join(h.bundleDir));
  });

  it('a single backend prints the bare table with no backend heading', async () => {
    const backend = fixtureBackend();
    const h = harness({
      detectBackends: async () => [
        { backend, detection: { detected: true, version: '0.0.0', evidence: {} } },
      ],
    });

    await runCheckCommand(CHECK_OPTS, h.deps);

    expect(h.exit.code).toBe(0);
    expect(h.stdout).toHaveLength(1);
    expect(h.stdout[0].startsWith('MODEL')).toBe(true);
  });

  it('multiple backends get a heading per table, and a keyed object in --json', async () => {
    const first = fixtureBackend({ id: 'one', displayName: 'Backend One' });
    const second = fixtureBackend({ id: 'two', displayName: 'Backend Two' });
    const detected = async () => [
      { backend: first, detection: { detected: true, version: '0.0.0', evidence: {} } },
      { backend: second, detection: { detected: true, version: '0.0.0', evidence: {} } },
    ];

    const table = harness({ detectBackends: detected });
    await runCheckCommand(CHECK_OPTS, table.deps);
    expect(table.stdout[0]).toBe('Backend One');
    expect(table.stdout[1]).toBe('');
    expect(table.stdout[3]).toBe('Backend Two');

    const json = harness({ detectBackends: detected });
    await runCheckCommand({ ...CHECK_OPTS, json: true }, json.deps);
    const parsed = JSON.parse(json.stdout.join('\n'));
    expect(Object.keys(parsed)).toEqual(['one', 'two']);
    expect(parsed.one.rows.length).toBeGreaterThan(0);
  });

  it('a failed remote scrape warns and continues: no bundle, no prompts, exit 0', async () => {
    const backend = fixtureBackend({
      remoteCandidates: async () => {
        throw new Error('getaddrinfo ENOTFOUND ollama.com');
      },
    });
    const h = harness({
      detectBackends: async () => [
        { backend, detection: { detected: true, version: '0.0.0', evidence: {} } },
      ],
    });

    await runCheckCommand(CHECK_OPTS, h.deps);

    const err = h.stderr.join('\n');
    expect(h.exit.code).toBe(0);
    expect(err).toContain('Could not fetch remote model list');
    // A flaky network is not a missing feature: no funnel, and nothing dropped in the cwd.
    expect(err).not.toContain('paste this prompt');
    expect(err).not.toContain('issues/new?');
    expect(err).not.toContain("doesn't support yet");
    expect(h.bundles()).toEqual([]);
    expect(h.stdout.join('\n')).toContain('MODEL');
  });

  it('--diagnose still records a scrape failure in the bundle, without prompting for it', async () => {
    const backend = fixtureBackend({
      remoteCandidates: async () => {
        throw new Error('getaddrinfo ENOTFOUND ollama.com');
      },
    });
    const h = harness({
      detectBackends: async () => [
        { backend, detection: { detected: true, version: '0.0.0', evidence: {} } },
      ],
    });

    await runCheckCommand({ ...CHECK_OPTS, diagnose: true }, h.deps);

    expect(h.exit.code).toBe(0);
    expect(h.bundles()).toHaveLength(1);
    const bundle = JSON.parse(readFileSync(join(h.bundleDir, h.bundles()[0]), 'utf8'));
    expect(bundle.gaps.map((g: { kind: string }) => g.kind)).toEqual(['scrape-failed']);
    expect(h.stderr.join('\n')).not.toContain('paste this prompt');
  });

  it('an unwritable bundle degrades to a friendly error, leaving a good check at exit 0', async () => {
    const backend = fixtureBackend();
    const h = harness({
      detectBackends: async () => [
        { backend, detection: { detected: true, version: '0.0.0', evidence: {} } },
      ],
      writeBundle: () => {
        throw new Error('EROFS: read-only file system');
      },
    });

    await runCheckCommand({ ...CHECK_OPTS, diagnose: true }, h.deps);

    const err = h.stderr.join('\n');
    expect(err).toContain('Error:');
    expect(err).toContain('could not write the diagnostics bundle');
    expect(err).toContain('EROFS');
    // The table printed and the check itself succeeded, so the run is still a success.
    expect(h.stdout.join('\n')).toContain('MODEL');
    expect(h.exit.code).toBe(0);
  });

  it('an unwritable bundle on a failed run still exits 1 with a friendly error', async () => {
    const h = harness({
      detectBackends: async () => [],
      writeBundle: () => {
        throw new Error('EROFS: read-only file system');
      },
    });

    await runCheckCommand(CHECK_OPTS, h.deps);

    expect(h.exit.code).toBe(1);
    expect(h.stderr.join('\n')).toContain('could not write the diagnostics bundle');
  });

  it('a throwing registry is contained as a friendly error, not an unhandled rejection', async () => {
    const h = harness({
      detectBackends: async () => {
        throw new Error('registry exploded');
      },
    });

    await expect(runCheckCommand(CHECK_OPTS, h.deps)).resolves.toBeUndefined();

    expect(h.exit.code).toBe(1);
    expect(h.stderr.join('\n')).toContain('registry exploded');
    expect(h.stderr.join('\n')).toContain('Error:');
  });

  it('--backend pins a known backend without requiring detection', async () => {
    const backend = fixtureBackend({ id: 'pinned', displayName: 'Pinned' });
    const h = harness({
      findBackend: (id) => (id === 'pinned' ? backend : null),
      detectBackends: async () => {
        throw new Error('detection must not run when --backend is given');
      },
    });

    await runCheckCommand({ ...CHECK_OPTS, backend: 'pinned' }, h.deps);

    expect(h.exit.code).toBe(0);
    expect(h.stdout).toHaveLength(1);
  });
});
