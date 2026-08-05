import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isCloudModel,
  parseParameterSize,
  modelPageUrl,
  fetchTags,
  type OllamaTagsResponse,
} from '../src/backends/ollama/client.js';

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8'));
}

describe('parseParameterSize', () => {
  it('parses a decimal value with uppercase B suffix', () => {
    expect(parseParameterSize('12.2B')).toBe(12.2);
  });

  it('parses a lowercase b suffix', () => {
    expect(parseParameterSize('756b')).toBe(756);
  });

  it('parses a raw integer parameter count with no suffix', () => {
    expect(parseParameterSize('675000000000')).toBe(675);
  });

  it('parses a small raw integer parameter count', () => {
    expect(parseParameterSize('24000000000')).toBe(24);
  });

  it('returns null for an empty string', () => {
    expect(parseParameterSize('')).toBeNull();
  });
});

describe('modelPageUrl', () => {
  it('links an official model to its library page, stripping the tag', () => {
    expect(modelPageUrl('gemma3:12b')).toBe('https://ollama.com/library/gemma3');
  });

  it('links an untagged official model to its library page', () => {
    expect(modelPageUrl('gemma3')).toBe('https://ollama.com/library/gemma3');
  });

  it('links a community-namespaced model to its user page, stripping the tag', () => {
    expect(modelPageUrl('cyborgxx101/gemma-4-12b-opus-finetuned-mlx:4bit')).toBe(
      'https://ollama.com/cyborgxx101/gemma-4-12b-opus-finetuned-mlx'
    );
  });
});

describe('isCloudModel', () => {
  const tags = loadFixture<OllamaTagsResponse>('api-tags.json');

  it('identifies a cloud model by its remote_host field', () => {
    const cloudModel = tags.models.find((m) => m.name === 'glm-5.2:cloud');
    expect(cloudModel).toBeDefined();
    expect(isCloudModel(cloudModel!)).toBe(true);
  });

  it('identifies a local GGUF model as not cloud', () => {
    const localModel = tags.models.find((m) => m.name === 'gemma3:12b');
    expect(localModel).toBeDefined();
    expect(isCloudModel(localModel!)).toBe(false);
  });

  it('counts exactly 4 local (non-cloud) models in the fixture', () => {
    const localCount = tags.models.filter((m) => !isCloudModel(m)).length;
    expect(localCount).toBe(4);
  });
});

describe('fetchTags error handling', () => {
  it('gives a clear message when the Ollama server is unreachable', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    }) as typeof fetch;
    try {
      await expect(fetchTags()).rejects.toThrow(/is 'ollama serve' running/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
