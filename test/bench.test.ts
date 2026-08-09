import { describe, it, expect } from 'vitest';
import { runBench, normalizeModelTarget, matchesModelTarget } from '../src/bench.js';
import type { SystemMemoryState } from '../src/probes/types.js';
import { fixtureBackend, fixtureProbe } from './helpers/fixture-backend.js';

const SYSTEM: SystemMemoryState = {
  totalGb: 24,
  usedGb: 3,
  wiredGb: 3,
  compressorGb: 6,
  unusedGb: 15,
  swapTotalGb: 0,
  swapUsedGb: 0,
  swapFreeGb: 0,
};

describe('runBench', () => {
  it('reports a completed run with tokens/sec computed from evalCount and evalDurationSeconds', async () => {
    let unloadCalled = false;
    let pullCalled = false;

    const result = await runBench('gemma3:12b', {
      backend: fixtureBackend({
        unload: async () => {
          unloadCalled = true;
        },
        pull: async () => {
          pullCalled = true;
        },
      }),
      probe: fixtureProbe(SYSTEM),
    });

    expect(result.status).toBe('completed');
    // gemma3:12b is the only model in api-ps-loaded.json, at 8643862854 bytes size_vram.
    expect(result.sizeVramGb).toBeCloseTo(8.64, 1);
    // default fixture generate() resolves evalCount: 100, evalDurationSeconds: 4.
    expect(result.evalTokensPerSecond).toBe(25);
    expect(unloadCalled).toBe(true);
    expect(pullCalled).toBe(false); // gemma3:12b is already in api-tags.json
    expect(result.notes).toEqual([]);
  });

  it('reports timed-out status when generate returns null, and still unloads the model', async () => {
    let unloadCalled = false;

    const result = await runBench('gemma3:27b', {
      backend: fixtureBackend({
        generate: async () => null,
        unload: async () => {
          unloadCalled = true;
        },
      }),
      probe: fixtureProbe(SYSTEM),
    });

    expect(result.status).toBe('timed-out');
    expect(result.evalTokensPerSecond).toBeNull();
    expect(result.loadDurationSeconds).toBeNull();
    expect(result.totalDurationSeconds).toBeNull();
    expect(unloadCalled).toBe(true);
  });

  it('still unloads the model and rethrows when loadedModels throws after a successful generate call', async () => {
    let unloadCalled = false;

    await expect(
      runBench('gemma3:12b', {
        backend: fixtureBackend({
          loadedModels: async () => {
            throw new Error('loadedModels failed');
          },
          unload: async () => {
            unloadCalled = true;
          },
        }),
        probe: fixtureProbe(SYSTEM),
      })
    ).rejects.toThrow('loadedModels failed');

    expect(unloadCalled).toBe(true);
  });

  it("matches an untagged model name against Ollama's :latest-normalized responses", async () => {
    // `llamafit bench llama3.2` is the natural invocation, but Ollama reports the
    // model as llama3.2:latest — exact-matching the raw input drops the VRAM reading
    // and triggers a needless re-pull.
    const generatedWith: string[] = [];
    let pullCalled = false;

    const result = await runBench('llama3.2', {
      backend: fixtureBackend({
        localModels: async () => ({
          models: [
            {
              name: 'llama3.2:latest',
              source: 'local',
              url: null,
              parameterSizeB: 3.2,
              quantizationLevel: 'Q4_K_M',
              diskSizeBytes: 2_019_393_189,
            },
          ],
          skipped: [],
        }),
        loadedModels: async () => [
          { name: 'llama3.2:latest', sizeVramGb: 2.019393189, quantizationLevel: 'Q4_K_M' },
        ],
        generate: async (model) => {
          generatedWith.push(model);
          return {
            evalCount: 3,
            evalDurationSeconds: 0.052821,
            loadDurationSeconds: 0,
            totalDurationSeconds: 1.838357583,
          };
        },
        pull: async () => {
          pullCalled = true;
        },
      }),
      probe: fixtureProbe(SYSTEM),
    });

    expect(pullCalled).toBe(false); // already pulled as :latest
    expect(result.sizeVramGb).toBeCloseTo(2.02, 2);
    expect(generatedWith).toEqual(['llama3.2']); // raw input passed through to the backend
    // a real 0 load_duration is a number, not "missing"
    expect(result.loadDurationSeconds).toBe(0);
  });

  it("matches an untagged local model name against an untagged bench target (e.g. llama-server router ids, which never get :latest appended)", async () => {
    // llama-server router ids from --models-dir/presets have no colon, so
    // normalizeModelTarget's Ollama-only :latest rule must not be the only match tried —
    // otherwise a model that IS in the list looks unpulled and a backend with no pull
    // capability throws "can't pull models" for a model it already has.
    const result = await runBench('qwen3-30b', {
      backend: fixtureBackend({
        localModels: async () => ({
          models: [
            {
              name: 'qwen3-30b',
              source: 'local',
              url: null,
              parameterSizeB: 30.5,
              quantizationLevel: 'Q4_K_M',
              diskSizeBytes: 19_000_000_000,
            },
          ],
          skipped: [],
        }),
        pull: undefined,
      }),
      probe: fixtureProbe(SYSTEM),
    });

    expect(result.status).toBe('completed');
  });

  it('finds the running model VRAM when loadedModels reports an untagged name verbatim', async () => {
    // The running-model lookup after generate() must use the same either-form matching
    // as the already-pulled check — a backend that reports untagged ids verbatim (no
    // :latest appended) would otherwise silently lose its VRAM reading.
    const result = await runBench('qwen3-30b', {
      backend: fixtureBackend({
        localModels: async () => ({
          models: [
            {
              name: 'qwen3-30b',
              source: 'local',
              url: null,
              parameterSizeB: 30.5,
              quantizationLevel: 'Q4_K_M',
              diskSizeBytes: 19_000_000_000,
            },
          ],
          skipped: [],
        }),
        loadedModels: async () => [
          { name: 'qwen3-30b', sizeVramGb: 19.0, quantizationLevel: 'Q4_K_M' },
        ],
      }),
      probe: fixtureProbe(SYSTEM),
    });

    expect(result.sizeVramGb).toBeCloseTo(19.0, 2);
  });

  it('pulls the model when not already present', async () => {
    let pullCalled = false;

    await runBench('brand-new-model', {
      backend: fixtureBackend({
        localModels: async () => ({ models: [], skipped: [] }),
        loadedModels: async () => [],
        pull: async () => {
          pullCalled = true;
        },
      }),
      probe: fixtureProbe(SYSTEM),
    });

    expect(pullCalled).toBe(true);
  });

  it('uses the id pull() resolves to for generate/loadedModels/unload, not the raw request', async () => {
    // llama-server auto-picks a quant for a multi-quant HF repo pulled without one and
    // registers the model under `<repo>:<quant>` — a different id than what was
    // requested. pull() surfaces that resolved id; every call after pull must use it or
    // generate()/unload() 400 with "model not found" against the id nothing actually has.
    const generatedWith: string[] = [];
    const unloadedWith: string[] = [];

    const result = await runBench('yuxinlu1/gemma-4-12B-agentic-GGUF', {
      backend: fixtureBackend({
        localModels: async () => ({ models: [], skipped: [] }),
        loadedModels: async () => [
          { name: 'yuxinlu1/gemma-4-12B-agentic-GGUF:Q4_K_M', sizeVramGb: 8.5, quantizationLevel: 'Q4_K_M' },
        ],
        generate: async (model) => {
          generatedWith.push(model);
          return {
            evalCount: 100,
            evalDurationSeconds: 4,
            loadDurationSeconds: 1,
            totalDurationSeconds: 6,
          };
        },
        pull: async () => 'yuxinlu1/gemma-4-12B-agentic-GGUF:Q4_K_M',
        unload: async (model) => {
          unloadedWith.push(model);
        },
      }),
      probe: fixtureProbe(SYSTEM),
    });

    expect(generatedWith).toEqual(['yuxinlu1/gemma-4-12B-agentic-GGUF:Q4_K_M']);
    expect(unloadedWith).toEqual(['yuxinlu1/gemma-4-12B-agentic-GGUF:Q4_K_M']);
    expect(result.sizeVramGb).toBeCloseTo(8.5, 2);
  });

  it('degrades without loadedModels: null vram plus a note', async () => {
    const result = await runBench('gemma3:12b', {
      backend: fixtureBackend({ loadedModels: undefined }),
      probe: fixtureProbe(SYSTEM),
    });

    expect(result.sizeVramGb).toBeNull();
    expect(result.notes).toEqual([
      "Fixture can't report per-model VRAM; footprint shown is the system-memory delta only",
    ]);
  });

  it('degrades without unload: skips the unload step and adds a note', async () => {
    const result = await runBench('gemma3:12b', {
      backend: fixtureBackend({ unload: undefined }),
      probe: fixtureProbe(SYSTEM),
    });

    expect(result.notes).toEqual(["Fixture can't unload models — 'gemma3:12b' is still loaded"]);
  });

  it('fails fast when model absent and backend cannot pull', async () => {
    await expect(
      runBench('nonexistent-model', {
        backend: fixtureBackend({ pull: undefined }),
        probe: fixtureProbe(SYSTEM),
      })
    ).rejects.toThrow("Fixture can't pull models — pull 'nonexistent-model' yourself, then re-run");
  });

  it("adds a note (and keeps the result) when unload itself throws, instead of masking the outcome", async () => {
    // llama-server 400s an unload call for a model it considers not loaded — a real case
    // when generate() timed out before the model finished loading. That must not turn a
    // legitimate (if degraded) result into a hard throw.
    const result = await runBench('gemma3:12b', {
      backend: fixtureBackend({
        unload: async () => {
          throw new Error('model is not found');
        },
      }),
      probe: fixtureProbe(SYSTEM),
    });

    expect(result.status).toBe('completed');
    expect(result.notes).toEqual(["Fixture failed to unload 'gemma3:12b': model is not found"]);
  });

  it('propagates the original error, not the unload failure, when both generate and unload fail', async () => {
    await expect(
      runBench('gemma3:12b', {
        backend: fixtureBackend({
          generate: async () => {
            throw new Error('generate failed');
          },
          unload: async () => {
            throw new Error('model is not found');
          },
        }),
        probe: fixtureProbe(SYSTEM),
      })
    ).rejects.toThrow('generate failed');
  });

  it('still unloads when generate throws', async () => {
    let unloadCalled = false;

    await expect(
      runBench('gemma3:12b', {
        backend: fixtureBackend({
          generate: async () => {
            throw new Error('generate failed');
          },
          unload: async () => {
            unloadCalled = true;
          },
        }),
        probe: fixtureProbe(SYSTEM),
      })
    ).rejects.toThrow('generate failed');

    expect(unloadCalled).toBe(true);
  });

  it('normalizes an untagged model name to :latest', () => {
    expect(normalizeModelTarget('llama3.2')).toBe('llama3.2:latest');
    expect(normalizeModelTarget('llama3.2:3b')).toBe('llama3.2:3b');
  });
});

describe('matchesModelTarget', () => {
  it("matches Ollama's :latest-normalized name", () => {
    expect(matchesModelTarget('llama3.2:latest', 'llama3.2')).toBe(true);
  });

  it('matches an untagged name reported verbatim (e.g. llama-server router ids)', () => {
    expect(matchesModelTarget('qwen3-30b', 'qwen3-30b')).toBe(true);
  });

  it('does not match an unrelated model', () => {
    expect(matchesModelTarget('gemma3:12b', 'llama3.2')).toBe(false);
  });
});
