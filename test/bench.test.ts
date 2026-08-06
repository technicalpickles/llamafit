import { describe, it, expect } from 'vitest';
import { runBench, normalizeModelTarget } from '../src/bench.js';
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
    // `llmfit bench llama3.2` is the natural invocation, but Ollama reports the
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
