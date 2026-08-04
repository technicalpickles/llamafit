#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { runCheck } from './check.js';
import { runBench } from './bench.js';
import { formatCheckTable, formatCheckJson, formatBenchResult } from './format.js';

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
    .action(async (opts: { json?: boolean; query: string }) => {
      try {
        const result = await runCheck(opts.query);
        // Spec's Error Handling section: a failed remote scrape warns on stderr and
        // continues, so the table on stdout stays machine-pipeable.
        if (result.scrapeWarning) {
          console.error(`Warning: ${result.scrapeWarning}`);
        }
        console.log(opts.json ? formatCheckJson(result) : formatCheckTable(result));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  program
    .command('bench')
    .argument('<model>', 'model name to benchmark (will be pulled if not already present)')
    .description('Live benchmark: pull, load, generate, measure real memory/tok-s impact')
    .action(async (model: string) => {
      try {
        const result = await runBench(model);
        console.log(formatBenchResult(result));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
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
