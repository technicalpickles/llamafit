#!/usr/bin/env node
import { Command } from 'commander';

export function createProgram(): Command {
  const program = new Command();
  program
    .name('ollama-scope')
    .description("Right-size Ollama models for this machine's memory and quantization");
  return program;
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  createProgram().parseAsync(process.argv);
}
