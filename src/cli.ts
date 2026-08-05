#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { runCheck } from './check.js';
import { runBench, normalizeModelTarget, GENERATE_TIMEOUT_MS, type BenchDeps } from './bench.js';
import {
  fetchTags,
  fetchPs,
  generate as rawGenerate,
  unloadModel as rawUnloadModel,
  pullModel as rawPullModel,
  parseParameterSize,
  type OllamaTagsModel,
} from './backends/ollama/client.js';
import { selectProbe } from './probes/registry.js';
import { formatCheckTable, formatCheckJson, formatBenchResult } from './format.js';
import { shouldUseColor, success, warn, error, info, label } from './colors.js';
import { startSpinner } from './progress.js';

/** Printed once before any of the slow steps start, so the user knows what's about to
 * happen (and how long the generate step is allowed to run) instead of guessing from a
 * bare model name whether the tool is about to sit idle downloading gigabytes. */
function describeBenchPlan(model: string, existing: OllamaTagsModel | undefined): string[] {
  const details = existing
    ? (() => {
        const paramB = parseParameterSize(existing.details.parameter_size);
        const params = paramB !== null ? `${paramB.toFixed(1)}B params` : 'params unknown';
        const quant = existing.details.quantization_level || 'quant unknown';
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
 * timeout) with a spinner on stderr, so stdout stays just the final result. */
function benchDepsWithProgress(color: boolean): BenchDeps {
  return {
    fetchTags,
    fetchPs,
    readSystemMemory: () => selectProbe(process.platform)!.read(),
    pullModel: async (model) => {
      const startedAt = Date.now();
      const spinner = startSpinner(`Pulling ${model}...`);
      try {
        await rawPullModel(model);
      } catch (err) {
        spinner.stop();
        throw err;
      }
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      spinner.stop(success(`Pulled ${model} (${elapsed}s)`, color));
    },
    generate: async (model, prompt, timeoutMs) => {
      const seconds = Math.round((timeoutMs ?? 90_000) / 1000);
      const startedAt = Date.now();
      const spinner = startSpinner(`Generating (times out after ${seconds}s)...`);
      let response;
      try {
        response = await rawGenerate(model, prompt, timeoutMs);
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
    unloadModel: async (model) => {
      const spinner = startSpinner(`Unloading ${model}...`);
      try {
        await rawUnloadModel(model);
      } finally {
        spinner.stop();
      }
    },
  };
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
    .action(async (opts: { json?: boolean; query: string; color: boolean }) => {
      const color = shouldUseColor({ noColorFlag: !opts.color });
      try {
        const result = await runCheck(opts.query);
        // Spec's Error Handling section: a failed remote scrape warns on stderr and
        // continues, so the table on stdout stays machine-pipeable.
        if (result.scrapeWarning) {
          console.error(warn(`${label('Warning:', color)} ${result.scrapeWarning}`, color));
        }
        console.log(opts.json ? formatCheckJson(result) : formatCheckTable(result, { color }));
      } catch (err) {
        console.error(error(`${label('Error:', color)} ${(err as Error).message}`, color));
        process.exitCode = 1;
      }
    });

  program
    .command('bench')
    .argument('<model>', 'model name to benchmark (will be pulled if not already present)')
    .description('Live benchmark: pull, load, generate, measure real memory/tok-s impact')
    .option('--no-color', 'disable colored output')
    .action(async (model: string, opts: { color: boolean }) => {
      const color = shouldUseColor({ noColorFlag: !opts.color });
      try {
        const target = normalizeModelTarget(model);
        const tags = await fetchTags();
        const existing = tags.models.find((m) => m.name === target || m.model === target);
        for (const line of describeBenchPlan(model, existing)) {
          console.error(info(line, color));
        }
        const result = await runBench(model, benchDepsWithProgress(color));
        console.log(formatBenchResult(result, { color }));
      } catch (err) {
        console.error(error(`${label('Error:', color)} ${(err as Error).message}`, color));
        process.exitCode = 1;
      }
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
