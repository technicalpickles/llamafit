import { readFileSync } from 'node:fs';
import type { Backend } from '../../src/backends/types.js';
import type { SystemProbe, SystemMemoryState } from '../../src/probes/types.js';
import type { OllamaTagsResponse, OllamaPsResponse } from '../../src/backends/ollama/client.js';
import {
  mapTagsToLocalModels,
  mapPsToLoaded,
  mapCandidates,
} from '../../src/backends/ollama/index.js';
import { parseSearchResults } from '../../src/backends/ollama/scrape.js';

export function loadJsonFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf-8')) as T;
}

export function loadTextFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf-8');
}

/**
 * A Backend backed entirely by checked-in fixtures, shared by the check/bench/guardrail
 * tests. It runs the fixtures through the *same* mapping functions the real ollamaBackend
 * uses, so a mapping bug can't hide behind hand-rolled test data.
 *
 * Override any member to shape a scenario, including setting an optional capability to
 * `undefined` to model a backend that can't do that thing.
 */
export function fixtureBackend(overrides: Partial<Backend> = {}): Backend {
  const base: Backend = {
    id: 'fixture',
    displayName: 'Fixture',
    detect: async () => ({ detected: true, version: '0.0.0-fixture', evidence: {} }),
    localModels: async () =>
      mapTagsToLocalModels(loadJsonFixture<OllamaTagsResponse>('api-tags.json')),
    generate: async () => ({
      evalCount: 100,
      evalDurationSeconds: 4,
      loadDurationSeconds: 1,
      totalDurationSeconds: 6,
    }),
    remoteCandidates: async (query?: string) => ({
      candidates: mapCandidates(parseSearchResults(loadTextFixture('ollama-search-mlx.html'))),
      sources: [{ id: 'ollama.com', query: query ?? 'mlx', ok: true }],
    }),
    loadedModels: async () => mapPsToLoaded(loadJsonFixture<OllamaPsResponse>('api-ps-loaded.json')),
    pull: async () => {},
    unload: async () => {},
  };
  return { ...base, ...overrides };
}

export function fixtureProbe(state: SystemMemoryState): SystemProbe {
  return {
    platform: 'darwin',
    read: async () => state,
    describe: async () => ({}),
  };
}
