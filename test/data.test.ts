import { describe, expect, it } from 'vitest';
import { loadQuantTable, lookupQuant, loadCalibration, loadThresholds } from '../src/data.js';

describe('data layer', () => {
  it('quant table parses and preserves current values', () => {
    const table = loadQuantTable();
    expect(lookupQuant(table, 'Q4_K_M')).toEqual({ id: 'Q4_K_M', bytesPerParam: 0.5625, known: true });
    expect(lookupQuant(table, 'bf16')).toEqual({ id: 'F16', bytesPerParam: 2.0, known: true });
  });
  it('unknown or empty quant falls back, flagged unknown', () => {
    const table = loadQuantTable();
    expect(lookupQuant(table, 'UD-Q4_K_XL')).toEqual({ id: 'Q4_K_M', bytesPerParam: 0.5625, known: false });
    expect(lookupQuant(table, '')).toEqual({ id: 'Q4_K_M', bytesPerParam: 0.5625, known: false });
  });
  it('quant ids and aliases are unique across the table', () => {
    const table = loadQuantTable();
    const names = table.entries.flatMap((e) => [e.id, ...e.aliases]);
    expect(new Set(names).size).toBe(names.length);
  });
  it('calibration has the 1.25 default and provenance for it', () => {
    const cal = loadCalibration();
    expect(cal.overheadMultiplier).toBe(1.25);
    expect(cal.provenance.length).toBeGreaterThanOrEqual(3);
  });
  it('thresholds carry current verdict ratios and darwin reserve', () => {
    expect(loadThresholds()).toEqual({
      tightRatio: 0.7,
      thrashRatio: 0.95,
      baselineReserveGb: { darwin: 8 },
    });
  });
});
