import { describe, expect, it } from 'vitest';
import type { Backend } from '../../src/backends/types.js';

/** Shared conformance suite for any Backend implementation. Not a test file itself
 * (excluded from vitest's `test/**\/*.test.ts` include) — invoked by each backend's own
 * test file, e.g. `describeBackendConformance('ollama', async () => ollamaBackend)`. */
export function describeBackendConformance(label: string, setup: () => Promise<Backend>): void {
  describe(`Backend conformance: ${label}`, () => {
    it('has non-empty id and displayName strings', async () => {
      const backend = await setup();
      expect(typeof backend.id).toBe('string');
      expect(backend.id.length).toBeGreaterThan(0);
      expect(typeof backend.displayName).toBe('string');
      expect(backend.displayName.length).toBeGreaterThan(0);
    });

    it('detect() resolves to a Detection shape and never rejects', async () => {
      const backend = await setup();
      const detection = await backend.detect();
      expect(typeof detection.detected).toBe('boolean');
      expect(detection.version === null || typeof detection.version === 'string').toBe(true);
      expect(typeof detection.evidence).toBe('object');
      expect(detection.evidence).not.toBeNull();
    });

    it('localModels() rows have source "local" and string names', async () => {
      const backend = await setup();
      const { models } = await backend.localModels();
      for (const model of models) {
        expect(model.source).toBe('local');
        expect(typeof model.name).toBe('string');
      }
    });

    it('every declared optional capability is a function', async () => {
      const backend = await setup();
      const optionalCapabilities = ['remoteCandidates', 'loadedModels', 'pull', 'unload'] as const;
      for (const capability of optionalCapabilities) {
        const value = backend[capability];
        if (value !== undefined) {
          expect(typeof value).toBe('function');
        }
      }
    });
  });
}
