import { describe, it, expect } from 'vitest';
import { createProgram } from '../src/cli.js';

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
  });

  it('registers a bench command requiring a model argument', () => {
    const program = createProgram();
    const bench = program.commands.find((c) => c.name() === 'bench');
    expect(bench).toBeDefined();
    expect(bench!.registeredArguments.length).toBeGreaterThan(0);
  });
});
