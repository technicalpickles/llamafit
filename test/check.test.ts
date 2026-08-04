import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runCheck } from '../src/check.js';
import type { OllamaTagsResponse } from '../src/ollama-client.js';
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

describe('runCheck', () => {
  it('excludes cloud models from rows but lists them separately', async () => {
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
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
      readSystemMemory: () => fakeSystem,
      scrapeSearch: async () => [],
    });
    expect(result.baselineHeadroomGb).toBe(16); // 24 - 8
  });

  it('computes current headroom directly from live unused memory', async () => {
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
      readSystemMemory: () => fakeSystem,
      scrapeSearch: async () => [],
    });
    expect(result.currentHeadroomGb).toBeCloseTo(0.14, 5);
  });

  it('classifies gemma3:27b as will-thrash under current (near-zero) headroom', async () => {
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
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
});
