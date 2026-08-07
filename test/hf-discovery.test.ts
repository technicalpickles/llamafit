import { describe, it, expect } from 'vitest';
import { buildModelsUrl, parseQuantsFromSiblings } from '../src/hf/discovery.js';

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
