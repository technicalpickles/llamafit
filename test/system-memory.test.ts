import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTopOutput, parseSwapUsage, parseHwMemsize } from '../src/system-memory.js';

function loadFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');
}

describe('parseTopOutput', () => {
  it('parses the real captured PhysMem line', () => {
    const result = parseTopOutput(loadFixture('top-output.txt'));
    expect(result.usedGb).toBeCloseTo(23, 5);
    expect(result.wiredGb).toBeCloseTo(3910 / 1024, 5);
    expect(result.compressorGb).toBeCloseTo(9538 / 1024, 5);
    expect(result.unusedGb).toBeCloseTo(145 / 1024, 5);
  });

  it('throws a clear error on unparseable input', () => {
    expect(() => parseTopOutput('garbage')).toThrow(/Could not parse/);
  });
});

describe('parseSwapUsage', () => {
  it('parses the real captured vm.swapusage line', () => {
    const result = parseSwapUsage(loadFixture('swapusage-output.txt'));
    expect(result.swapTotalGb).toBeCloseTo(12, 5);
    expect(result.swapUsedGb).toBeCloseTo(10700.44 / 1024, 5);
    expect(result.swapFreeGb).toBeCloseTo(1587.56 / 1024, 5);
  });

  it('throws a clear error on unparseable input', () => {
    expect(() => parseSwapUsage('garbage')).toThrow(/Could not parse/);
  });
});

describe('parseHwMemsize', () => {
  it('parses the real captured hw.memsize bytes into GB', () => {
    const result = parseHwMemsize(loadFixture('hw-memsize.txt'));
    expect(result).toBeCloseTo(24, 5);
  });
});
