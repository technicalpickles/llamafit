import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { hfCandidatesToModelInfo } from '../src/hf/model-info.js';
import { mapHitToCandidate, type HfModelHit } from '../src/hf/discovery.js';

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

  it('never assigns a per-repo quantization or disk size', () => {
    const rows = hfCandidatesToModelInfo(candidates, (c) => c.repoId);
    expect(rows.every((r) => r.quantizationLevel === null)).toBe(true);
    expect(rows.every((r) => r.diskSizeBytes === null)).toBe(true);
  });
});
