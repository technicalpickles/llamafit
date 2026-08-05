import { describe, expect, it } from 'vitest';
import { GapCollector } from '../src/gaps.js';

describe('GapCollector', () => {
  it('collects gaps in order', () => {
    const gaps = new GapCollector();
    gaps.add({ kind: 'scrape-failed', summary: 'ollama.com returned 500', evidence: { status: 500 } });
    gaps.add({ kind: 'unknown-quant', summary: 'unknown quantization "UD-Q4_K_XL"', evidence: { quant: 'UD-Q4_K_XL' } });
    expect(gaps.list().map((g) => g.kind)).toEqual(['scrape-failed', 'unknown-quant']);
  });
  it('dedupes identical kind+summary', () => {
    const gaps = new GapCollector();
    const gap = { kind: 'unknown-quant' as const, summary: 'unknown quantization "UD-Q4_K_XL"', evidence: { model: 'a' } };
    gaps.add(gap);
    gaps.add({ ...gap, evidence: { model: 'b' } });
    expect(gaps.list()).toHaveLength(1);
  });
});
