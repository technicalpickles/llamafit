import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTopOutput, parseSwapUsage, parseHwMemsize, createDarwinProbe } from '../src/probes/darwin.js';
import { selectProbe } from '../src/probes/registry.js';
import { describeProbeConformance } from './conformance/probe.js';

function loadFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');
}

const fixtureText = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const fakeExec = (cmd: string, args: string[]): string => {
  if (cmd === 'top') return fixtureText('top-output.txt');
  if (cmd === 'sysctl' && args[0] === 'vm.swapusage') return fixtureText('swapusage-output.txt');
  if (cmd === 'sysctl' && args[0] === '-n') return fixtureText('hw-memsize.txt');
  throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
};

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

describeProbeConformance('darwin', async () => createDarwinProbe(fakeExec));

describe('darwin probe', () => {
  it('read() assembles SystemMemoryState from the three commands', async () => {
    const state = await createDarwinProbe(fakeExec).read();
    expect(state.totalGb).toBeGreaterThan(0);
    expect(state.wiredGb).toBeGreaterThan(0);
    expect(state.swapTotalGb).toBeGreaterThanOrEqual(0);
  });
  it('describe() returns the raw outputs for diagnostics', async () => {
    const evidence = await createDarwinProbe(fakeExec).describe();
    expect(Object.keys(evidence).sort()).toEqual(['sysctl -n hw.memsize', 'sysctl vm.swapusage', 'top -l 1 -s 0']);
    expect(evidence['top -l 1 -s 0']).toContain('PhysMem');
  });
});

describe('probe registry', () => {
  it('selects darwin', () => expect(selectProbe('darwin')?.platform).toBe('darwin'));
  it('returns null for unsupported platforms', () => expect(selectProbe('freebsd')).toBeNull());
});
