import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  normalizeFtype,
  mapModelsToLocalModels,
  mapCompletionToGenerate,
} from '../src/backends/llama-server/index.js';
import type {
  LlamaServerModelsResponse,
  LlamaServerCompletionResponse,
} from '../src/backends/llama-server/client.js';

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8'));
}

describe('normalizeFtype', () => {
  // Each case is a real string from llama_ftype_name() in llama.cpp's
  // src/llama-model-loader.cpp, mapped to the canonical LLAMA_FTYPE enum id.
  it.each([
    ['all F32', 'F32'],
    ['F16', 'F16'],
    ['BF16', 'BF16'],
    ['Q8_0', 'Q8_0'],
    ['Q4_0', 'Q4_0'],
    ['MXFP4 MoE', 'MXFP4'],
    ['NVFP4', 'NVFP4'],
    ['Q2_K - Medium', 'Q2_K'], // enum is LLAMA_FTYPE_MOSTLY_Q2_K — no _M suffix
    ['Q2_K - Small', 'Q2_K_S'],
    ['Q3_K - Small', 'Q3_K_S'],
    ['Q3_K - Medium', 'Q3_K_M'],
    ['Q3_K - Large', 'Q3_K_L'],
    ['Q4_K - Small', 'Q4_K_S'],
    ['Q4_K - Medium', 'Q4_K_M'],
    ['Q5_K - Small', 'Q5_K_S'],
    ['Q5_K - Medium', 'Q5_K_M'],
    ['Q6_K', 'Q6_K'],
    ['TQ1_0 - 1.69 bpw ternary', 'TQ1_0'],
    ['TQ2_0 - 2.06 bpw ternary', 'TQ2_0'],
    ['IQ2_XXS - 2.0625 bpw', 'IQ2_XXS'],
    ['IQ2_XS - 2.3125 bpw', 'IQ2_XS'],
    ['IQ2_S - 2.5 bpw', 'IQ2_S'],
    ['IQ2_M - 2.7 bpw', 'IQ2_M'],
    ['IQ3_XXS - 3.0625 bpw', 'IQ3_XXS'],
    ['IQ3_XS - 3.3 bpw', 'IQ3_XS'],
    ['IQ3_S - 3.4375 bpw', 'IQ3_S'],
    ['IQ3_S mix - 3.66 bpw', 'IQ3_M'], // enum is LLAMA_FTYPE_MOSTLY_IQ3_M
    ['IQ1_S - 1.5625 bpw', 'IQ1_S'],
    ['IQ1_M - 1.75 bpw', 'IQ1_M'],
    ['IQ4_NL - 4.5 bpw', 'IQ4_NL'],
    ['IQ4_XS - 4.25 bpw', 'IQ4_XS'],
    ['Q4_1', 'Q4_1'],
    ['Q5_0', 'Q5_0'],
    ['Q5_1', 'Q5_1'],
  ])('normalizes %s to %s', (ftype, expected) => {
    expect(normalizeFtype(ftype)).toBe(expected);
  });

  it('strips the "(guessed) " prefix before mapping', () => {
    expect(normalizeFtype('(guessed) Q4_K - Medium')).toBe('Q4_K_M');
  });

  it('passes unknown strings through verbatim for the unknown-quant gap flow', () => {
    expect(normalizeFtype('Q9_Z - Fancy')).toBe('Q9_Z - Fancy');
  });
});

describe('mapModelsToLocalModels', () => {
  it('maps a loaded model with meta to a fully-populated ModelInfo', () => {
    const fixture = loadFixture<LlamaServerModelsResponse>('llama-server-models-loaded.json');
    const { models, skipped } = mapModelsToLocalModels(fixture);
    expect(skipped).toEqual([]);
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      name: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M',
      source: 'local',
      url: null,
      parameterSizeB: 630167424 / 1e9,
      quantizationLevel: 'Q4_K_M',
      diskSizeBytes: 485452288,
    });
  });

  it('reports null size/quant for a never-loaded model (no meta)', () => {
    const fixture = loadFixture<LlamaServerModelsResponse>('llama-server-models-unloaded.json');
    const { models } = mapModelsToLocalModels(fixture);
    expect(models[0].parameterSizeB).toBeNull();
    expect(models[0].quantizationLevel).toBeNull();
    expect(models[0].diskSizeBytes).toBeNull();
  });

  it('reports null again after unload — meta does not persist', () => {
    const fixture = loadFixture<LlamaServerModelsResponse>('llama-server-models-after-unload.json');
    const { models } = mapModelsToLocalModels(fixture);
    expect(models[0].parameterSizeB).toBeNull();
    expect(models[0].quantizationLevel).toBeNull();
    expect(models[0].diskSizeBytes).toBeNull();
  });
});

describe('mapCompletionToGenerate', () => {
  it('maps the timings block from a captured completion', () => {
    const fixture = loadFixture<LlamaServerCompletionResponse>('llama-server-completion-success.json');
    const result = mapCompletionToGenerate(fixture);
    expect(result.evalCount).toBe(16);
    expect(result.evalDurationSeconds).toBeCloseTo(0.071907, 6);
    expect(result.totalDurationSeconds).toBeCloseTo(0.089385, 6);
    expect(result.loadDurationSeconds).toBeNull();
  });
});
