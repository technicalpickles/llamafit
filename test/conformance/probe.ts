import { describe, expect, it } from 'vitest';
import type { SystemProbe } from '../../src/probes/types.js';

/** Shared conformance suite for any SystemProbe implementation. Not a test file itself
 * (excluded from vitest's `test/**\/*.test.ts` include) — invoked by each probe's own
 * test file, e.g. `describeProbeConformance('darwin', async () => createDarwinProbe(fakeExec))`. */
export function describeProbeConformance(label: string, setup: () => Promise<SystemProbe>): void {
  describe(`SystemProbe conformance: ${label}`, () => {
    it('has a non-empty platform string', async () => {
      const probe = await setup();
      expect(typeof probe.platform).toBe('string');
      expect(probe.platform.length).toBeGreaterThan(0);
    });

    it('read() resolves to a SystemMemoryState with finite non-negative fields', async () => {
      const probe = await setup();
      const state = await probe.read();
      const fields = [
        'totalGb',
        'usedGb',
        'wiredGb',
        'compressorGb',
        'unusedGb',
        'swapTotalGb',
        'swapUsedGb',
        'swapFreeGb',
      ] as const;
      for (const field of fields) {
        const value = state[field];
        expect(Number.isFinite(value), `${field} should be finite`).toBe(true);
        expect(value, `${field} should be >= 0`).toBeGreaterThanOrEqual(0);
      }
      expect(state.totalGb).toBeGreaterThan(0);
    });

    it('describe() resolves to a non-empty Record<string, string> and never rejects', async () => {
      const probe = await setup();
      const evidence = await probe.describe();
      const entries = Object.entries(evidence);
      expect(entries.length).toBeGreaterThan(0);
      for (const [key, value] of entries) {
        expect(typeof key).toBe('string');
        expect(typeof value).toBe('string');
      }
    });
  });
}
