import { describe, it, expect } from 'vitest';
import { bytesPerParam, estimateFootprint, classifyVerdict } from '../src/estimate.js';

describe('bytesPerParam', () => {
  it('knows Q4_K_M', () => {
    expect(bytesPerParam('Q4_K_M')).toEqual({ value: 0.5625, known: true });
  });

  it('knows Q8_0', () => {
    expect(bytesPerParam('Q8_0')).toEqual({ value: 1.0, known: true });
  });

  it('knows F16 and BF16 as the same value', () => {
    expect(bytesPerParam('F16').value).toBe(2.0);
    expect(bytesPerParam('BF16').value).toBe(2.0);
  });

  it('knows fp8 case-insensitively (as seen in real /api/tags data)', () => {
    expect(bytesPerParam('fp8')).toEqual({ value: 1.0, known: true });
  });

  it('knows MXFP4 (as seen in real /api/tags data for gpt-oss:20b-cloud)', () => {
    expect(bytesPerParam('MXFP4')).toEqual({ value: 0.5, known: true });
  });

  it('knows NVFP4', () => {
    expect(bytesPerParam('NVFP4').value).toBe(0.5);
  });

  it('falls back to the Q4_K_M value for an unknown quant string, flagged as unknown', () => {
    const result = bytesPerParam('SOME_FUTURE_QUANT');
    expect(result.known).toBe(false);
    expect(result.value).toBe(0.5625);
  });

  it('falls back for an empty quant string (as seen for some cloud models)', () => {
    const result = bytesPerParam('');
    expect(result.known).toBe(false);
    expect(result.value).toBe(0.5625);
  });
});

describe('estimateFootprint', () => {
  // Golden cases calibrated against this session's real measurements
  // (see spec's Memory Estimation Model section).

  it('matches llama3.2:3b closely (predicted weights 1.8GB, actual measured 2.3GB)', () => {
    const result = estimateFootprint(3.2, 'Q4_K_M');
    expect(result.weightsGb).toBeCloseTo(1.8, 4);
    expect(result.estimatedFootprintGb).toBeCloseTo(2.25, 4);
    expect(result.quantKnown).toBe(true);
    expect(result.quantUsedForEstimate).toBe('Q4_K_M');
  });

  it('matches gemma3:12b closely (real param_size 12.2B, actual measured 8.64GB)', () => {
    const result = estimateFootprint(12.2, 'Q4_K_M');
    expect(result.weightsGb).toBeCloseTo(6.8625, 4);
    expect(result.estimatedFootprintGb).toBeCloseTo(8.578125, 4);
  });

  it('flags an unknown quant while still producing an estimate', () => {
    const result = estimateFootprint(8, '');
    expect(result.quantKnown).toBe(false);
    expect(result.quantUsedForEstimate).toBe('Q4_K_M');
    expect(result.weightsGb).toBeCloseTo(4.5, 4);
  });
});

describe('classifyVerdict', () => {
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
