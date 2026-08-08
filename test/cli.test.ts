import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  createProgram,
  createCliDeps,
  runCheckCommand,
  runBenchCommand,
  type CliDeps,
} from '../src/cli.js';
import { writeDiagnosticsBundle } from '../src/diagnostics.js';
import type { SystemMemoryState } from '../src/probes/types.js';
import { fixtureBackend, fixtureProbe } from './helpers/fixture-backend.js';

describe('createProgram', () => {
  it('names the program llamafit', () => {
    const program = createProgram();
    expect(program.name()).toBe('llamafit');
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
  const bundleDir = mkdtempSync(join(tmpdir(), 'llamafit-cli-test-'));
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
  const bundles = () => readdirSync(bundleDir).filter((f) => f.startsWith('llamafit-diagnostics-'));
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
    expect(bundle.gaps[0].evidence.probed).toEqual(['ollama', 'llama-server']);
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
    // An unknown id is user error, not a gap in llamafit: no prompt, no bundle.
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

  it("each backend's bench hint pins --backend <id>, so copy-pasting it can't autodetect its way to a different backend", async () => {
    const first = fixtureBackend({ id: 'one', displayName: 'Backend One' });
    const second = fixtureBackend({ id: 'two', displayName: 'Backend Two' });
    const detected = async () => [
      { backend: first, detection: { detected: true, version: '0.0.0', evidence: {} } },
      { backend: second, detection: { detected: true, version: '0.0.0', evidence: {} } },
    ];

    const h = harness({ detectBackends: detected });
    await runCheckCommand(CHECK_OPTS, h.deps);
    const out = h.stdout.join('\n');
    expect(out).toContain('llamafit bench');
    expect(out).toContain('--backend one');
    expect(out).toContain('--backend two');
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

  it('one backend throwing warns and is skipped; the other backend still renders and exit stays 0', async () => {
    const good = fixtureBackend({ id: 'good', displayName: 'Good Backend' });
    const bad = fixtureBackend({
      id: 'bad',
      displayName: 'Bad Backend',
      localModels: async () => {
        throw new Error('connection refused');
      },
    });
    const h = harness({
      detectBackends: async () => [
        { backend: bad, detection: { detected: true, version: '0.0.0', evidence: {} } },
        { backend: good, detection: { detected: true, version: '0.0.0', evidence: {} } },
      ],
    });

    await runCheckCommand(CHECK_OPTS, h.deps);

    const err = h.stderr.join('\n');
    expect(err).toContain('Bad Backend');
    expect(err).toContain('connection refused');
    // Only one backend survived, so it renders as the normal single-backend table (no
    // per-backend heading) — the point is that it renders at all instead of being
    // dropped along with the backend that threw.
    const out = h.stdout.join('\n');
    expect(out).toContain('MODEL');
    expect(h.exit.code).toBe(0);
  });

  it('every backend throwing exits 1 and prints nothing on stdout', async () => {
    const first = fixtureBackend({
      id: 'one',
      displayName: 'Backend One',
      localModels: async () => {
        throw new Error('boom one');
      },
    });
    const second = fixtureBackend({
      id: 'two',
      displayName: 'Backend Two',
      localModels: async () => {
        throw new Error('boom two');
      },
    });
    const h = harness({
      detectBackends: async () => [
        { backend: first, detection: { detected: true, version: '0.0.0', evidence: {} } },
        { backend: second, detection: { detected: true, version: '0.0.0', evidence: {} } },
      ],
    });

    await runCheckCommand(CHECK_OPTS, h.deps);

    const err = h.stderr.join('\n');
    expect(err).toContain('boom one');
    expect(err).toContain('boom two');
    expect(h.stdout).toEqual([]);
    expect(h.exit.code).toBe(1);
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

describe('per-backend query default', () => {
  /** Query defaults moved into the backends themselves (each owns its source's
   * default); the CLI just passes --query through, undefined when absent. */
  function setup() {
    const seen: Array<[string, string | undefined]> = [];
    const ollama = fixtureBackend({
      id: 'ollama',
      remoteCandidates: async (q?: string) => {
        seen.push(['ollama', q]);
        return { candidates: [], sources: [] };
      },
    });
    const llamaServer = fixtureBackend({
      id: 'llama-server',
      remoteCandidates: async (q?: string) => {
        seen.push(['llama-server', q]);
        return { candidates: [], sources: [] };
      },
    });
    const h = harness({
      detectBackends: async () => [
        { backend: ollama, detection: { detected: true, version: '0.0.0', evidence: {} } },
        { backend: llamaServer, detection: { detected: true, version: '0.0.0', evidence: {} } },
      ],
    });
    return { seen, h };
  }

  it('passes undefined through when --query is not given (defaults are per-source, in the backend)', async () => {
    const { seen, h } = setup();

    await runCheckCommand({ color: false }, h.deps);

    expect(seen).toContainEqual(['ollama', undefined]);
    expect(seen).toContainEqual(['llama-server', undefined]);
  });

  it('an explicit --query reaches every backend verbatim', async () => {
    const { seen, h } = setup();

    await runCheckCommand({ query: 'qwen', color: false }, h.deps);

    expect(seen).toContainEqual(['ollama', 'qwen']);
    expect(seen).toContainEqual(['llama-server', 'qwen']);
  });
});

describe('bench command wiring', () => {
  const BENCH_OPTS = { color: false };

  it('exits 1 with agent prompt + issue link when no backend is detected', async () => {
    const h = harness({ detectBackends: async () => [] });

    await runBenchCommand('gemma3:12b', BENCH_OPTS, h.deps);

    const err = h.stderr.join('\n');
    expect(h.exit.code).toBe(1);
    expect(err).toContain("doesn't support yet");
    expect(err).toContain('paste this prompt');
    expect(h.stdout).toEqual([]);
  });

  it('--backend with unknown id lists known backends and exits 1 without a bundle', async () => {
    const h = harness({
      allBackends: () => [fixtureBackend({ id: 'ollama' }), fixtureBackend({ id: 'llama-server' })],
      findBackend: () => null,
    });

    await runBenchCommand('gemma3:12b', { ...BENCH_OPTS, backend: 'nope' }, h.deps);

    expect(h.exit.code).toBe(1);
    expect(h.stderr.join('\n')).toContain('unknown backend "nope". Known: ollama, llama-server');
    expect(h.bundles()).toEqual([]);
  });

  it('--backend pins a known backend without requiring detection, and prints the bench result', async () => {
    const backend = fixtureBackend({ id: 'pinned', displayName: 'Pinned' });
    const h = harness({
      findBackend: (id) => (id === 'pinned' ? backend : null),
      detectBackends: async () => {
        throw new Error('detection must not run when --backend is given');
      },
    });

    await runBenchCommand('gemma3:12b', { ...BENCH_OPTS, backend: 'pinned' }, h.deps);

    expect(h.exit.code).toBe(0);
    const out = h.stdout.join('\n');
    expect(out).toContain('Status:');
    expect(out).toContain('completed');
  });

  it('no --backend + multiple detected: benchmarks the first one and names it in an info note, not silently picking one', async () => {
    const calls: string[] = [];
    const first = fixtureBackend({
      id: 'one',
      displayName: 'Backend One',
      pull: async () => {
        calls.push('one');
      },
    });
    const second = fixtureBackend({
      id: 'two',
      displayName: 'Backend Two',
      pull: async () => {
        calls.push('two');
      },
    });
    const h = harness({
      detectBackends: async () => [
        { backend: first, detection: { detected: true, version: '0.0.0', evidence: {} } },
        { backend: second, detection: { detected: true, version: '0.0.0', evidence: {} } },
      ],
    });

    // A model absent from both fixtures' localModels forces a pull, so which backend's
    // pull() fires is directly observable — the exact ambiguity that bit us live: check's
    // hint named one backend's model, but bench's autodetection silently picked another.
    await runBenchCommand('not-locally-present:latest', BENCH_OPTS, h.deps);

    expect(h.stderr.join('\n')).toContain('Multiple backends detected; benchmarking Backend One');
    expect(calls).toEqual(['one']);
  });

  it('skips pull() when the model is already local', async () => {
    let pullCalled = false;
    const backend = fixtureBackend({
      id: 'pinned',
      pull: async () => {
        pullCalled = true;
      },
    });
    const h = harness({ findBackend: () => backend });

    // gemma3:12b is present in the fixture's localModels (test/fixtures/api-tags.json).
    await runBenchCommand('gemma3:12b', { ...BENCH_OPTS, backend: 'pinned' }, h.deps);

    expect(pullCalled).toBe(false);
    expect(h.exit.code).toBe(0);
  });

  it('pulls the model when it is not already local', async () => {
    let pullCalled = false;
    const backend = fixtureBackend({
      id: 'pinned',
      pull: async () => {
        pullCalled = true;
      },
    });
    const h = harness({ findBackend: () => backend });

    await runBenchCommand('not-locally-present:latest', { ...BENCH_OPTS, backend: 'pinned' }, h.deps);

    expect(pullCalled).toBe(true);
    expect(h.exit.code).toBe(0);
  });

  it('omits the model-page link for a non-ollama backend, and includes one for ollama', async () => {
    const nonOllama = fixtureBackend({ id: 'llama-server' });
    const h1 = harness({ findBackend: () => nonOllama });
    await runBenchCommand('gemma3:12b', { ...BENCH_OPTS, backend: 'llama-server' }, h1.deps);
    expect(h1.stdout.join('\n')).not.toContain('http');

    const ollama = fixtureBackend({ id: 'ollama' });
    const h2 = harness({ findBackend: () => ollama });
    await runBenchCommand('gemma3:12b', { ...BENCH_OPTS, backend: 'ollama' }, h2.deps);
    expect(h2.stdout.join('\n')).toContain('https://ollama.com/library/gemma3');
  });

  it('a failure mid-run (e.g. pull rejects) prints the error and exits 1, without a half-printed result', async () => {
    const backend = fixtureBackend({
      id: 'pinned',
      pull: async () => {
        throw new Error('pull model manifest: file does not exist');
      },
    });
    const h = harness({ findBackend: () => backend });

    await runBenchCommand('not-locally-present:latest', { ...BENCH_OPTS, backend: 'pinned' }, h.deps);

    expect(h.exit.code).toBe(1);
    expect(h.stderr.join('\n')).toContain('pull model manifest: file does not exist');
    expect(h.stdout).toEqual([]);
  });
});
