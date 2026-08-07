import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildModelsUrl, parseQuantsFromSiblings, mapHitToCandidate, type HfModelHit } from '../src/hf/discovery.js';

describe('buildModelsUrl', () => {
  it('builds the full query with search, cap, and all six expands', () => {
    const url = buildModelsUrl('qwen', { maxParameterSizeB: 16 });
    expect(url).toContain('https://huggingface.co/api/models?');
    expect(url).toContain('search=qwen');
    expect(url).toContain('filter=gguf');
    expect(url).toContain('pipeline_tag=text-generation');
    // Raw integer param count — decimal "B" suffixes were never live-verified.
    expect(url).toContain('num_parameters=max%3A16000000000');
    expect(url).toContain('sort=trendingScore');
    expect(url).toContain('limit=10');
    for (const e of ['gguf', 'siblings', 'downloads', 'likes', 'lastModified', 'trendingScore']) {
      expect(url).toContain(`expand%5B%5D=${e}`);
    }
  });

  it('omits search when query is empty', () => {
    expect(buildModelsUrl('')).not.toContain('search=');
  });

  it('omits num_parameters when no cap is given', () => {
    expect(buildModelsUrl('qwen')).not.toContain('num_parameters');
  });

  it('floors fractional caps to whole params', () => {
    expect(buildModelsUrl('', { maxParameterSizeB: 11.6 })).toContain(
      'num_parameters=max%3A11600000000'
    );
  });

  it('honors a custom limit', () => {
    expect(buildModelsUrl('', { limit: 25 })).toContain('limit=25');
  });
});

describe('parseQuantsFromSiblings', () => {
  it('parses standard K-quants and dedupes shards', () => {
    expect(
      parseQuantsFromSiblings([
        'Qwen3.5-9B-Q4_K_M.gguf',
        'Qwen3.5-9B-Q8_0-00001-of-00002.gguf',
        'Qwen3.5-9B-Q8_0-00002-of-00002.gguf',
      ])
    ).toEqual(['Q4_K_M', 'Q8_0']);
  });

  it('parses IQ, float, and unsloth UD- variants', () => {
    expect(
      parseQuantsFromSiblings([
        'model-IQ4_XS.gguf',
        'model.BF16.gguf',
        'model-F16.gguf',
        'model-UD-Q4_K_XL.gguf',
      ])
    ).toEqual(['IQ4_XS', 'BF16', 'F16', 'UD-Q4_K_XL']);
  });

  it('normalizes case to uppercase', () => {
    expect(parseQuantsFromSiblings(['model-q4_k_m.gguf'])).toEqual(['Q4_K_M']);
  });

  it('skips mmproj projector files (their F16 is not a model quant)', () => {
    expect(parseQuantsFromSiblings(['mmproj-F16.gguf', 'model-Q4_K_M.gguf'])).toEqual(['Q4_K_M']);
  });

  it('skips non-gguf and unparseable filenames rather than guessing', () => {
    expect(parseQuantsFromSiblings(['README.md', 'config.json', 'model.gguf'])).toEqual([]);
  });
});

function loadHits(): HfModelHit[] {
  return JSON.parse(
    readFileSync(new URL('./fixtures/hf-models-search.json', import.meta.url), 'utf-8')
  ) as HfModelHit[];
}

describe('mapHitToCandidate', () => {
  const hits = loadHits();
  const candidates = hits.map(mapHitToCandidate);

  it('maps every fixture hit', () => {
    expect(candidates.length).toBe(hits.length);
    for (const c of candidates) {
      expect(c.repoId).toMatch(/^[^/]+\/[^/]+$/);
      expect(c.author).toBe(c.repoId.split('/')[0]);
      expect(c.url).toBe(`https://huggingface.co/${c.repoId}`);
    }
  });

  it('derives parameterSizeB from gguf.total in billions', () => {
    const withGguf = hits.find((h) => h.gguf?.total);
    expect(withGguf).toBeDefined();
    const c = mapHitToCandidate(withGguf!);
    expect(c.parameterSizeB).toBeCloseTo(withGguf!.gguf!.total! / 1e9, 6);
  });

  it('maps a hit without gguf metadata to null params (dropped later, not guessed)', () => {
    const c = mapHitToCandidate({ id: 'someone/mystery-GGUF' });
    expect(c.parameterSizeB).toBeNull();
    expect(c.availableQuants).toEqual([]);
    expect(c.signals).toEqual({
      downloads: null,
      likes: null,
      trendingScore: null,
      lastModified: null,
    });
  });

  it('carries signals through from the fixture', () => {
    const withDownloads = hits.find((h) => typeof h.downloads === 'number')!;
    const c = mapHitToCandidate(withDownloads);
    expect(c.signals.downloads).toBe(withDownloads.downloads);
  });

  it('extracts quants from fixture siblings', () => {
    const withSiblings = hits.find((h) => (h.siblings ?? []).some((s) => /q\d/i.test(s.rfilename)));
    expect(withSiblings).toBeDefined();
    expect(mapHitToCandidate(withSiblings!).availableQuants.length).toBeGreaterThan(0);
  });
});
