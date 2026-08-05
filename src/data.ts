import { readFileSync } from 'node:fs';

export interface QuantEntry { id: string; bytesPerParam: number; aliases: string[] }
export interface QuantTable { entries: QuantEntry[]; fallback: string }
export interface Provenance { backend: string; model: string; predictedWeightsGb: number; measuredVramGb: number }
export interface Calibration {
  overheadMultiplier: number;
  provenance: Provenance[];
  backends: Record<string, { overheadMultiplier: number }>;
}
export interface Thresholds {
  tightRatio: number;
  thrashRatio: number;
  baselineReserveGb: Record<string, number>;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(new URL(`../data/${file}`, import.meta.url), 'utf8'));
}

function fail(file: string, problem: string): never {
  throw new Error(`data/${file}: ${problem}`);
}

let quantTable: QuantTable | null = null;
export function loadQuantTable(): QuantTable {
  if (quantTable) return quantTable;
  const raw = readJson('quants.json') as QuantTable;
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) fail('quants.json', 'entries must be a non-empty array');
  const seen = new Set<string>();
  for (const e of raw.entries) {
    if (typeof e.id !== 'string' || typeof e.bytesPerParam !== 'number' || e.bytesPerParam <= 0 || !Array.isArray(e.aliases)) {
      fail('quants.json', `malformed entry: ${JSON.stringify(e)}`);
    }
    for (const name of [e.id, ...e.aliases]) {
      if (seen.has(name)) fail('quants.json', `duplicate quant name: ${name}`);
      seen.add(name);
    }
  }
  if (!raw.entries.some((e) => e.id === raw.fallback)) fail('quants.json', `fallback ${raw.fallback} has no entry`);
  quantTable = raw;
  return raw;
}

export function lookupQuant(table: QuantTable, rawQuant: string): { id: string; bytesPerParam: number; known: boolean } {
  const key = rawQuant.trim().toUpperCase();
  const entry =
    key.length > 0
      ? table.entries.find((e) => e.id === key || e.aliases.includes(key))
      : undefined;
  if (entry) return { id: entry.id, bytesPerParam: entry.bytesPerParam, known: true };
  const fallback = table.entries.find((e) => e.id === table.fallback)!;
  return { id: fallback.id, bytesPerParam: fallback.bytesPerParam, known: false };
}

let calibration: Calibration | null = null;
export function loadCalibration(): Calibration {
  if (calibration) return calibration;
  const raw = readJson('calibration.json') as Calibration;
  if (typeof raw.overheadMultiplier !== 'number' || raw.overheadMultiplier < 1) {
    fail('calibration.json', 'overheadMultiplier must be a number >= 1');
  }
  if (!Array.isArray(raw.provenance) || raw.provenance.length === 0) {
    fail('calibration.json', 'provenance must be a non-empty array (every multiplier needs evidence)');
  }
  calibration = raw;
  return raw;
}

let thresholds: Thresholds | null = null;
export function loadThresholds(): Thresholds {
  if (thresholds) return thresholds;
  const raw = readJson('thresholds.json') as Thresholds;
  if (!(raw.tightRatio > 0 && raw.tightRatio < raw.thrashRatio && raw.thrashRatio <= 1)) {
    fail('thresholds.json', 'need 0 < tightRatio < thrashRatio <= 1');
  }
  if (typeof raw.baselineReserveGb !== 'object' || raw.baselineReserveGb === null) {
    fail('thresholds.json', 'baselineReserveGb must be an object keyed by platform');
  }
  thresholds = raw;
  return raw;
}
