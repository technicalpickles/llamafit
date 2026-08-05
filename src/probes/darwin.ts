import { execFileSync } from 'node:child_process';
import type { SystemProbe, SystemMemoryState } from './types.js';

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

type Exec = (cmd: string, args: string[]) => string;
const realExec: Exec = (cmd, args) => execFileSync(cmd, args).toString();

export function createDarwinProbe(exec: Exec = realExec): SystemProbe {
  const commands = {
    'top -l 1 -s 0': () => exec('top', ['-l', '1', '-s', '0']),
    'sysctl vm.swapusage': () => exec('sysctl', ['vm.swapusage']),
    'sysctl -n hw.memsize': () => exec('sysctl', ['-n', 'hw.memsize']),
  };
  return {
    platform: 'darwin',
    async read(): Promise<SystemMemoryState> {
      const topText = commands['top -l 1 -s 0']();
      const swapText = commands['sysctl vm.swapusage']();
      const memText = commands['sysctl -n hw.memsize']();
      const { usedGb, wiredGb, compressorGb, unusedGb } = parseTopOutput(topText);
      const { swapTotalGb, swapUsedGb, swapFreeGb } = parseSwapUsage(swapText);
      return {
        totalGb: parseHwMemsize(memText),
        usedGb,
        wiredGb,
        compressorGb,
        unusedGb,
        swapTotalGb,
        swapUsedGb,
        swapFreeGb,
      };
    },
    async describe(): Promise<Record<string, string>> {
      const out: Record<string, string> = {};
      for (const [name, run] of Object.entries(commands)) {
        try {
          out[name] = run();
        } catch (err) {
          out[name] = `FAILED: ${(err as Error).message}`;
        }
      }
      return out;
    },
  };
}
