import { describe, expect, it } from 'vitest';
import { allBackends, findBackend, detectBackends } from '../src/backends/registry.js';
import type { Backend } from '../src/backends/types.js';

const fakeBackend = (id: string, detected: boolean): Backend => ({
  id,
  displayName: id,
  detect: async () => ({ detected, version: null, evidence: {} }),
  localModels: async () => ({ models: [], skipped: [] }),
  generate: async () => null,
});

describe('backend registry', () => {
  it('lists ollama', () => {
    expect(allBackends().map((b) => b.id)).toContain('ollama');
    expect(findBackend('ollama')?.id).toBe('ollama');
    expect(findBackend('nope')).toBeNull();
  });
  it('detectBackends keeps only detected ones', async () => {
    const hits = await detectBackends([fakeBackend('a', true), fakeBackend('b', false)]);
    expect(hits.map((h) => h.backend.id)).toEqual(['a']);
  });
});
