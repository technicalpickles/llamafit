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

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/tags')) {
      return new Response(JSON.stringify(tags), { status: 200 });
    }
    if (url.includes('/api/ps')) {
      return new Response(JSON.stringify(ps), { status: 200 });
    }
    if (url.includes('/api/version')) {
      return new Response(JSON.stringify({ version: '0.5.1' }), { status: 200 });
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
});
