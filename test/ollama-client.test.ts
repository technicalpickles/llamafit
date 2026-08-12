import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isCloudModel,
  parseParameterSize,
  modelPageUrl,
  fetchTags,
  createPullModel,
  normalizeQuant,
  quantFromTag,
  type OllamaTagsResponse,
} from '../src/backends/ollama/client.js';
import { loadQuantTable } from '../src/data.js';

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

describe('normalizeQuant', () => {
  it('treats the literal string "unknown" as not-reported', () => {
    expect(normalizeQuant('unknown')).toBeNull();
  });

  it('treats empty and whitespace-only as not-reported', () => {
    expect(normalizeQuant('')).toBeNull();
    expect(normalizeQuant('   ')).toBeNull();
    expect(normalizeQuant(undefined)).toBeNull();
    expect(normalizeQuant(null)).toBeNull();
  });

  it('is case-insensitive about the sentinel', () => {
    expect(normalizeQuant('Unknown')).toBeNull();
    expect(normalizeQuant('UNKNOWN')).toBeNull();
  });

  it('passes a real quantization through untouched, preserving case', () => {
    expect(normalizeQuant('Q4_K_M')).toBe('Q4_K_M');
    expect(normalizeQuant('bf16')).toBe('bf16');
  });

  it('trims surrounding whitespace off a real value', () => {
    expect(normalizeQuant('  Q4_K_M  ')).toBe('Q4_K_M');
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

  it('counts exactly 6 local (non-cloud) models in the fixture', () => {
    const localCount = tags.models.filter((m) => !isCloudModel(m)).length;
    expect(localCount).toBe(6);
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

describe('pullModel', () => {
  it('resolves when the underlying pull succeeds', async () => {
    const pullModel = createPullModel(async () => {});
    await expect(pullModel('gemma3:12b')).resolves.toBeUndefined();
  });

  it('passes through a non-manifest failure unchanged', async () => {
    const pullModel = createPullModel(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    });
    await expect(pullModel('gemma3:12b')).rejects.toThrow('connect ECONNREFUSED 127.0.0.1:11434');
  });

  it("hints at the hf.co/ prefix when a repo-shaped name fails with a manifest error (llama-server's bare-repoId format pasted for Ollama)", async () => {
    const pullModel = createPullModel(async () => {
      throw new Error('Command failed: ollama pull yuxinlu1/gemma-4-12B-agentic-GGUF\nError: pull model manifest: file does not exist');
    });
    await expect(pullModel('yuxinlu1/gemma-4-12B-agentic-GGUF')).rejects.toThrow(
      "'hf.co/yuxinlu1/gemma-4-12B-agentic-GGUF'"
    );
  });

  it('does not add the hf.co/ hint when the name already has that prefix', async () => {
    const pullModel = createPullModel(async () => {
      throw new Error('Error: pull model manifest: file does not exist');
    });
    await expect(pullModel('hf.co/yuxinlu1/gemma-4-12B-agentic-GGUF')).rejects.not.toThrow(
      /looks like a Hugging Face repo id/
    );
  });

  it('does not add the hf.co/ hint for a single-segment name (no slash to suggest a repo id)', async () => {
    const pullModel = createPullModel(async () => {
      throw new Error('Error: pull model manifest: file does not exist');
    });
    await expect(pullModel('nonexistentmodel')).rejects.not.toThrow(/looks like a Hugging Face repo id/);
  });
});

describe('quantFromTag', () => {
  const table = loadQuantTable();

  it('reads a known quant off an hf.co tag', () => {
    expect(
      quantFromTag('hf.co/yuxinlu1/gemma-4-12B-agentic-GGUF:Q4_K_M', table)
    ).toBe('Q4_K_M');
  });

  it('resolves an alias to its canonical id', () => {
    expect(quantFromTag('hf.co/o/r:bf16', table)).toBe('F16');
  });

  it('returns null for a tag that is not a quantization', () => {
    expect(quantFromTag('hf.co/o/r:latest', table)).toBeNull();
    expect(quantFromTag('gemma3:12b', table)).toBeNull();
    expect(quantFromTag('cyborgxx101/gemma-4-12b-mlx:4bit', table)).toBeNull();
  });

  it('returns null when there is no tag at all', () => {
    expect(quantFromTag('mistrallite', table)).toBeNull();
  });

  it('ignores a colon that belongs to a namespace rather than a tag', () => {
    // Delegated to splitModelTag; asserted here so the behaviour is pinned at
    // this layer too, not just in the helper's own tests.
    expect(quantFromTag('hf.co/owner:weird/repo', table)).toBeNull();
  });
});
