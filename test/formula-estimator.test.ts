import { describe, expect, it } from 'vitest';
import { formulaEstimator, classifyVerdict } from '../src/estimators/formula.js';

const headroom = { baselineHeadroomGb: 16, currentHeadroomGb: 20.8 };

describe('formulaEstimator', () => {
  // Golden cases calibrated against real session measurements (see spec's Memory
  // Estimation Model section), ported from the old estimate.test.ts.

  it('matches the calibrated golden cases', () => {
    // llama3.2:3b Q4_K_M: 3.2B × 0.5625 × 1.25 = 2.25GB (measured 2.3GB)
    const e = formulaEstimator.estimate({ parameterSizeB: 3.2, quantizationLevel: 'Q4_K_M' }, headroom);
    expect(e.footprintGb).toBeCloseTo(2.25, 2);
    expect(e.quantKnown).toBe(true);
    expect(e.quantUsedForEstimate).toBe('Q4_K_M');
    expect(e.baselineVerdict).toBe('comfortable');
  });

  it('matches gemma3:12b closely (real param_size 12.2B, actual measured 8.64GB)', () => {
    const e = formulaEstimator.estimate({ parameterSizeB: 12.2, quantizationLevel: 'Q4_K_M' }, headroom);
    expect(e.footprintGb).toBeCloseTo(8.578125, 4);
    expect(e.quantKnown).toBe(true);
  });

  it('falls back on unknown quant and flags it', () => {
    const e = formulaEstimator.estimate({ parameterSizeB: 12, quantizationLevel: 'UD-Q4_K_XL' }, headroom);
    expect(e.quantKnown).toBe(false);
    expect(e.quantUsedForEstimate).toBe('Q4_K_M');
    expect(e.footprintGb).toBeCloseTo(12 * 0.5625 * 1.25, 2);
  });

  it('flags an unknown quant while still producing an estimate (empty quant string)', () => {
    const e = formulaEstimator.estimate({ parameterSizeB: 8, quantizationLevel: '' }, headroom);
    expect(e.quantKnown).toBe(false);
    expect(e.quantUsedForEstimate).toBe('Q4_K_M');
    expect(e.footprintGb).toBeCloseTo(8 * 0.5625 * 1.25, 4);
  });

  it('returns unknown verdicts when parameter size is unparseable', () => {
    const e = formulaEstimator.estimate({ parameterSizeB: null, quantizationLevel: 'Q4_K_M' }, headroom);
    expect(e).toEqual({
      footprintGb: null,
      quantKnown: false,
      quantUsedForEstimate: null,
      baselineVerdict: 'unknown',
      currentVerdict: 'unknown',
    });
  });

  // Quant recognition cases, ported from the old bytesPerParam test suite in
  // estimate.test.ts, re-expressed against formulaEstimator.estimate (parameterSizeB: 1
  // makes the bytesPerParam value directly visible in footprintGb).

  it('knows Q8_0', () => {
    const e = formulaEstimator.estimate({ parameterSizeB: 1, quantizationLevel: 'Q8_0' }, headroom);
    expect(e.quantKnown).toBe(true);
    expect(e.footprintGb).toBeCloseTo(1.25, 4);
  });

  it('knows F16 and BF16 as the same value', () => {
    const f16 = formulaEstimator.estimate({ parameterSizeB: 1, quantizationLevel: 'F16' }, headroom);
    const bf16 = formulaEstimator.estimate({ parameterSizeB: 1, quantizationLevel: 'BF16' }, headroom);
    expect(f16.footprintGb).toBeCloseTo(2.5, 4);
    expect(bf16.footprintGb).toBeCloseTo(2.5, 4);
  });

  it('knows fp8 case-insensitively (as seen in real /api/tags data)', () => {
    const e = formulaEstimator.estimate({ parameterSizeB: 1, quantizationLevel: 'fp8' }, headroom);
    expect(e.quantKnown).toBe(true);
    expect(e.footprintGb).toBeCloseTo(1.25, 4);
  });

  it('knows MXFP4 (as seen in real /api/tags data for gpt-oss:20b-cloud)', () => {
    const e = formulaEstimator.estimate({ parameterSizeB: 1, quantizationLevel: 'MXFP4' }, headroom);
    expect(e.quantKnown).toBe(true);
    expect(e.footprintGb).toBeCloseTo(0.625, 4);
  });

  it('knows NVFP4', () => {
    const e = formulaEstimator.estimate({ parameterSizeB: 1, quantizationLevel: 'NVFP4' }, headroom);
    expect(e.quantKnown).toBe(true);
    expect(e.footprintGb).toBeCloseTo(0.625, 4);
  });

  it('falls back to the Q4_K_M value for an unknown quant string, flagged as unknown', () => {
    const e = formulaEstimator.estimate({ parameterSizeB: 1, quantizationLevel: 'SOME_FUTURE_QUANT' }, headroom);
    expect(e.quantKnown).toBe(false);
    expect(e.footprintGb).toBeCloseTo(0.5625 * 1.25, 4);
  });
});

describe('classifyVerdict (thresholds from data)', () => {
  it('keeps the 70/95 boundaries (exact-boundary values stay in the lower class)', () => {
    expect(classifyVerdict(11.2, 16)).toBe('comfortable'); // exactly 70%
    expect(classifyVerdict(11.3, 16)).toBe('tight');
    expect(classifyVerdict(15.2, 16)).toBe('tight'); // exactly 95% stays tight, not thrash
    expect(classifyVerdict(15.21, 16)).toBe('will-thrash');
  });

  // Ported from the old classifyVerdict test suite in estimate.test.ts.

  it('is comfortable at or under 70% of headroom', () => {
    expect(classifyVerdict(7, 10)).toBe('comfortable');
    expect(classifyVerdict(6.9, 10)).toBe('comfortable');
  });

  it('is tight between 70% and 95% of headroom', () => {
    expect(classifyVerdict(8, 10)).toBe('tight');
    expect(classifyVerdict(9.4, 10)).toBe('tight');
  });

  it('will-thrash above 95% of headroom', () => {
    expect(classifyVerdict(9.6, 10)).toBe('will-thrash');
  });

  it('will-thrash when footprint exceeds headroom outright', () => {
    expect(classifyVerdict(17, 10)).toBe('will-thrash');
  });
});
