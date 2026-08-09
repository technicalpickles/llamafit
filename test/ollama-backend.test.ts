import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { describeBackendConformance } from './conformance/backend.js';
import { ollamaBackend, mapTagsToLocalModels, collapseByDigest } from '../src/backends/ollama/index.js';
import { isFailedSource } from '../src/backends/types.js';
import type { OllamaTagsResponse, OllamaPsResponse } from '../src/backends/ollama/client.js';
import type { ModelInfo } from '../src/types.js';

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8'));
}

const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
const ps = loadFixture<OllamaPsResponse>('api-ps-loaded.json');
const searchHtml = readFileSync(new URL('./fixtures/ollama-search-mlx.html', import.meta.url), 'utf-8');
const hfSearch = readFileSync(new URL('./fixtures/hf-models-search.json', import.meta.url), 'utf-8');

let originalFetch: typeof fetch;
let requestedSearchUrl: string | null = null;
let fetched: string[] = [];

beforeEach(() => {
  requestedSearchUrl = null;
  fetched = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetched.push(url);
    if (url.includes('/api/tags')) {
      return new Response(JSON.stringify(tags), { status: 200 });
    }
    if (url.includes('/api/ps')) {
      return new Response(JSON.stringify(ps), { status: 200 });
    }
    if (url.includes('/api/version')) {
      return new Response(JSON.stringify({ version: '0.5.1' }), { status: 200 });
    }
    if (url.includes('ollama.com/search')) {
      requestedSearchUrl = url;
      return new Response(searchHtml, { status: 200 });
    }
    if (url.includes('huggingface.co/api/models')) {
      return new Response(hfSearch, { status: 200 });
    }
    throw new Error(`Unhandled fetch in test stub: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describeBackendConformance('ollama', async () => ollamaBackend);

describe('ollamaBackend mapping', () => {
  it('localModels maps tags and skips cloud models', async () => {
    const { models, skipped } = await ollamaBackend.localModels();
    expect(models.every((m) => m.source === 'local')).toBe(true);
    expect(models[0]).toHaveProperty('parameterSizeB');
    // api-tags.json contains at least one remote_host model — it must land in skipped
    expect(skipped.length).toBeGreaterThan(0);
  });

  it('recovers the quantization from an hf.co tag when the manifest says nothing', () => {
    // The fixture's ':latest' tag on this digest reports no quant and is
    // collapsed into the ':Q4_K_M' row (see 'collapses the two hf.co tags in
    // the real tags fixture' below) -- only the quant-bearing row survives.
    const { models } = mapTagsToLocalModels(loadFixture<OllamaTagsResponse>('api-tags.json'));
    const tagged = models.find((m) => m.name.endsWith('-GGUF:Q4_K_M'));
    expect(tagged?.quantizationLevel).toBe('Q4_K_M');
  });

  it('prefers a quantization the manifest did report over the tag', () => {
    const { models } = mapTagsToLocalModels({
      models: [
        {
          name: 'hf.co/o/r:Q2_K',
          model: 'hf.co/o/r:Q2_K',
          modified_at: '',
          size: 0,
          digest: 'aaa',
          details: {
            parent_model: '',
            format: 'gguf',
            family: 'x',
            families: null,
            parameter_size: '7B',
            quantization_level: 'Q8_0',
          },
          capabilities: [],
        },
      ],
    });
    expect(models[0].quantizationLevel).toBe('Q8_0');
  });

  it('loadedModels converts size_vram to GB', async () => {
    const loaded = await ollamaBackend.loadedModels!();
    expect(loaded[0].sizeVramGb).toBeGreaterThan(0);
    expect(loaded[0].sizeVramGb).toBeLessThan(100); // GB, not bytes
  });

  it('detect() reports unreachable without throwing', async () => {
    globalThis.fetch = (() => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    }) as typeof fetch;
    const detection = await ollamaBackend.detect();
    expect(detection.detected).toBe(false);
    expect(detection.evidence).toHaveProperty('error');
  });

  it('detect() reports detected with version on success', async () => {
    const detection = await ollamaBackend.detect();
    expect(detection.detected).toBe(true);
    expect(detection.version).toBe('0.5.1');
    expect(detection.evidence).toHaveProperty('baseUrl');
  });

  it('remoteCandidates defaults the scrape query to mlx and reports the source', async () => {
    const discovery = await ollamaBackend.remoteCandidates!();
    expect(discovery.sources).toContainEqual({ id: 'ollama.com', query: 'mlx', ok: true });
    expect(discovery.candidates.length).toBeGreaterThan(0);
    // Two sources now (ollama-hf-source) — assert the scrape rows are present
    // and correctly attributed, not that they're the only rows.
    expect(discovery.candidates.some((c) => c.discoverySource === 'ollama.com')).toBe(true);
    expect(requestedSearchUrl).toContain('q=mlx');
  });

  it('remoteCandidates reports a failed source instead of throwing', async () => {
    // Every URL 500s here, so both sources fail — see the "two sources"
    // describe block below for the single-source-failing case.
    globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof fetch;
    const discovery = await ollamaBackend.remoteCandidates!('qwen');
    expect(discovery.candidates).toEqual([]);
    expect(discovery.sources).toEqual([
      { id: 'ollama.com', query: 'qwen', ok: false, error: expect.any(String) },
      { id: 'huggingface', query: 'qwen', ok: false, error: expect.any(String) },
    ]);
  });
});

function local(name: string, digest?: string, quant: string | null = null): ModelInfo {
  return {
    name,
    source: 'local',
    url: null,
    parameterSizeB: 11.9,
    quantizationLevel: quant,
    diskSizeBytes: 1,
    ...(digest !== undefined ? { digest } : {}),
  };
}

describe('collapseByDigest', () => {
  it('collapses two tags on one digest, preferring the quant-bearing tag', () => {
    const out = collapseByDigest([
      local('hf.co/o/r:latest', 'aaa', null),
      local('hf.co/o/r:Q4_K_M', 'aaa', 'Q4_K_M'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('hf.co/o/r:Q4_K_M');
    expect(out[0].quantizationLevel).toBe('Q4_K_M');
    expect(out[0].alsoTagged).toEqual(['hf.co/o/r:latest']);
  });

  it('falls back to the shortest name when no tag yields a quant', () => {
    const out = collapseByDigest([
      local('hf.co/o/r:some-long-tag', 'aaa', null),
      local('hf.co/o/r:v2', 'aaa', null),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('hf.co/o/r:v2');
    expect(out[0].alsoTagged).toEqual(['hf.co/o/r:some-long-tag']);
  });

  it('leaves distinct digests alone and sets no alsoTagged', () => {
    const out = collapseByDigest([local('a:1', 'aaa'), local('b:1', 'bbb')]);
    expect(out.map((m) => m.name)).toEqual(['a:1', 'b:1']);
    expect(out[0].alsoTagged).toBeUndefined();
  });

  it('passes through models with no digest, one row each', () => {
    const out = collapseByDigest([local('a:1'), local('b:1')]);
    expect(out.map((m) => m.name)).toEqual(['a:1', 'b:1']);
  });

  it('preserves input order by first appearance of each digest', () => {
    const out = collapseByDigest([
      local('z:1', 'zzz'),
      local('a:1', 'aaa'),
      local('z:2', 'zzz'),
    ]);
    expect(out.map((m) => m.name)).toEqual(['z:1', 'a:1']);
  });
});

it('collapses the two hf.co tags in the real tags fixture', () => {
  const { models } = mapTagsToLocalModels(loadFixture<OllamaTagsResponse>('api-tags.json'));
  const agentic = models.filter((m) => m.name.includes('gemma-4-12B-agentic'));
  expect(agentic).toHaveLength(1);
  expect(agentic[0].name).toMatch(/:Q4_K_M$/);
  expect(agentic[0].alsoTagged).toEqual([
    'hf.co/yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF:latest',
  ]);
});

describe('ollamaBackend remoteCandidates (two sources)', () => {
  it('merges scrape rows first, then HF rows in ollama pull-name shape', async () => {
    const { candidates, sources } = await ollamaBackend.remoteCandidates!();
    const firstHf = candidates.findIndex((c) => c.discoverySource === 'huggingface');
    expect(firstHf).toBeGreaterThan(0);
    expect(candidates.slice(0, firstHf).every((c) => c.discoverySource === 'ollama.com')).toBe(true);
    expect(candidates.slice(firstHf).every((c) => c.discoverySource === 'huggingface')).toBe(true);
    const hfRow = candidates[firstHf];
    expect(hfRow.name).toMatch(/^hf\.co\/[^/]+\/[^/]+/);
    expect(hfRow.author).toBeDefined();
    expect(hfRow.signals).toBeDefined();
    expect(sources.map((s) => s.id)).toEqual(['ollama.com', 'huggingface']);
  });

  it('routes per-source defaults when no query is given', async () => {
    await ollamaBackend.remoteCandidates!();
    const scrapeUrl = fetched.find((u) => u.includes('ollama.com/search'));
    const hfUrl = fetched.find((u) => u.includes('huggingface.co/api/models'));
    expect(scrapeUrl).toContain('q=mlx');
    expect(hfUrl).not.toContain('search=');
  });

  it('sends an explicit query to both sources verbatim', async () => {
    const { sources } = await ollamaBackend.remoteCandidates!('qwen');
    expect(fetched.find((u) => u.includes('ollama.com/search'))).toContain('q=qwen');
    expect(fetched.find((u) => u.includes('huggingface.co/api/models'))).toContain('search=qwen');
    expect(sources).toEqual([
      { id: 'ollama.com', query: 'qwen', ok: true },
      { id: 'huggingface', query: 'qwen', ok: true },
    ]);
  });

  it('passes the parameter cap to HF only', async () => {
    await ollamaBackend.remoteCandidates!(undefined, { maxParameterSizeB: 16 });
    const hfUrl = fetched.find((u) => u.includes('huggingface.co/api/models'))!;
    expect(decodeURIComponent(hfUrl)).toContain('num_parameters=max:16000000000');
  });

  it('one source failing still returns the other, reported not thrown', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetched.push(url);
      if (url.includes('huggingface.co/api/models')) {
        return new Response('', { status: 500 });
      }
      if (url.includes('ollama.com/search')) {
        return new Response(searchHtml, { status: 200 });
      }
      throw new Error(`Unhandled fetch in test stub: ${url}`);
    }) as typeof fetch;
    const { candidates, sources } = await ollamaBackend.remoteCandidates!();
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.discoverySource === 'ollama.com')).toBe(true);
    const hfSource = sources.find(isFailedSource);
    expect(hfSource).toMatchObject({ id: 'huggingface', ok: false });
    expect(hfSource!.error).toMatch(/500/);
  });

  it('both sources failing returns empty candidates and two failure reports, no throw', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;
    const { candidates, sources } = await ollamaBackend.remoteCandidates!();
    expect(candidates).toEqual([]);
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => !s.ok && typeof s.error === 'string')).toBe(true);
  });
});
