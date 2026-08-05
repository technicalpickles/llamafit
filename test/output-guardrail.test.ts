import { describe, expect, it } from 'vitest';
import { runCheck, type CheckDeps } from '../src/check.js';
import { formatCheckTable, formatCheckJson, formatBenchResult } from '../src/format.js';
import type { BenchResult } from '../src/bench.js';
import type { SystemMemoryState } from '../src/probes/types.js';
import { formulaEstimator } from '../src/estimators/formula.js';
import { GapCollector } from '../src/gaps.js';
import { fixtureBackend, fixtureProbe } from './helpers/fixture-backend.js';

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

function deps(): CheckDeps {
  return {
    backend: fixtureBackend(),
    probe: fixtureProbe(SYSTEM),
    estimator: formulaEstimator,
    gaps: new GapCollector(),
  };
}

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
    const result = await runCheck('mlx', deps());
    await expect(formatCheckTable(result, { color: false })).toMatchFileSnapshot(
      './fixtures/guardrail-check-table.txt'
    );
  });

  it('check json', async () => {
    const result = await runCheck('mlx', deps());
    await expect(formatCheckJson(result)).toMatchFileSnapshot('./fixtures/guardrail-check.json');
  });

  it('bench output', () => {
    return expect(formatBenchResult(BENCH, { color: false })).toMatchFileSnapshot(
      './fixtures/guardrail-bench.txt'
    );
  });
});
