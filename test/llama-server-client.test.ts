import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  fetchModels,
  unloadModel,
  completion,
  type LlamaServerModelsResponse,
} from '../src/backends/llama-server/client.js';

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8'));
}

function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

describe('fetchModels', () => {
  it('parses the /models response', async () => {
    const fixture = loadFixture<LlamaServerModelsResponse>('llama-server-models-loaded.json');
    const models = await withFetch(
      (async () => new Response(JSON.stringify(fixture), { status: 200 })) as typeof fetch,
      () => fetchModels()
    );
    expect(models.data[0].id).toBe('Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M');
    expect(models.data[0].meta?.n_params).toBe(630167424);
  });

  it('gives a clear message when llama-server is unreachable', async () => {
    await expect(
      withFetch(
        (() => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:8080');
        }) as typeof fetch,
        () => fetchModels()
      )
    ).rejects.toThrow(/is 'llama-server' running/);
  });
});

describe('unloadModel', () => {
  it('resolves on {"success": true}', async () => {
    await expect(
      withFetch(
        (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof fetch,
        () => unloadModel('Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M')
      )
    ).resolves.toBeUndefined();
  });

  it('throws with the server error message on an unknown model', async () => {
    const errorBody = loadFixture<object>('llama-server-models-unload-error.json');
    await expect(
      withFetch(
        (async () => new Response(JSON.stringify(errorBody), { status: 400 })) as typeof fetch,
        () => unloadModel('does-not-exist')
      )
    ).rejects.toThrow(/model is not found/);
  });
});

describe('completion', () => {
  it('resolves null on timeout instead of throwing', async () => {
    const abortingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted', 'AbortError'))
        );
      })) as typeof fetch;
    await expect(withFetch(abortingFetch, () => completion('m', 'p', 10))).resolves.toBeNull();
  });
});
