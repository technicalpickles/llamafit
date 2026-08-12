import type { ModelInfo } from '../types.js';
import type { HfCandidate } from './discovery.js';
import { loadQuantTable, type QuantEntry, type QuantTable } from '../data.js';

function findEntry(table: QuantTable, raw: string): QuantEntry | undefined {
  const key = raw.trim().toUpperCase();
  return table.entries.find((e) => e.id === key || e.aliases.includes(key));
}

/** A repo ships many quants, so no single one describes it — but the estimate
 * has to assume something, and assuming the table's fallback blindly is worse
 * than reading what the repo actually publishes. Prefer the fallback quant when
 * offered (it is the common default), else the nearest bytes-per-param,
 * resolving ties toward the smaller value. Returns null when nothing offered is
 * in the table, which keeps today's behaviour for exotic repos. */
export function pickQuant(availableQuants: string[], table: QuantTable): string | null {
  const known = availableQuants
    .map((raw) => findEntry(table, raw))
    .filter((e): e is QuantEntry => e !== undefined);
  if (known.length === 0) return null;

  const target = table.entries.find((e) => e.id === table.fallback)!;
  const exact = known.find((e) => e.id === target.id);
  if (exact) return exact.id;

  return known.reduce((best, e) => {
    const de = Math.abs(e.bytesPerParam - target.bytesPerParam);
    const db = Math.abs(best.bytesPerParam - target.bytesPerParam);
    if (de < db) return e;
    if (de === db && e.bytesPerParam < best.bytesPerParam) return e;
    return best;
  }).id;
}

/** Shared HF candidate → ModelInfo mapping. Per the remote-candidates spec,
 * only the pull-name shape is per-backend: llama-server uses the bare repoId,
 * ollama uses `hf.co/<repoId>`. */
export function hfCandidatesToModelInfo(
  candidates: HfCandidate[],
  toName: (c: HfCandidate) => string
): ModelInfo[] {
  const table = loadQuantTable();
  return candidates.map((c) => ({
    name: toName(c),
    source: 'remote',
    url: c.url,
    parameterSizeB: c.parameterSizeB,
    quantizationLevel: pickQuant(c.availableQuants, table),
    diskSizeBytes: null,
    author: c.author,
    availableQuants: c.availableQuants,
    signals: c.signals,
    discoverySource: 'huggingface',
  }));
}
