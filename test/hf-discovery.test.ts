import { describe, it, expect } from 'vitest';
import { buildModelsUrl } from '../src/hf/discovery.js';

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
