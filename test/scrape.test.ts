import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSearchResults } from '../src/scrape.js';

function loadFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');
}

describe('parseSearchResults', () => {
  const html = loadFixture('ollama-search-mlx.html');
  const results = parseSearchResults(html);

  it('finds all 20 real results in the fixture', () => {
    expect(results.length).toBe(20);
  });

  it('parses an official /library/ model with a size badge', () => {
    const mxbai = results.find((r) => r.name === 'mxbai-embed-large');
    expect(mxbai).toBeDefined();
    expect(mxbai!.parameterSizeB).toBeCloseTo(0.335, 5);
    expect(mxbai!.sizeSource).toBe('badge');
  });

  it('parses a size badge in whole billions', () => {
    const gptoss = results.find((r) => r.name === 'pd95/gptoss-mlx');
    expect(gptoss).toBeDefined();
    expect(gptoss!.parameterSizeB).toBe(20);
    expect(gptoss!.sizeSource).toBe('badge');
  });

  it('falls back to name-heuristic parsing when there is no size badge', () => {
    // real fixture: cyborgxx101/gemma-4-12b-opus-finetuned-mlx has no badge,
    // but "12b" is in the name — and this matches what we actually measured (11.9B).
    const gemma4 = results.find((r) => r.name === 'cyborgxx101/gemma-4-12b-opus-finetuned-mlx');
    expect(gemma4).toBeDefined();
    expect(gemma4!.parameterSizeB).toBe(12);
    expect(gemma4!.sizeSource).toBe('name-heuristic');
  });

  it('picks the first size token when a name has multiple digit+B substrings', () => {
    // real fixture: "Qwen3.6-35B-A3B-mlx-claude-coder-abliterated" — "35B" comes
    // before "A3B" in the string, so it should win.
    const candidate = results.find(
      (r) => r.name === 'rafw007/Qwen3.6-35B-A3B-mlx-claude-coder-abliterated'
    );
    expect(candidate).toBeDefined();
    expect(candidate!.parameterSizeB).toBe(35);
    expect(candidate!.sizeSource).toBe('name-heuristic');
  });

  it('returns unknown when neither a badge nor a name pattern is present', () => {
    const mistralLarge = results.find((r) => r.name === 'mistral-large-3');
    expect(mistralLarge).toBeDefined();
    expect(mistralLarge!.parameterSizeB).toBeNull();
    expect(mistralLarge!.sizeSource).toBe('unknown');
  });

  it('derives the community model name from the href without a /library/ prefix', () => {
    const apertus = results.find((r) => r.name === 'pd95/apertus-mlx');
    expect(apertus).toBeDefined();
  });
});
