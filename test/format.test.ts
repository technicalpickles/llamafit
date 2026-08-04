import { describe, it, expect } from 'vitest';
import { formatCheckTable, formatCheckJson } from '../src/format.js';
import type { CheckResult } from '../src/check.js';

const sampleResult: CheckResult = {
  rows: [
    {
      name: 'gemma3:12b',
      source: 'local',
      parameterSizeB: 12.2,
      quantizationLevel: 'Q4_K_M',
      footprintGb: 8.58,
      baselineVerdict: 'comfortable',
      currentVerdict: 'will-thrash',
    },
  ],
  cloudModels: ['glm-5.2:cloud'],
  system: {
    totalGb: 24,
    usedGb: 23,
    wiredGb: 3.8,
    compressorGb: 9.3,
    unusedGb: 0.14,
    swapTotalGb: 12,
    swapUsedGb: 10.4,
    swapFreeGb: 1.5,
  },
  baselineHeadroomGb: 16,
  currentHeadroomGb: 0.14,
  scrapeWarning: null,
};

describe('formatCheckTable', () => {
  it('includes the model name and both verdicts', () => {
    const table = formatCheckTable(sampleResult);
    expect(table).toContain('gemma3:12b');
    expect(table).toContain('comfortable');
    expect(table).toContain('will-thrash');
  });

  it('lists cloud models separately with a note that they run remotely', () => {
    const table = formatCheckTable(sampleResult);
    expect(table).toContain('glm-5.2:cloud');
    expect(table.toLowerCase()).toContain('cloud');
  });

  it('shows a scrape warning when present', () => {
    const table = formatCheckTable({ ...sampleResult, scrapeWarning: 'could not reach ollama.com' });
    expect(table).toContain('could not reach ollama.com');
  });
});

describe('formatCheckJson', () => {
  it('round-trips the result as valid JSON', () => {
    const json = formatCheckJson(sampleResult);
    const parsed = JSON.parse(json);
    expect(parsed.rows[0].name).toBe('gemma3:12b');
  });
});
