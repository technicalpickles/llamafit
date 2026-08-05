#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { arch, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { runCheck, type CheckResult } from './check.js';
import { runBench, normalizeModelTarget, GENERATE_TIMEOUT_MS } from './bench.js';
import { selectProbe } from './probes/registry.js';
import { allBackends, findBackend, detectBackends } from './backends/registry.js';
import type { Backend } from './backends/types.js';
import type { SystemProbe } from './probes/types.js';
import type { Detection, ModelInfo } from './types.js';
import { formulaEstimator } from './estimators/formula.js';
import { GapCollector } from './gaps.js';
import { writeDiagnosticsBundle, type DiagnosticsInput } from './diagnostics.js';
import { agentPromptFor, issueUrlFor, repoUrl } from './prompts.js';
import { formatCheckTable, formatCheckJson, formatBenchResult } from './format.js';
import { shouldUseColor, success, warn, error, info, label } from './colors.js';
import { startSpinner } from './progress.js';

/** Printed once before any of the slow steps start, so the user knows what's about to
 * happen (and how long the generate step is allowed to run) instead of guessing from a
 * bare model name whether the tool is about to sit idle downloading gigabytes. */
function describeBenchPlan(model: string, existing: ModelInfo | undefined): string[] {
  const details = existing
    ? (() => {
        const params =
          existing.parameterSizeB !== null
            ? `${existing.parameterSizeB.toFixed(1)}B params`
            : 'params unknown';
        const quant = existing.quantizationLevel || 'quant unknown';
        return `${params}, ${quant}, already pulled locally`;
      })()
    : 'not pulled locally yet, will download first';

  const seconds = Math.round(GENERATE_TIMEOUT_MS / 1000);
  return [
    `Benchmarking ${model} — ${details}`,
    `Will generate a test response (times out after ${seconds}s), measure memory/VRAM impact, then unload`,
  ];
}

/** Wraps the slow, silent steps (pull can take minutes; generate can take up to its
 * timeout) with a spinner on stderr, so stdout stays just the final result. Only wraps
 * the optional pull/unload capabilities when the backend actually has them — passing
 * everything else (including the always-present generate) through untouched. */
function withProgress(backend: Backend, color: boolean): Backend {
  const pull = backend.pull;
  const unload = backend.unload;
  return {
    ...backend,
    pull: pull
      ? async (model) => {
          const startedAt = Date.now();
          const spinner = startSpinner(`Pulling ${model}...`);
          try {
            await pull(model);
          } catch (err) {
            spinner.stop();
            throw err;
          }
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          spinner.stop(success(`Pulled ${model} (${elapsed}s)`, color));
        }
      : undefined,
    generate: async (model, prompt, timeoutMs) => {
      const seconds = Math.round((timeoutMs ?? 90_000) / 1000);
      const startedAt = Date.now();
      const spinner = startSpinner(`Generating (times out after ${seconds}s)...`);
      let response;
      try {
        response = await backend.generate(model, prompt, timeoutMs);
      } catch (err) {
        spinner.stop();
        throw err;
      }
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      spinner.stop(
        response
          ? success(`Generated response (${elapsed}s)`, color)
          : warn(`Generation timed out after ${seconds}s`, color)
      );
      return response;
    },
    unload: unload
      ? async (model) => {
          const spinner = startSpinner(`Unloading ${model}...`);
          try {
            await unload(model);
          } finally {
            spinner.stop();
          }
        }
      : undefined,
  };
}

function packageVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
}

/**
 * Everything the command bodies touch that isn't pure computation: the registries they
 * resolve against, the machine they describe, and the three ways they talk to the outside
 * world. Injected rather than imported so the tests can drive a whole command end to end
 * (including the diagnostics bundle, which lands in a temp dir instead of the user's cwd).
 */
export interface CliDeps {
  platform: string;
  osRelease: string;
  osArch: string;
  version: string;
  selectProbe(platform: string): SystemProbe | null;
  allBackends(): Backend[];
  findBackend(id: string): Backend | null;
  detectBackends(): Promise<Array<{ backend: Backend; detection: Detection }>>;
  writeBundle(input: DiagnosticsInput): string;
  repoUrl(): string;
  stdout(line: string): void;
  stderr(line: string): void;
  setExitCode(code: number): void;
}

export function createCliDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    platform: process.platform,
    osRelease: release(),
    osArch: arch(),
    version: packageVersion(),
    selectProbe,
    allBackends,
    findBackend,
    detectBackends: () => detectBackends(),
    writeBundle: (input) => writeDiagnosticsBundle(input),
    repoUrl,
    stdout: (line) => console.log(line),
    // Everything advisory goes to stderr so stdout stays a pipeable table/JSON document.
    stderr: (line) => console.error(line),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    ...overrides,
  };
}

/**
 * Writes the diagnostics bundle and prints, per gap, the two ways a user can get the gap
 * closed: a prompt to hand an AI agent, and a pre-filled issue. Called after a failed
 * resolution, after a successful run that recorded gaps, and unconditionally by --diagnose.
 */
async function reportGaps(
  gaps: GapCollector,
  probe: SystemProbe | null,
  deps: CliDeps,
  color: boolean
): Promise<void> {
  const list = gaps.list();
  const bundlePath = deps.writeBundle({
    version: deps.version,
    platform: { platform: deps.platform, release: deps.osRelease, arch: deps.osArch },
    gaps: list,
    probeEvidence: probe ? await probe.describe() : null,
  });

  if (list.length === 0) {
    // The --diagnose-on-a-clean-run case: there is nothing to prompt about, but the user
    // asked for the bundle, so say where it went and stop.
    deps.stderr(info(`Diagnostics written to ${bundlePath}`, color));
    return;
  }

  deps.stderr(
    warn(
      `Hit ${list.length} thing(s) llmfit doesn't support yet — diagnostics written to ${bundlePath}`,
      color
    )
  );
  const repo = deps.repoUrl();
  for (const gap of list) {
    deps.stderr('');
    deps.stderr(label('To add support with an AI agent, paste this prompt:', color));
    deps.stderr(agentPromptFor(gap, { bundlePath, repoUrl: repo }));
    deps.stderr(label('Or file it:', color));
    deps.stderr(issueUrlFor(gap, { repoUrl: repo }));
  }
}

type Resolution =
  | { ok: true; probe: SystemProbe; backends: Backend[] }
  /** Gaps are already in the collector; the caller runs the gap exit. */
  | { ok: false; probe: SystemProbe | null; reportGaps: true }
  /** User error (a typo'd --backend id): message already printed, nothing to diagnose. */
  | { ok: false; probe: SystemProbe | null; reportGaps: false };

/** Shared by check and bench: a probe for this platform, plus the backend(s) to run against. */
async function resolve(
  backendId: string | undefined,
  gaps: GapCollector,
  deps: CliDeps,
  color: boolean
): Promise<Resolution> {
  const probe = deps.selectProbe(deps.platform);
  if (!probe) {
    // Without memory numbers there is nothing to classify against, so this ends the run.
    gaps.add({
      kind: 'unsupported-platform',
      summary: `no SystemProbe for ${deps.platform}`,
      evidence: { platform: deps.platform, release: deps.osRelease, arch: deps.osArch },
    });
    return { ok: false, probe: null, reportGaps: true };
  }

  if (backendId !== undefined) {
    const backend = deps.findBackend(backendId);
    if (!backend) {
      const known = deps
        .allBackends()
        .map((b) => b.id)
        .join(', ');
      deps.stderr(
        error(`${label('Error:', color)} unknown backend "${backendId}". Known: ${known}`, color)
      );
      return { ok: false, probe, reportGaps: false };
    }
    // Pinning is explicit user intent, so detection is skipped entirely — a connection
    // failure surfaces as a normal error from the run itself, not as "no backend detected".
    return { ok: true, probe, backends: [backend] };
  }

  const detected = await deps.detectBackends();
  if (detected.length === 0) {
    gaps.add({
      kind: 'no-backend-detected',
      summary: 'no supported inference backend found',
      evidence: { probed: deps.allBackends().map((b) => b.id) },
    });
    return { ok: false, probe, reportGaps: true };
  }
  return { ok: true, probe, backends: detected.map((d) => d.backend) };
}

export interface CheckCommandOptions {
  query: string;
  color: boolean;
  json?: boolean;
  backend?: string;
  diagnose?: boolean;
}

export async function runCheckCommand(opts: CheckCommandOptions, deps: CliDeps): Promise<void> {
  const color = opts.color;
  const gaps = new GapCollector();

  const resolved = await resolve(opts.backend, gaps, deps, color);
  if (!resolved.ok) {
    if (resolved.reportGaps) await reportGaps(gaps, resolved.probe, deps, color);
    deps.setExitCode(1);
    return;
  }

  const results: Array<{ backend: Backend; result: CheckResult }> = [];
  try {
    for (const backend of resolved.backends) {
      results.push({
        backend,
        result: await runCheck(opts.query, {
          backend,
          probe: resolved.probe,
          estimator: formulaEstimator,
          gaps,
        }),
      });
    }
  } catch (err) {
    deps.stderr(error(`${label('Error:', color)} ${(err as Error).message}`, color));
    deps.setExitCode(1);
    return;
  }

  // Spec's Error Handling section: a failed remote scrape warns on stderr and
  // continues, so the table on stdout stays machine-pipeable.
  for (const { result } of results) {
    if (result.scrapeWarning) {
      deps.stderr(warn(`${label('Warning:', color)} ${result.scrapeWarning}`, color));
    }
  }

  const multiple = results.length > 1;
  if (opts.json) {
    // One backend keeps emitting a bare CheckResult, so existing `check --json` consumers
    // are untouched; only the genuinely ambiguous multi-backend case gets keyed by id.
    deps.stdout(
      multiple
        ? JSON.stringify(
            Object.fromEntries(results.map(({ backend, result }) => [backend.id, result])),
            null,
            2
          )
        : formatCheckJson(results[0].result)
    );
  } else {
    for (const { backend, result } of results) {
      if (multiple) {
        deps.stdout(label(backend.displayName, color));
        deps.stdout('');
      }
      deps.stdout(formatCheckTable(result, { color }));
    }
  }

  if (gaps.list().length > 0 || opts.diagnose) {
    await reportGaps(gaps, resolved.probe, deps, color);
  }
}

export interface BenchCommandOptions {
  color: boolean;
  backend?: string;
}

export async function runBenchCommand(
  model: string,
  opts: BenchCommandOptions,
  deps: CliDeps
): Promise<void> {
  const color = opts.color;
  const gaps = new GapCollector();

  const resolved = await resolve(opts.backend, gaps, deps, color);
  if (!resolved.ok) {
    if (resolved.reportGaps) await reportGaps(gaps, resolved.probe, deps, color);
    deps.setExitCode(1);
    return;
  }

  // A benchmark measures one backend's real memory impact at a time; running several at
  // once would have them contaminating each other's readings.
  const [backend] = resolved.backends;
  if (resolved.backends.length > 1) {
    deps.stderr(
      info(`Multiple backends detected; benchmarking ${backend.displayName} (use --backend to pick another)`, color)
    );
  }

  try {
    const target = normalizeModelTarget(model);
    const { models: local } = await backend.localModels();
    const existing = local.find((m) => m.name === target);
    for (const line of describeBenchPlan(model, existing)) {
      deps.stderr(info(line, color));
    }
    const result = await runBench(model, {
      backend: withProgress(backend, color),
      probe: resolved.probe,
    });
    deps.stdout(formatBenchResult(result, { color }));
  } catch (err) {
    deps.stderr(error(`${label('Error:', color)} ${(err as Error).message}`, color));
    deps.setExitCode(1);
    return;
  }

  if (gaps.list().length > 0) {
    await reportGaps(gaps, resolved.probe, deps, color);
  }
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name('ollama-scope')
    .description("Right-size Ollama models for this machine's memory and quantization");

  program
    .command('check')
    .description('Static analysis: which models fit this machine right now (no models are loaded)')
    .option('--json', 'output as JSON')
    .option('-q, --query <query>', 'remote search query on ollama.com', 'mlx')
    .option('--no-color', 'disable colored output')
    .option('--backend <id>', 'use a specific backend instead of detecting them')
    .option('--diagnose', 'write a diagnostics bundle even when nothing failed')
    .action(
      async (opts: {
        json?: boolean;
        query: string;
        color: boolean;
        backend?: string;
        diagnose?: boolean;
      }) => {
        await runCheckCommand(
          {
            query: opts.query,
            color: shouldUseColor({ noColorFlag: !opts.color }),
            json: opts.json,
            backend: opts.backend,
            diagnose: opts.diagnose,
          },
          createCliDeps()
        );
      }
    );

  program
    .command('bench')
    .argument('<model>', 'model name to benchmark (will be pulled if not already present)')
    .description('Live benchmark: pull, load, generate, measure real memory/tok-s impact')
    .option('--no-color', 'disable colored output')
    .option('--backend <id>', 'use a specific backend instead of detecting them')
    .action(async (model: string, opts: { color: boolean; backend?: string }) => {
      await runBenchCommand(
        model,
        { color: shouldUseColor({ noColorFlag: !opts.color }), backend: opts.backend },
        createCliDeps()
      );
    });

  return program;
}

// npm's `bin` install (npm i -g / npm link) puts a *symlink* on PATH. Node resolves
// import.meta.url to the realpath while leaving process.argv[1] as the symlink path,
// so a naive string compare fails and the CLI silently exits 0 doing nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  createProgram().parseAsync(process.argv);
}
