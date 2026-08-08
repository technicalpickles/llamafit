import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { describeBackendConformance } from './conformance/backend.js';
import { ollamaBackend } from '../src/backends/ollama/index.js';
import type { OllamaTagsResponse, OllamaPsResponse } from '../src/backends/ollama/client.js';

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
    expect(sources.find((s) => s.id === 'huggingface')).toMatchObject({ ok: false });
    expect(sources.find((s) => s.id === 'huggingface')!.error).toMatch(/500/);
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
