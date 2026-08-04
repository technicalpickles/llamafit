#!/usr/bin/env node
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

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  createProgram().parseAsync(process.argv);
}
