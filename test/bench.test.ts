import { describe, it, expect } from 'vitest';
import { runBench } from '../src/bench.js';
import type { OllamaTagsResponse, OllamaPsResponse, OllamaGenerateResponse } from '../src/ollama-client.js';
import type { SystemMemoryState } from '../src/probes/types.js';

const before: SystemMemoryState = {
  totalGb: 24,
  usedGb: 3,
  wiredGb: 3,
  compressorGb: 6,
  unusedGb: 15,
  swapTotalGb: 0,
  swapUsedGb: 0,
  swapFreeGb: 0,
};

const after: SystemMemoryState = {
  ...before,
  usedGb: 23,
  unusedGb: 0.1,
  swapUsedGb: 22.6,
};

describe('runBench', () => {
  it('reports a completed run with tokens/sec computed from eval_count and eval_duration', async () => {
    const alreadyPulledTags: OllamaTagsResponse = {
      models: [{ name: 'gemma3:12b', model: 'gemma3:12b', modified_at: '', size: 1, digest: '', details: { parent_model: '', format: 'gguf', family: 'gemma3', families: null, parameter_size: '12.2B', quantization_level: 'Q4_K_M' }, capabilities: [] }],
    };
    const ps: OllamaPsResponse = {
      models: [{ name: 'gemma3:12b', model: 'gemma3:12b', size: 8643862854, digest: '', details: { parent_model: '', format: 'gguf', family: 'gemma3', families: null, parameter_size: '12.2B', quantization_level: 'Q4_K_M' }, expires_at: '', size_vram: 8643862854, context_length: 4096 }],
    };
    const generateResponse: OllamaGenerateResponse = {
      model: 'gemma3:12b',
      created_at: '',
      response: 'a story',
      done: true,
      eval_count: 166,
      eval_duration: 10_690_000_000,
      load_duration: 12_880_000_000,
      total_duration: 24_060_000_000,
    };

    let unloadCalled = false;
    let pullCalled = false;

    const result = await runBench('gemma3:12b', {
      fetchTags: async () => alreadyPulledTags,
      fetchPs: async () => ps,
      generate: async () => generateResponse,
      unloadModel: async () => {
        unloadCalled = true;
      },
      pullModel: async () => {
        pullCalled = true;
      },
      readSystemMemory: (() => {
        let callCount = 0;
        return async () => (callCount++ === 0 ? before : after);
      })(),
    });

    expect(result.status).toBe('completed');
    expect(result.sizeVramGb).toBeCloseTo(8.64, 1);
    expect(result.evalTokensPerSecond).toBeCloseTo(166 / 10.69, 2);
    expect(unloadCalled).toBe(true);
    expect(pullCalled).toBe(false); // already pulled, should not re-pull
  });

  it('reports timed-out status when generate returns null, and still unloads the model', async () => {
    const tags: OllamaTagsResponse = {
      models: [{ name: 'gemma3:27b', model: 'gemma3:27b', modified_at: '', size: 1, digest: '', details: { parent_model: '', format: 'gguf', family: 'gemma3', families: null, parameter_size: '27.4B', quantization_level: 'Q4_K_M' }, capabilities: [] }],
    };
    const ps: OllamaPsResponse = {
      models: [{ name: 'gemma3:27b', model: 'gemma3:27b', size: 18534629372, digest: '', details: { parent_model: '', format: 'gguf', family: 'gemma3', families: null, parameter_size: '27.4B', quantization_level: 'Q4_K_M' }, expires_at: '', size_vram: 16908340427, context_length: 4096 }],
    };

    let unloadCalled = false;

    const result = await runBench('gemma3:27b', {
      fetchTags: async () => tags,
      fetchPs: async () => ps,
      generate: async () => null,
      unloadModel: async () => {
        unloadCalled = true;
      },
      pullModel: async () => {},
      readSystemMemory: (() => {
        let callCount = 0;
        return async () => (callCount++ === 0 ? before : after);
      })(),
    });

    expect(result.status).toBe('timed-out');
    expect(result.evalTokensPerSecond).toBeNull();
    expect(result.sizeVramGb).toBeCloseTo(16.91, 1);
    expect(unloadCalled).toBe(true);
  });

  it('still unloads the model and rethrows when fetchPs throws after a successful generate call', async () => {
    const tags: OllamaTagsResponse = { models: [] };
    const generateResponse: OllamaGenerateResponse = {
      model: 'gemma3:12b',
      created_at: '',
      response: 'a story',
      done: true,
      eval_count: 166,
      eval_duration: 10_690_000_000,
      load_duration: 12_880_000_000,
      total_duration: 24_060_000_000,
    };

    let unloadCalled = false;

    await expect(
      runBench('gemma3:12b', {
        fetchTags: async () => tags,
        fetchPs: async () => {
          throw new Error('ps failed');
        },
        generate: async () => generateResponse,
        unloadModel: async () => {
          unloadCalled = true;
        },
        pullModel: async () => {},
        readSystemMemory: async () => before,
      })
    ).rejects.toThrow('ps failed');

    expect(unloadCalled).toBe(true);
  });

  it('matches an untagged model name against Ollama\'s :latest-normalized responses', async () => {
    // `ollama-scope bench llama3.2` is the natural invocation, but Ollama reports the
    // model as llama3.2:latest — exact-matching the raw input drops the VRAM reading
    // and triggers a needless re-pull.
    const tags: OllamaTagsResponse = {
      models: [{ name: 'llama3.2:latest', model: 'llama3.2:latest', modified_at: '', size: 1, digest: '', details: { parent_model: '', format: 'gguf', family: 'llama', families: null, parameter_size: '3.2B', quantization_level: 'Q4_K_M' }, capabilities: [] }],
    };
    const ps: OllamaPsResponse = {
      models: [{ name: 'llama3.2:latest', model: 'llama3.2:latest', size: 2019393189, digest: '', details: { parent_model: '', format: 'gguf', family: 'llama', families: null, parameter_size: '3.2B', quantization_level: 'Q4_K_M' }, expires_at: '', size_vram: 2019393189, context_length: 4096 }],
    };
    const generateResponse: OllamaGenerateResponse = {
      model: 'llama3.2:latest',
      created_at: '',
      response: 'a story',
      done: true,
      eval_count: 3,
      eval_duration: 52_821_000,
      load_duration: 0,
      total_duration: 1_838_357_583,
    };

    let pullCalled = false;
    const generatedWith: string[] = [];

    const result = await runBench('llama3.2', {
      fetchTags: async () => tags,
      fetchPs: async () => ps,
      generate: async (m) => {
        generatedWith.push(m);
        return generateResponse;
      },
      unloadModel: async () => {},
      pullModel: async () => {
        pullCalled = true;
      },
      readSystemMemory: async () => before,
    });

    expect(pullCalled).toBe(false); // already pulled as :latest
    expect(result.sizeVramGb).toBeCloseTo(2.02, 2);
    expect(generatedWith).toEqual(['llama3.2']); // raw input passed through to Ollama
    // a real 0 load_duration is a number, not "missing"
    expect(result.loadDurationSeconds).toBe(0);
  });

  it('pulls the model when not already present', async () => {
    const emptyTags: OllamaTagsResponse = { models: [] };
    const ps: OllamaPsResponse = { models: [] };
    const generateResponse: OllamaGenerateResponse = {
      model: 'llama3.2:3b',
      created_at: '',
      response: 'hi',
      done: true,
      eval_count: 3,
      eval_duration: 52_821_000,
      load_duration: 1_481_564_750,
      total_duration: 1_838_357_583,
    };

    let pullCalled = false;

    await runBench('llama3.2:3b', {
      fetchTags: async () => emptyTags,
      fetchPs: async () => ps,
      generate: async () => generateResponse,
      unloadModel: async () => {},
      pullModel: async () => {
        pullCalled = true;
      },
      readSystemMemory: async () => before,
    });

    expect(pullCalled).toBe(true);
  });
});
