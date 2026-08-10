import { describe, it, expect } from 'vitest';
import { runCheck, untagged, isNonChat, type CheckDeps } from '../src/check.js';
import type { OllamaTagsResponse } from '../src/backends/ollama/client.js';
import type { ModelInfo } from '../src/types.js';
import type { SystemMemoryState } from '../src/probes/types.js';
import type { RemoteSourceReport } from '../src/backends/types.js';
import { formulaEstimator, maxCandidateParamsB } from '../src/estimators/formula.js';
import { GapCollector } from '../src/gaps.js';
import { mapTagsToLocalModels } from '../src/backends/ollama/index.js';
import { fixtureBackend, fixtureProbe, loadJsonFixture } from './helpers/fixture-backend.js';
import { REMOTE_GUIDANCE } from '../src/hf/guidance.js';
import { hfCandidatesToModelInfo } from '../src/hf/model-info.js';
import type { HfCandidate } from '../src/hf/discovery.js';

const fakeSystem: SystemMemoryState = {
  totalGb: 24,
  usedGb: 23,
  wiredGb: 3.8,
  compressorGb: 9.3,
  unusedGb: 0.14,
  swapTotalGb: 12,
  swapUsedGb: 10.4,
  swapFreeGb: 1.5,
};

/**
 * The common case under test: nothing loaded (every row falls back to the formula
 * estimate) and no remote candidates. Individual tests override what they care about.
 */
function makeDeps(overrides: Partial<CheckDeps> = {}): CheckDeps {
  return {
    backend: fixtureBackend({
      loadedModels: async () => [],
      remoteCandidates: async () => ({ candidates: [], sources: [] }),
    }),
    probe: fixtureProbe(fakeSystem),
    estimator: formulaEstimator,
    gaps: new GapCollector(),
    ...overrides,
  };
}

describe('runCheck', () => {
  it('excludes cloud models from rows but lists them separately', async () => {
    const result = await runCheck('mlx', makeDeps());

    expect(result.rows.every((r) => r.source !== 'local' || !r.name.includes(':cloud'))).toBe(true);
    expect(result.cloudModels).toContain('glm-5.2:cloud');
    expect(result.rows.filter((r) => r.source === 'local').length).toBe(5);
  });

  it('computes baseline headroom as total minus the fixed macOS reserve', async () => {
    const result = await runCheck('mlx', makeDeps());
    expect(result.baselineHeadroomGb).toBe(16); // 24 - 8
  });

  it('computes current headroom as total minus wired, not the near-zero unused figure', async () => {
    const result = await runCheck('mlx', makeDeps());
    // 24 total - 3.8 wired. macOS's `unused` (0.14 here) is near-zero even when idle
    // because the compressor and caches claim free RAM, so it is not usable headroom.
    expect(result.currentHeadroomGb).toBeCloseTo(20.2, 5);
  });

  it('classifies gemma3:27b as will-thrash under current headroom', async () => {
    const result = await runCheck('mlx', makeDeps());
    const row = result.rows.find((r) => r.name === 'gemma3:27b');
    expect(row).toBeDefined();
    expect(row!.currentVerdict).toBe('will-thrash');
  });

  it('degrades gracefully when scraping fails, keeping local results', async () => {
    const result = await runCheck(
      'mlx',
      makeDeps({
        backend: fixtureBackend({
          loadedModels: async () => [],
          remoteCandidates: async () => {
            throw new Error('network unreachable');
          },
        }),
      })
    );
    expect(result.scrapeWarning).toMatch(/network unreachable/);
    expect(result.rows.filter((r) => r.source === 'local').length).toBe(5);
  });

  it('includes remote candidates with a parsed size, using the unknown-quant fallback', async () => {
    const remote: ModelInfo[] = [
      {
        name: 'pd95/gptoss-mlx',
        source: 'remote',
        url: 'https://ollama.com/pd95/gptoss-mlx',
        parameterSizeB: 20,
        quantizationLevel: null,
        diskSizeBytes: null,
      },
      {
        name: 'mistral-large-3',
        source: 'remote',
        url: 'https://ollama.com/library/mistral-large-3',
        parameterSizeB: null,
        quantizationLevel: null,
        diskSizeBytes: null,
      },
    ];
    const result = await runCheck(
      'mlx',
      makeDeps({
        backend: fixtureBackend({
          loadedModels: async () => [],
          remoteCandidates: async () => ({
            candidates: remote,
            sources: [{ id: 'huggingface', query: '', ok: true }],
          }),
        }),
      })
    );
    const row = result.rows.find((r) => r.name === 'pd95/gptoss-mlx');
    expect(row).toBeDefined();
    expect(row!.source).toBe('remote');
    expect(row!.quantizationLevel).toBe('Q4_K_M'); // fallback, unknown quant
    // remote candidate with no parsed size should be excluded, not shown with a bogus estimate
    expect(result.rows.find((r) => r.name === 'mistral-large-3')).toBeUndefined();
  });

  it('routes an HF candidate through hfCandidatesToModelInfo end-to-end so quantKnown flips true', async () => {
    // Regression guard for the remote-real-quants change: a repo that actually
    // publishes the table's fallback quant should reach runCheck with a known
    // quantizationLevel, not the blind Q4_K_M? guess. Built from a real
    // HfCandidate through the real mapper, not a hand-written ModelInfo.
    const hfCandidate: HfCandidate = {
      repoId: 'ornith-ai/Ornith-1.0-9B-GGUF',
      author: 'ornith-ai',
      url: 'https://huggingface.co/ornith-ai/Ornith-1.0-9B-GGUF',
      parameterSizeB: 9,
      availableQuants: ['Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'BF16'],
      signals: { downloads: 1, likes: 1, trendingScore: 1, lastModified: null },
    };
    const remote = hfCandidatesToModelInfo(
      [hfCandidate],
      (c) => `hf.co/${c.repoId}`
    );
    const result = await runCheck(
      'mlx',
      makeDeps({
        backend: fixtureBackend({
          loadedModels: async () => [],
          remoteCandidates: async () => ({
            candidates: remote,
            sources: [{ id: 'huggingface', query: '', ok: true }],
          }),
        }),
      })
    );
    const row = result.rows.find((r) => r.name === 'hf.co/ornith-ai/Ornith-1.0-9B-GGUF');
    expect(row).toBeDefined();
    expect(row!.quantizationLevel).toBe('Q4_K_M');
    expect(row!.quantKnown).toBe(true);
  });

  it('uses the real size_vram for a model that is currently loaded, marked measured', async () => {
    const result = await runCheck(
      'mlx',
      makeDeps({
        backend: fixtureBackend({ remoteCandidates: async () => ({ candidates: [], sources: [] }) }),
      })
    );

    const row = result.rows.find((r) => r.name === 'gemma3:12b');
    expect(row).toBeDefined();
    expect(row!.estimateSource).toBe('measured');
    expect(row!.quantKnown).toBe(true);
    // 8643862854 bytes reported by /api/ps, not the 12.2B x Q4_K_M x 1.25 formula (8.58)
    expect(row!.footprintGb).toBeCloseTo(8.643862854, 6);
    // verdicts are classified against the measured number
    expect(row!.baselineVerdict).toBe('comfortable'); // 8.64 < 16 * 0.7
    expect(row!.currentVerdict).toBe('comfortable'); // 8.64 < 20.2 * 0.7
  });

  it('estimates models that are not currently loaded, even when something else is', async () => {
    const result = await runCheck(
      'mlx',
      makeDeps({
        backend: fixtureBackend({ remoteCandidates: async () => ({ candidates: [], sources: [] }) }),
      })
    );

    const row = result.rows.find((r) => r.name === 'gemma3:27b');
    expect(row).toBeDefined();
    expect(row!.estimateSource).toBe('estimated');
    expect(row!.quantKnown).toBe(true); // Q4_K_M is reported by /api/tags
    expect(row!.footprintGb).toBeCloseTo(27.4 * 0.5625 * 1.25, 5);
  });

  it('flags a remote row as an estimate built on an unknown quantization', async () => {
    const remote: ModelInfo[] = [
      {
        name: 'pd95/gptoss-mlx',
        source: 'remote',
        url: 'https://ollama.com/pd95/gptoss-mlx',
        parameterSizeB: 20,
        quantizationLevel: null,
        diskSizeBytes: null,
      },
    ];
    const gaps = new GapCollector();
    const result = await runCheck(
      'mlx',
      makeDeps({
        gaps,
        backend: fixtureBackend({
          loadedModels: async () => [],
          remoteCandidates: async () => ({
            candidates: remote,
            sources: [{ id: 'huggingface', query: '', ok: true }],
          }),
        }),
      })
    );
    const row = result.rows.find((r) => r.name === 'pd95/gptoss-mlx');
    expect(row!.estimateSource).toBe('estimated');
    expect(row!.quantKnown).toBe(false);
    // A remote candidate never reports a quantization, so its fallback is expected, not a gap.
    expect(gaps.list()).toEqual([]);
  });

  it('records an unknown-quant gap once per unknown string', async () => {
    const tags = loadJsonFixture<OllamaTagsResponse>('api-tags.json');
    // Two local models quantized with a string the quant table has never heard of.
    tags.models[0].details.quantization_level = 'UD-Q4_K_XL';
    tags.models[1].details.quantization_level = 'UD-Q4_K_XL';

    const gaps = new GapCollector();
    await runCheck(
      'mlx',
      makeDeps({
        gaps,
        backend: fixtureBackend({
          localModels: async () => mapTagsToLocalModels(tags),
          loadedModels: async () => [],
          remoteCandidates: async () => ({ candidates: [], sources: [] }),
        }),
      })
    );

    const unknownQuant = gaps.list().filter((g) => g.kind === 'unknown-quant');
    expect(unknownQuant.length).toBe(1);
    expect(unknownQuant[0].summary).toBe('unknown quantization "UD-Q4_K_XL"');
    expect(unknownQuant[0].evidence).toMatchObject({ quantizationLevel: 'UD-Q4_K_XL' });
  });

  it('records no unknown-quant gap for a model whose quant is the string "unknown"', async () => {
    const gaps = new GapCollector();
    await runCheck('mlx', {
      backend: fixtureBackend(),
      probe: fixtureProbe(fakeSystem),
      estimator: formulaEstimator,
      gaps,
    });
    expect(gaps.list().filter((g) => g.kind === 'unknown-quant')).toEqual([]);
  });

  it('still records unknown-quant for a genuinely unrecognized quantization', async () => {
    const gaps = new GapCollector();
    await runCheck('mlx', {
      backend: fixtureBackend({
        localModels: async () => ({
          models: [
            {
              name: 'weird:latest',
              source: 'local',
              url: null,
              parameterSizeB: 7,
              quantizationLevel: 'Q3_K_XL_TURBO',
              diskSizeBytes: null,
            },
          ],
          skipped: [],
        }),
      }),
      probe: fixtureProbe(fakeSystem),
      estimator: formulaEstimator,
      gaps,
    });
    expect(gaps.list().map((g) => g.kind)).toContain('unknown-quant');
  });

  it('records a scrape-failed gap and still returns local rows', async () => {
    const gaps = new GapCollector();
    const result = await runCheck(
      'mlx',
      makeDeps({
        gaps,
        backend: fixtureBackend({
          loadedModels: async () => [],
          remoteCandidates: async () => {
            throw new Error('network unreachable');
          },
        }),
      })
    );

    expect(result.scrapeWarning).toMatch(/network unreachable/);
    expect(result.rows.length).toBeGreaterThan(0);
    const scrapeFailed = gaps.list().filter((g) => g.kind === 'scrape-failed');
    expect(scrapeFailed.length).toBe(1);
    expect(scrapeFailed[0].evidence).toMatchObject({ query: 'mlx', error: 'network unreachable' });
  });

  it('does not collapse the same failed source across two different backends', async () => {
    const gaps = new GapCollector();
    const failingDiscovery = async () => ({
      candidates: [],
      sources: [{ id: 'huggingface', query: 'mlx', ok: false, error: 'network unreachable' } as const],
    });

    await runCheck(
      'mlx',
      makeDeps({
        gaps,
        backend: fixtureBackend({
          id: 'ollama',
          loadedModels: async () => [],
          remoteCandidates: failingDiscovery,
        }),
      })
    );
    await runCheck(
      'mlx',
      makeDeps({
        gaps,
        backend: fixtureBackend({
          id: 'llama-server',
          loadedModels: async () => [],
          remoteCandidates: failingDiscovery,
        }),
      })
    );

    const scrapeFailed = gaps.list().filter((g) => g.kind === 'scrape-failed');
    expect(scrapeFailed).toHaveLength(2);
    expect(scrapeFailed.map((g) => g.summary)).toEqual([
      'remote source huggingface failed for backend ollama',
      'remote source huggingface failed for backend llama-server',
    ]);
  });

  it('orders remote rows by downloads descending, nulls last', async () => {
    const result = await runCheck('mlx', {
      backend: fixtureBackend({
        remoteCandidates: async () => ({
          candidates: [
            { name: 'few', source: 'remote', url: null, parameterSizeB: 7, quantizationLevel: 'Q4_K_M', diskSizeBytes: null, signals: { downloads: 10, likes: 0, trendingScore: 99, lastModified: null } },
            { name: 'none', source: 'remote', url: null, parameterSizeB: 7, quantizationLevel: 'Q4_K_M', diskSizeBytes: null, signals: { downloads: null, likes: 0, trendingScore: 50, lastModified: null } },
            { name: 'many', source: 'remote', url: null, parameterSizeB: 7, quantizationLevel: 'Q4_K_M', diskSizeBytes: null, signals: { downloads: 5000, likes: 0, trendingScore: 1, lastModified: null } },
          ],
          sources: [{ id: 'huggingface', query: '', ok: true }],
        }),
      }),
      probe: fixtureProbe(fakeSystem),
      estimator: formulaEstimator,
      gaps: new GapCollector(),
    });

    const remote = result.rows.filter((r) => r.source === 'remote').map((r) => r.name);
    expect(remote).toEqual(['many', 'few', 'none']);
  });

  it('keeps local rows ahead of remote rows', async () => {
    const result = await runCheck('mlx', {
      backend: fixtureBackend(),
      probe: fixtureProbe(fakeSystem),
      estimator: formulaEstimator,
      gaps: new GapCollector(),
    });
    const firstRemote = result.rows.findIndex((r) => r.source === 'remote');
    const lastLocal = result.rows.map((r) => r.source).lastIndexOf('local');
    expect(lastLocal).toBeLessThan(firstRemote);
  });

  it('produces no measured rows when the backend lacks loadedModels', async () => {
    const result = await runCheck(
      'mlx',
      makeDeps({
        backend: fixtureBackend({
          loadedModels: undefined,
          remoteCandidates: async () => ({ candidates: [], sources: [] }),
        }),
      })
    );

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((r) => r.estimateSource === 'estimated')).toBe(true);
  });
});

describe('remote candidate signals and guidance', () => {
  it('passes a headroom-derived cap to remoteCandidates', async () => {
    const seen: unknown[] = [];
    const result = await runCheck(
      'mlx',
      makeDeps({
        backend: fixtureBackend({
          loadedModels: async () => [],
          remoteCandidates: async (query, opts) => {
            seen.push([query, opts]);
            return { candidates: [], sources: [] };
          },
        }),
      })
    );
    const [, opts] = seen[0] as [string, { maxParameterSizeB?: number }];
    expect(opts.maxParameterSizeB).toBeCloseTo(maxCandidateParamsB(result.baselineHeadroomGb), 6);
  });

  it('copies author, quants, and signals onto remote rows and sets guidance', async () => {
    const remote: ModelInfo[] = [
      {
        name: 'unsloth/gpt-oss-mlx',
        source: 'remote',
        url: 'https://huggingface.co/unsloth/gpt-oss-mlx',
        parameterSizeB: 9,
        quantizationLevel: null,
        diskSizeBytes: null,
        author: 'unsloth',
        availableQuants: ['Q4_K_M'],
        signals: { downloads: 1, likes: 2, trendingScore: 3, lastModified: 'x' },
      },
    ];
    const result = await runCheck(
      'mlx',
      makeDeps({
        backend: fixtureBackend({
          loadedModels: async () => [],
          remoteCandidates: async () => ({
            candidates: remote,
            sources: [{ id: 'huggingface', query: '', ok: true }],
          }),
        }),
      })
    );
    const row = result.rows.find((r) => r.source === 'remote')!;
    expect(row.author).toBe('unsloth');
    expect(row.availableQuants).toEqual(['Q4_K_M']);
    expect(row.signals?.downloads).toBe(1);
    expect(result.remoteGuidance).toBe(REMOTE_GUIDANCE);
  });

  it('leaves guidance null for signal-less backends (ollama-shaped)', async () => {
    const remote: ModelInfo[] = [
      {
        name: 'pd95/gptoss-mlx',
        source: 'remote',
        url: 'https://ollama.com/pd95/gptoss-mlx',
        parameterSizeB: 20,
        quantizationLevel: null,
        diskSizeBytes: null,
      },
    ];
    const result = await runCheck(
      'mlx',
      makeDeps({
        backend: fixtureBackend({
          loadedModels: async () => [],
          remoteCandidates: async () => ({
            candidates: remote,
            sources: [{ id: 'ollama.com', query: 'mlx', ok: true }],
          }),
        }),
      })
    );
    expect(result.remoteGuidance).toBeNull();
    const row = result.rows.find((r) => r.source === 'remote')!;
    expect(row.signals).toBeUndefined();
  });
});

describe('remote discovery reporting', () => {
  it('exposes the backend source reports as remoteSources', async () => {
    const sources: RemoteSourceReport[] = [{ id: 'huggingface', query: 'qwen', ok: true }];
    const result = await runCheck(
      'qwen',
      makeDeps({
        backend: fixtureBackend({
          remoteCandidates: async () => ({ candidates: [], sources }),
        }),
      })
    );
    expect(result.remoteSources).toEqual(sources);
  });

  it('a failed source becomes a gap and a warning while surviving rows still render', async () => {
    const gaps = new GapCollector();
    const result = await runCheck(
      '',
      makeDeps({
        gaps,
        backend: fixtureBackend({
          loadedModels: async () => [],
          remoteCandidates: async () => ({
            candidates: [
              {
                name: 'hf.co/ggml-org/some-model-GGUF',
                source: 'remote',
                url: 'https://huggingface.co/ggml-org/some-model-GGUF',
                parameterSizeB: 4,
                quantizationLevel: null,
                diskSizeBytes: null,
                discoverySource: 'huggingface',
              },
            ],
            sources: [
              { id: 'ollama.com', query: 'mlx', ok: false, error: 'network unreachable' },
              { id: 'huggingface', query: '', ok: true },
            ],
          }),
        }),
      })
    );
    expect(result.rows.some((r) => r.name === 'hf.co/ggml-org/some-model-GGUF')).toBe(true);
    expect(result.scrapeWarning).toMatch(/ollama\.com.*network unreachable/);
    const failed = gaps.list().filter((g) => g.kind === 'scrape-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].evidence).toMatchObject({ source: 'ollama.com', error: 'network unreachable' });
  });

  it('remote rows carry their discoverySource through to CheckRow', async () => {
    const result = await runCheck(
      'mlx',
      makeDeps({ backend: fixtureBackend({ loadedModels: async () => [] }) })
    );
    const remote = result.rows.filter((r) => r.source === 'remote');
    expect(remote.length).toBeGreaterThan(0);
    // fixtureBackend mirrors the real backend's two sources (ollama.com scrape
    // + Hugging Face), so remote rows split across both discoverySources.
    expect(remote.some((r) => r.discoverySource === 'ollama.com')).toBe(true);
    expect(remote.some((r) => r.discoverySource === 'huggingface')).toBe(true);
    expect(remote.every((r) => r.discoverySource === 'ollama.com' || r.discoverySource === 'huggingface')).toBe(
      true
    );
  });

  it('drops a remote candidate that is already pulled locally', async () => {
    const result = await runCheck('mlx', {
      backend: fixtureBackend({
        localModels: async () => ({
          models: [
            { name: 'hf.co/o/r:Q4_K_M', source: 'local', url: null, parameterSizeB: 8, quantizationLevel: 'Q4_K_M', diskSizeBytes: 1 },
          ],
          skipped: [],
        }),
        remoteCandidates: async () => ({
          candidates: [
            { name: 'hf.co/o/r', source: 'remote', url: null, parameterSizeB: 8, quantizationLevel: 'Q4_K_M', diskSizeBytes: null },
            { name: 'hf.co/other/repo', source: 'remote', url: null, parameterSizeB: 8, quantizationLevel: 'Q4_K_M', diskSizeBytes: null },
          ],
          sources: [{ id: 'huggingface', query: '', ok: true }],
        }),
      }),
      probe: fixtureProbe(fakeSystem),
      estimator: formulaEstimator,
      gaps: new GapCollector(),
    });

    const remote = result.rows.filter((r) => r.source === 'remote').map((r) => r.name);
    expect(remote).toEqual(['hf.co/other/repo']);
  });

  it('never filters a local model, even one that looks like an embedding model', async () => {
    const result = await runCheck('mlx', {
      backend: fixtureBackend({
        localModels: async () => ({
          models: [
            { name: 'mxbai-embed-large', source: 'local', url: null, parameterSizeB: 0.3, quantizationLevel: 'Q4_K_M', diskSizeBytes: 1 },
          ],
          skipped: [],
        }),
        remoteCandidates: async () => ({
          candidates: [
            { name: 'some/other-embed-model', source: 'remote', url: null, parameterSizeB: 1, quantizationLevel: 'Q4_K_M', diskSizeBytes: null },
          ],
          sources: [{ id: 'huggingface', query: '', ok: true }],
        }),
      }),
      probe: fixtureProbe(fakeSystem),
      estimator: formulaEstimator,
      gaps: new GapCollector(),
    });

    expect(result.rows.map((r) => r.name)).toEqual(['mxbai-embed-large']);
  });
});

describe('untagged', () => {
  it('strips an Ollama tag', () => {
    expect(untagged('gemma3:12b')).toBe('gemma3');
    expect(untagged('hf.co/o/r:Q4_K_M')).toBe('hf.co/o/r');
  });

  it('leaves a name with no tag alone', () => {
    expect(untagged('mistrallite')).toBe('mistrallite');
    expect(untagged('hf.co/o/r')).toBe('hf.co/o/r');
  });

  it('does not mistake a namespace colon for a tag', () => {
    expect(untagged('hf.co/owner:weird/repo')).toBe('hf.co/owner:weird/repo');
  });
});

describe('isNonChat', () => {
  it('flags embedding and reranker models', () => {
    expect(isNonChat('mxbai-embed-large')).toBe(true);
    expect(isNonChat('charaf/qwen3-embedding-8b-mlx-mxfp8')).toBe(true);
    expect(isNonChat('BAAI/bge-reranker-v2-m3')).toBe(true);
  });

  it('does not flag ordinary chat models', () => {
    expect(isNonChat('gemma3:12b')).toBe(false);
    expect(isNonChat('ornith-ai/Ornith-1.0-9B-GGUF')).toBe(false);
  });
});
