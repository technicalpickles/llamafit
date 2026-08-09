import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  fetchModels,
  unloadModel,
  completion,
  pullModel,
  type LlamaServerModelsResponse,
} from '../src/backends/llama-server/client.js';
import type { PullProgress } from '../src/backends/types.js';

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

function sseBody(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** Routes fetch calls by "METHOD pathname" so one mock covers the SSE subscribe,
 * the download POST, and the final list refresh. */
function routedFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const key = `${init?.method ?? 'GET'} ${path}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected fetch: ${key}`);
    return route();
  }) as typeof fetch;
}

const event = (payload: object) => `data: ${JSON.stringify(payload)}\n\n`;

/** Minimal LlamaServerModel entry for a GET /models mock — real live-server
 * responses always include these fields (see llama-server-models-loaded.json). */
const modelEntry = (id: string) => ({
  id,
  object: 'model',
  owned_by: 'llama-server',
  created: 0,
  status: { value: 'unloaded' },
});

describe('pullModel', () => {
  const MODEL = 'Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q8_0';

  it('resolves after download_finished and refreshes the model list', async () => {
    const calls: string[] = [];
    const routes = {
      'GET /models/sse': () =>
        new Response(
          sseBody(
            event({
              model: MODEL,
              event: 'download_progress',
              data: { progress: { 'https://a.gguf': { done: 5, total: 10 } } },
            }),
            event({ model: MODEL, event: 'download_finished' })
          ),
          { status: 200 }
        ),
      'POST /models': () => new Response(JSON.stringify({ success: true }), { status: 200 }),
      'GET /models': () => new Response(JSON.stringify({ data: [modelEntry(MODEL)], object: 'list' }), { status: 200 }),
    };
    await withFetch(
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
        return (routedFetch(routes) as (i: RequestInfo | URL, n?: RequestInit) => Promise<Response>)(input, init);
      }) as typeof fetch,
      () => pullModel(MODEL)
    );
    // SSE subscription must come first (closes the tiny-model race), refresh last.
    expect(calls).toEqual(['GET /models/sse', 'POST /models', 'GET /models']);
  });

  it('aggregates progress across parallel files and reports it', async () => {
    const seen: PullProgress[] = [];
    await withFetch(
      routedFetch({
        'GET /models/sse': () =>
          new Response(
            sseBody(
              event({
                model: MODEL,
                event: 'download_progress',
                data: { progress: { 'https://a.gguf': { done: 10, total: 100 } } },
              }),
              event({
                model: MODEL,
                event: 'download_progress',
                data: {
                  progress: {
                    'https://a.gguf': { done: 50, total: 100 },
                    'https://b.gguf': { done: 5, total: 40 },
                  },
                },
              }),
              event({ model: MODEL, event: 'download_finished' })
            ),
            { status: 200 }
          ),
        'POST /models': () => new Response(JSON.stringify({ success: true }), { status: 200 }),
        'GET /models': () => new Response(JSON.stringify({ data: [modelEntry(MODEL)], object: 'list' }), { status: 200 }),
      }),
      () => pullModel(MODEL, (p) => seen.push(p))
    );
    expect(seen).toEqual([
      { doneBytes: 10, totalBytes: 100 },
      { doneBytes: 55, totalBytes: 140 },
    ]);
  });

  it('skips malformed progress entries instead of reporting NaN', async () => {
    const seen: PullProgress[] = [];
    await withFetch(
      routedFetch({
        'GET /models/sse': () =>
          new Response(
            sseBody(
              event({
                model: MODEL,
                event: 'download_progress',
                data: {
                  progress: {
                    'https://a.gguf': { done: 10, total: 100 },
                    'https://b.gguf': { done: 'x', total: 40 },
                  },
                },
              }),
              event({ model: MODEL, event: 'download_finished' })
            ),
            { status: 200 }
          ),
        'POST /models': () => new Response(JSON.stringify({ success: true }), { status: 200 }),
        'GET /models': () => new Response(JSON.stringify({ data: [modelEntry(MODEL)], object: 'list' }), { status: 200 }),
      }),
      () => pullModel(MODEL, (p) => seen.push(p))
    );
    // Only the well-formed https://a.gguf entry contributes; the malformed
    // https://b.gguf entry (non-numeric done) is skipped, not NaN-ed in.
    expect(seen).toEqual([{ doneBytes: 10, totalBytes: 100 }]);
  });

  it("ignores other models' events", async () => {
    const seen: PullProgress[] = [];
    await withFetch(
      routedFetch({
        'GET /models/sse': () =>
          new Response(
            sseBody(
              event({
                model: 'someone-else',
                event: 'download_progress',
                data: { progress: { 'https://x.gguf': { done: 1, total: 2 } } },
              }),
              event({ model: 'someone-else', event: 'download_failed' }),
              event({ model: MODEL, event: 'download_finished' })
            ),
            { status: 200 }
          ),
        'POST /models': () => new Response(JSON.stringify({ success: true }), { status: 200 }),
        'GET /models': () => new Response(JSON.stringify({ data: [modelEntry(MODEL)], object: 'list' }), { status: 200 }),
      }),
      () => pullModel(MODEL, (p) => seen.push(p))
    );
    expect(seen).toEqual([]); // other model's progress and failure both ignored
  });

  it('resolves to the auto-picked quant id when the repo requires one and the request omitted it', async () => {
    // Real llama-server behavior for a valid multi-quant HF repo pulled without a
    // quant suffix: it auto-picks one (observed live, b10280 2026-08-06) and
    // registers the model under `<repo>:<quant>`, not the bare repo id that was
    // requested. The bare id then never appears in /models, which the old
    // exact-match check mistook for "repo/quant doesn't exist" even though the
    // pull fully succeeded.
    const BARE_MODEL = 'yuxinlu1/gemma-4-12B-agentic-GGUF';
    const RESOLVED_ID = 'yuxinlu1/gemma-4-12B-agentic-GGUF:Q4_K_M';
    const resolved = await withFetch(
      routedFetch({
        'GET /models/sse': () =>
          new Response(sseBody(event({ model: BARE_MODEL, event: 'download_finished' })), { status: 200 }),
        'POST /models': () => new Response(JSON.stringify({ success: true }), { status: 200 }),
        'GET /models': () =>
          new Response(JSON.stringify({ data: [modelEntry(RESOLVED_ID)], object: 'list' }), { status: 200 }),
      }),
      () => pullModel(BARE_MODEL)
    );
    expect(resolved).toBe(RESOLVED_ID);
  });

  it('throws when download_finished fires but the model never appears in the model list', async () => {
    // Real llama-server behavior for a nonexistent repo/quant: POST /models
    // returns 2xx and the SSE stream reports download_finished (never
    // download_failed), but the model is silently absent afterward. See
    // .parkinglot/llama-server-captures/BUG-nonexistent-repo-does-not-fail-at-pull.md.
    await expect(
      withFetch(
        routedFetch({
          'GET /models/sse': () =>
            new Response(sseBody(event({ model: MODEL, event: 'download_finished' })), { status: 200 }),
          'POST /models': () => new Response(JSON.stringify({ success: true }), { status: 200 }),
          'GET /models': () => new Response(JSON.stringify({ data: [], object: 'list' }), { status: 200 }),
        }),
        () => pullModel(MODEL)
      )
    ).rejects.toThrow(/never appeared|not.*in.*list/i);
  });

  it('throws on download_failed', async () => {
    await expect(
      withFetch(
        routedFetch({
          'GET /models/sse': () =>
            new Response(sseBody(event({ model: MODEL, event: 'download_failed' })), { status: 200 }),
          'POST /models': () => new Response(JSON.stringify({ success: true }), { status: 200 }),
        }),
        () => pullModel(MODEL)
      )
    ).rejects.toThrow(`llama-server failed to download '${MODEL}'`);
  });

  it('throws with the server message when POST /models is rejected', async () => {
    await expect(
      withFetch(
        routedFetch({
          'GET /models/sse': () => new Response(sseBody(), { status: 200 }),
          'POST /models': () =>
            new Response(
              JSON.stringify({ error: { code: 400, message: 'model validation failed, unable to download', type: 'invalid_request_error' } }),
              { status: 400 }
            ),
        }),
        () => pullModel(MODEL)
      )
    ).rejects.toThrow(/model validation failed/);
  });

  it('throws when the stream ends before a terminal event', async () => {
    await expect(
      withFetch(
        routedFetch({
          'GET /models/sse': () =>
            new Response(
              sseBody(
                event({
                  model: MODEL,
                  event: 'download_progress',
                  data: { progress: { 'https://a.gguf': { done: 1, total: 2 } } },
                })
              ),
              { status: 200 }
            ),
          'POST /models': () => new Response(JSON.stringify({ success: true }), { status: 200 }),
        }),
        () => pullModel(MODEL)
      )
    ).rejects.toThrow(/event stream ended/);
  });
});
