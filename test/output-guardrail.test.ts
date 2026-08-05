import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/check.js';
import { formatCheckTable, formatCheckJson, formatBenchResult } from '../src/format.js';
import type { BenchResult } from '../src/bench.js';
import type { OllamaTagsResponse, OllamaPsResponse } from '../src/ollama-client.js';
import type { SystemMemoryState } from '../src/system-memory.js';

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8'));
}

const SYSTEM: SystemMemoryState = {
  totalGb: 24,
  usedGb: 12.5,
  wiredGb: 3.2,
  compressorGb: 1.1,
  unusedGb: 0.4,
  swapTotalGb: 2,
  swapUsedGb: 0.5,
  swapFreeGb: 1.5,
};

const deps = {
  fetchTags: async () => loadFixture<OllamaTagsResponse>('api-tags.json'),
  fetchPs: async () => loadFixture<OllamaPsResponse>('api-ps-loaded.json'),
  readSystemMemory: () => SYSTEM,
  scrapeSearch: async (_query: string) => {
    const { parseSearchResults } = await import('../src/scrape.js');
    return parseSearchResults(
      readFileSync(new URL('./fixtures/ollama-search-mlx.html', import.meta.url), 'utf8')
    );
  },
};

const BENCH: BenchResult = {
  model: 'gemma3:12b',
  status: 'completed',
  sizeVramGb: 8.6,
  evalTokensPerSecond: 23.4,
  loadDurationSeconds: 4.2,
  totalDurationSeconds: 18.9,
  memoryBefore: SYSTEM,
  memoryAfter: { ...SYSTEM, usedGb: 20.1, wiredGb: 3.4, swapUsedGb: 0.9 },
};

describe('output guardrail (must stay byte-identical through the carve-out)', () => {
  it('check table', async () => {
    const result = await runCheck('mlx', deps);
    await expect(formatCheckTable(result, { color: false })).toMatchFileSnapshot(
      './fixtures/guardrail-check-table.txt'
    );
  });

  it('check json', async () => {
    const result = await runCheck('mlx', deps);
    await expect(formatCheckJson(result)).toMatchFileSnapshot('./fixtures/guardrail-check.json');
  });

  it('bench output', () => {
    return expect(formatBenchResult(BENCH, { color: false })).toMatchFileSnapshot(
      './fixtures/guardrail-bench.txt'
    );
  });
});
