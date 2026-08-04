import { execFileSync } from 'node:child_process';

export interface SystemMemoryState {
  totalGb: number;
  usedGb: number;
  wiredGb: number;
  compressorGb: number;
  unusedGb: number;
  swapTotalGb: number;
  swapUsedGb: number;
  swapFreeGb: number;
}

function toGb(value: number, unit: string): number {
  return unit === 'G' ? value : value / 1024;
}

export function parseTopOutput(text: string): {
  usedGb: number;
  wiredGb: number;
  compressorGb: number;
  unusedGb: number;
} {
  const match = text.match(
    /PhysMem:\s+([\d.]+)([GM])\s+used\s+\(([\d.]+)([GM])\s+wired,\s+([\d.]+)([GM])\s+compressor\),\s+([\d.]+)([GM])\s+unused\./
  );
  if (!match) {
    throw new Error(`Could not parse 'top' PhysMem line: ${text}`);
  }
  const [, usedVal, usedUnit, wiredVal, wiredUnit, compVal, compUnit, unusedVal, unusedUnit] = match;
  return {
    usedGb: toGb(parseFloat(usedVal), usedUnit),
    wiredGb: toGb(parseFloat(wiredVal), wiredUnit),
    compressorGb: toGb(parseFloat(compVal), compUnit),
    unusedGb: toGb(parseFloat(unusedVal), unusedUnit),
  };
}

export function parseSwapUsage(text: string): {
  swapTotalGb: number;
  swapUsedGb: number;
  swapFreeGb: number;
} {
  const match = text.match(/total = ([\d.]+)M\s+used = ([\d.]+)M\s+free = ([\d.]+)M/);
  if (!match) {
    throw new Error(`Could not parse 'sysctl vm.swapusage' output: ${text}`);
  }
  const [, totalMb, usedMb, freeMb] = match;
  return {
    swapTotalGb: parseFloat(totalMb) / 1024,
    swapUsedGb: parseFloat(usedMb) / 1024,
    swapFreeGb: parseFloat(freeMb) / 1024,
  };
}

/** Returns GB (binary, i.e. GiB, matching top/vm_stat's own units). */
export function parseHwMemsize(text: string): number {
  const bytes = parseInt(text.trim(), 10);
  if (Number.isNaN(bytes)) {
    throw new Error(`Could not parse 'sysctl -n hw.memsize' output: ${text}`);
  }
  return bytes / 1024 ** 3;
}

/** Live system read — thin adapter, not unit tested directly (see spec's Testing section). */
export function readSystemMemory(): SystemMemoryState {
  const topText = execFileSync('top', ['-l', '1', '-s', '0']).toString();
  const swapText = execFileSync('sysctl', ['vm.swapusage']).toString();
  const memText = execFileSync('sysctl', ['-n', 'hw.memsize']).toString();

  const { usedGb, wiredGb, compressorGb, unusedGb } = parseTopOutput(topText);
  const { swapTotalGb, swapUsedGb, swapFreeGb } = parseSwapUsage(swapText);
  const totalGb = parseHwMemsize(memText);

  return { totalGb, usedGb, wiredGb, compressorGb, unusedGb, swapTotalGb, swapUsedGb, swapFreeGb };
}
