import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runCheck } from '../src/check.js';
import type { OllamaTagsResponse, OllamaPsResponse } from '../src/ollama-client.js';
import type { SystemMemoryState } from '../src/system-memory.js';
import type { RemoteModelCandidate } from '../src/scrape.js';

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8'));
}

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

/** Nothing loaded: every row should fall back to the formula estimate. */
const emptyPs = loadFixture<OllamaPsResponse>('api-ps-empty.json');

describe('runCheck', () => {
  it('excludes cloud models from rows but lists them separately', async () => {
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
      fetchPs: async () => emptyPs,
      readSystemMemory: () => fakeSystem,
      scrapeSearch: async () => [],
    });

    expect(result.rows.every((r) => r.source !== 'local' || !r.name.includes(':cloud'))).toBe(true);
    expect(result.cloudModels).toContain('glm-5.2:cloud');
    expect(result.rows.filter((r) => r.source === 'local').length).toBe(4);
  });

  it('computes baseline headroom as total minus the fixed macOS reserve', async () => {
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
      fetchPs: async () => emptyPs,
      readSystemMemory: () => fakeSystem,
      scrapeSearch: async () => [],
    });
    expect(result.baselineHeadroomGb).toBe(16); // 24 - 8
  });

  it('computes current headroom as total minus wired, not the near-zero unused figure', async () => {
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
      fetchPs: async () => emptyPs,
      readSystemMemory: () => fakeSystem,
      scrapeSearch: async () => [],
    });
    // 24 total - 3.8 wired. macOS's `unused` (0.14 here) is near-zero even when idle
    // because the compressor and caches claim free RAM, so it is not usable headroom.
    expect(result.currentHeadroomGb).toBeCloseTo(20.2, 5);
  });

  it('classifies gemma3:27b as will-thrash under current headroom', async () => {
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
      fetchPs: async () => emptyPs,
      readSystemMemory: () => fakeSystem,
      scrapeSearch: async () => [],
    });
    const row = result.rows.find((r) => r.name === 'gemma3:27b');
    expect(row).toBeDefined();
    expect(row!.currentVerdict).toBe('will-thrash');
  });

  it('degrades gracefully when scraping fails, keeping local results', async () => {
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
      fetchPs: async () => emptyPs,
      readSystemMemory: () => fakeSystem,
      scrapeSearch: async () => {
        throw new Error('network unreachable');
      },
    });
    expect(result.scrapeWarning).toMatch(/network unreachable/);
    expect(result.rows.filter((r) => r.source === 'local').length).toBe(4);
  });

  it('includes remote candidates with a parsed size, using the unknown-quant fallback', async () => {
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const remote: RemoteModelCandidate[] = [
      { name: 'pd95/gptoss-mlx', description: '', parameterSizeB: 20, sizeSource: 'badge' },
      { name: 'mistral-large-3', description: '', parameterSizeB: null, sizeSource: 'unknown' },
    ];
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
      fetchPs: async () => emptyPs,
      readSystemMemory: () => fakeSystem,
      scrapeSearch: async () => remote,
    });
    const row = result.rows.find((r) => r.name === 'pd95/gptoss-mlx');
    expect(row).toBeDefined();
    expect(row!.source).toBe('remote');
    expect(row!.quantizationLevel).toBe('Q4_K_M'); // fallback, unknown quant
    // remote candidate with no parsed size should be excluded, not shown with a bogus estimate
    expect(result.rows.find((r) => r.name === 'mistral-large-3')).toBeUndefined();
  });

  it('uses the real size_vram for a model that is currently loaded, marked measured', async () => {
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const loadedPs = loadFixture<OllamaPsResponse>('api-ps-loaded.json');
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
      fetchPs: async () => loadedPs,
      readSystemMemory: () => fakeSystem,
      scrapeSearch: async () => [],
    });

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
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const loadedPs = loadFixture<OllamaPsResponse>('api-ps-loaded.json');
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
      fetchPs: async () => loadedPs,
      readSystemMemory: () => fakeSystem,
      scrapeSearch: async () => [],
    });

    const row = result.rows.find((r) => r.name === 'gemma3:27b');
    expect(row).toBeDefined();
    expect(row!.estimateSource).toBe('estimated');
    expect(row!.quantKnown).toBe(true); // Q4_K_M is reported by /api/tags
    expect(row!.footprintGb).toBeCloseTo(27.4 * 0.5625 * 1.25, 5);
  });

  it('flags a remote row as an estimate built on an unknown quantization', async () => {
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const remote: RemoteModelCandidate[] = [
      { name: 'pd95/gptoss-mlx', description: '', parameterSizeB: 20, sizeSource: 'badge' },
    ];
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
      fetchPs: async () => emptyPs,
      readSystemMemory: () => fakeSystem,
      scrapeSearch: async () => remote,
    });
    const row = result.rows.find((r) => r.name === 'pd95/gptoss-mlx');
    expect(row!.estimateSource).toBe('estimated');
    expect(row!.quantKnown).toBe(false);
  });
});
