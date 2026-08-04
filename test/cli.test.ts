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
