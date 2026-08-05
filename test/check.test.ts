import { describe, it, expect } from 'vitest';
import { runCheck, type CheckDeps } from '../src/check.js';
import type { OllamaTagsResponse } from '../src/backends/ollama/client.js';
import type { ModelInfo } from '../src/types.js';
import type { SystemMemoryState } from '../src/probes/types.js';
import { formulaEstimator } from '../src/estimators/formula.js';
import { GapCollector } from '../src/gaps.js';
import { mapTagsToLocalModels } from '../src/backends/ollama/index.js';
import { fixtureBackend, fixtureProbe, loadJsonFixture } from './helpers/fixture-backend.js';

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
      remoteCandidates: async () => [],
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
    expect(result.rows.filter((r) => r.source === 'local').length).toBe(4);
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
    expect(result.rows.filter((r) => r.source === 'local').length).toBe(4);
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
        backend: fixtureBackend({ loadedModels: async () => [], remoteCandidates: async () => remote }),
      })
    );
    const row = result.rows.find((r) => r.name === 'pd95/gptoss-mlx');
    expect(row).toBeDefined();
    expect(row!.source).toBe('remote');
    expect(row!.quantizationLevel).toBe('Q4_K_M'); // fallback, unknown quant
    // remote candidate with no parsed size should be excluded, not shown with a bogus estimate
    expect(result.rows.find((r) => r.name === 'mistral-large-3')).toBeUndefined();
  });

  it('uses the real size_vram for a model that is currently loaded, marked measured', async () => {
    const result = await runCheck(
      'mlx',
      makeDeps({ backend: fixtureBackend({ remoteCandidates: async () => [] }) })
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
      makeDeps({ backend: fixtureBackend({ remoteCandidates: async () => [] }) })
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
        backend: fixtureBackend({ loadedModels: async () => [], remoteCandidates: async () => remote }),
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
          remoteCandidates: async () => [],
        }),
      })
    );

    const unknownQuant = gaps.list().filter((g) => g.kind === 'unknown-quant');
    expect(unknownQuant.length).toBe(1);
    expect(unknownQuant[0].summary).toBe('unknown quantization "UD-Q4_K_XL"');
    expect(unknownQuant[0].evidence).toMatchObject({ quantizationLevel: 'UD-Q4_K_XL' });
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

  it('produces no measured rows when the backend lacks loadedModels', async () => {
    const result = await runCheck(
      'mlx',
      makeDeps({
        backend: fixtureBackend({ loadedModels: undefined, remoteCandidates: async () => [] }),
      })
    );

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((r) => r.estimateSource === 'estimated')).toBe(true);
  });
});
