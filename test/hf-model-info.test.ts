import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { hfCandidatesToModelInfo, pickQuant } from '../src/hf/model-info.js';
import { mapHitToCandidate, type HfModelHit } from '../src/hf/discovery.js';
import { loadQuantTable, lookupQuant, type QuantTable } from '../src/data.js';

function loadHits(): HfModelHit[] {
  return JSON.parse(
    readFileSync(new URL('./fixtures/hf-models-search.json', import.meta.url), 'utf-8')
  );
}

describe('hfCandidatesToModelInfo', () => {
  const candidates = loadHits().map(mapHitToCandidate);

  it('maps candidates through the caller-supplied name shape', () => {
    const rows = hfCandidatesToModelInfo(candidates, (c) => `hf.co/${c.repoId}`);
    expect(rows[0].name).toBe(`hf.co/${candidates[0].repoId}`);
    expect(rows[0].source).toBe('remote');
    expect(rows[0].url).toBe(candidates[0].url);
    expect(rows[0].author).toBe(candidates[0].author);
    expect(rows[0].availableQuants).toEqual(candidates[0].availableQuants);
    expect(rows[0].signals).toEqual(candidates[0].signals);
  });

  it('never assigns a per-repo disk size', () => {
    const rows = hfCandidatesToModelInfo(candidates, (c) => c.repoId);
    expect(rows.every((r) => r.diskSizeBytes === null)).toBe(true);
  });

  it('sets a non-null quantizationLevel for every real repo that publishes a table-known quant', () => {
    const table = loadQuantTable();
    const rows = hfCandidatesToModelInfo(candidates, (c) => c.repoId);
    for (const row of rows) {
      const candidate = candidates.find((c) => c.repoId === row.name)!;
      const offersKnownQuant = candidate.availableQuants.some((q) => lookupQuant(table, q).known);
      expect(row.quantizationLevel !== null).toBe(offersKnownQuant);
    }
    // Anchor on a specific real repo rather than only the aggregate check above.
    const ornith = rows.find((r) => r.name === 'ornith-ai/Ornith-1.0-9B-GGUF');
    expect(ornith).toBeDefined();
    expect(ornith!.quantizationLevel).toBe('Q4_K_M');
  });
});

describe('pickQuant', () => {
  const table = loadQuantTable();

  it('prefers the table fallback quant when the repo offers it', () => {
    expect(pickQuant(['BF16', 'Q8_0', 'Q4_K_M', 'Q6_K'], table)).toBe('Q4_K_M');
  });

  it('picks the nearest bytes-per-param when the fallback is absent', () => {
    // Q4_K_M is 0.5625. Q4_0 is 0.5 (Δ0.0625), Q5_K_M is 0.69 (Δ0.1275).
    expect(pickQuant(['Q8_0', 'Q5_K_M', 'Q4_0'], table)).toBe('Q4_0');
  });

  it('resolves an alias to its canonical id via the nearest-match branch', () => {
    // MXFP4 is an alias of Q4_0, not of the fallback Q4_K_M -- this exercises
    // alias resolution inside the nearest-bytes-per-param branch, not the
    // fallback-preferred branch.
    expect(pickQuant(['MXFP4'], table)).toBe('Q4_0');
  });

  it('breaks an exact tie toward the smaller value', () => {
    // No two entries in data/quants.json are equidistant from Q4_K_M, so the
    // tie-break is unreachable with the real table. Test it against a synthetic
    // one rather than leave the rule uncovered — pickQuant takes the table as a
    // parameter precisely so this is possible.
    const synthetic: QuantTable = {
      fallback: 'MID',
      entries: [
        { id: 'MID', bytesPerParam: 0.5, aliases: [] },
        { id: 'HIGH', bytesPerParam: 0.6, aliases: [] },
        { id: 'LOW', bytesPerParam: 0.4, aliases: [] },
      ],
    };
    expect(pickQuant(['HIGH', 'LOW'], synthetic)).toBe('LOW');
    // Order-independent: the reducer must not just take whichever came first.
    expect(pickQuant(['LOW', 'HIGH'], synthetic)).toBe('LOW');
  });

  it('resolves aliases to canonical ids', () => {
    expect(pickQuant(['bf16'], table)).toBe('F16');
  });

  it('ignores quants absent from the table', () => {
    expect(pickQuant(['IQ4_XS', 'Q4_K_M'], table)).toBe('Q4_K_M');
  });

  it('returns null when nothing offered is in the table', () => {
    expect(pickQuant(['IQ4_XS', 'TQ2_0'], table)).toBeNull();
    expect(pickQuant([], table)).toBeNull();
  });
});

describe('hfCandidatesToModelInfo quant selection', () => {
  it('sets a real quantization from availableQuants', () => {
    const [info] = hfCandidatesToModelInfo(
      [
        {
          repoId: 'o/r',
          author: 'o',
          url: 'https://huggingface.co/o/r',
          parameterSizeB: 8,
          availableQuants: ['BF16', 'Q4_K_M', 'Q8_0'],
          signals: { downloads: 1, likes: 1, trendingScore: 1, lastModified: null },
        },
      ],
      (c) => `hf.co/${c.repoId}`
    );
    expect(info.quantizationLevel).toBe('Q4_K_M');
  });

  it('leaves quantizationLevel null when no offered quant is known', () => {
    const [info] = hfCandidatesToModelInfo(
      [
        {
          repoId: 'o/r',
          author: 'o',
          url: 'https://huggingface.co/o/r',
          parameterSizeB: 8,
          availableQuants: ['IQ4_XS'],
          signals: { downloads: 1, likes: 1, trendingScore: 1, lastModified: null },
        },
      ],
      (c) => `hf.co/${c.repoId}`
    );
    expect(info.quantizationLevel).toBeNull();
  });
});
