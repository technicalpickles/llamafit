# llama-server pull() with SSE Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `pull()` on the llama-server backend adapter: `POST /models` starts an async HF-cache download, the adapter consumes `/models/sse` until a terminal event, and download progress renders live in the CLI spinner.

**Architecture:** A new optional `onProgress` callback on `Backend.pull` carries aggregated byte counts from adapter to CLI. The adapter subscribes to SSE *before* POSTing (closes the tiny-model race), parses events with a minimal hand-rolled SSE parser, and treats a dropped stream as an error. The CLI's existing `withProgress` wrapper renders progress via a new `Spinner.update()`.

**Tech Stack:** TypeScript (ESM, Node), vitest, native `fetch`/`ReadableStream`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-06-llama-server-pull-design.md`

## Global Constraints

- Adapters stay silent: no console/stderr writes from `src/backends/**`; all rendering happens in `src/cli.ts`/`src/progress.ts`.
- No overall pull timeout; no SSE reconnect logic (dropped stream = error).
- Error messages must name the backend/tool, matching existing style (e.g. `llama-server failed to download '<model>'`).
- Progress bytes are decimal GB, `toFixed(1)`, `GB` suffix (matches `src/format.ts` conventions).
- Commit messages: conventional-commit style (`feat:`/`fix:`/`docs:`), trailer lines as configured for this session.
- Task slugs below (not numbers) are the stable references for commits.

## Task Order

`pull-progress-contract` → `sse-parser` → `client-pull` → `adapter-wiring` → `spinner-update` → `cli-progress-render` → `live-verification`

---

### Task: pull-progress-contract

Widen the `Backend.pull` contract with an optional progress callback. Type-only change — no runtime behavior to test-drive; the compiler and the existing suite are the verification. Ollama's `pullModel(model: string)` still satisfies the widened signature (extra optional param is compatible), so nothing else changes.

**Files:**
- Modify: `src/backends/types.ts`
- Modify: `docs/adapters.md` (~line 219, the interface listing; and the "No `pull`" bullet ~line 246 gains nothing — leave it)

**Interfaces:**
- Produces: `PullProgress { doneBytes: number; totalBytes: number }` and `pull?(model: string, onProgress?: (p: PullProgress) => void): Promise<void>` — consumed by `client-pull` and `cli-progress-render`.

- [ ] **Step 1: Edit `src/backends/types.ts`**

Replace the `pull?` line and add the interface:

```ts
import type { Detection, LocalModels, ModelInfo, LoadedModel, GenerateResult } from '../types.js';

/** Aggregated download progress across all files a pull is fetching in parallel. */
export interface PullProgress {
  doneBytes: number;
  totalBytes: number;
}

export interface Backend {
  id: string;
  displayName: string;
  detect(): Promise<Detection>;
  localModels(): Promise<LocalModels>;
  /** Resolves null on timeout — a meaningful result, not an error. */
  generate(model: string, prompt: string, timeoutMs?: number): Promise<GenerateResult | null>;
  // Optional capabilities — absent method = backend can't do it; callers degrade and say so.
  remoteCandidates?(query?: string): Promise<ModelInfo[]>;
  loadedModels?(): Promise<LoadedModel[]>;
  /** onProgress is best-effort UI plumbing: it may never fire (a download can
   * complete before any progress event), and implementations need not guard
   * against it throwing. */
  pull?(model: string, onProgress?: (p: PullProgress) => void): Promise<void>;
  unload?(model: string): Promise<void>;
}
```

- [ ] **Step 2: Update the interface listing in `docs/adapters.md`**

In the fenced interface block (~line 213-222), mirror the same two changes: add the `PullProgress` interface above `Backend` and replace the `pull?(model: string): Promise<void>;` line with the new signature plus its doc comment.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean compile, all tests pass (the param is optional, so Ollama's `pull: pullModel` still typechecks).

- [ ] **Step 4: Commit**

```bash
git add src/backends/types.ts docs/adapters.md
git commit -m "feat: add optional onProgress callback to Backend.pull (pull-progress-contract)"
```

---

### Task: sse-parser

Minimal SSE parser as an async generator over a `ReadableStream<Uint8Array>`. llama-server puts the event name *inside* the JSON payload on `data:` lines (`{"model": ..., "event": "download_progress", "data": ...}`), so the parser ignores SSE `event:`/`id:`/`retry:` fields and comments, and just JSON-parses concatenated `data:` lines per blank-line-delimited event.

**Files:**
- Create: `src/backends/llama-server/sse.ts`
- Test: `test/llama-server-sse.test.ts`

**Interfaces:**
- Produces: `LlamaServerSseEvent { model: string; event: string; data?: unknown }` and `sseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<LlamaServerSseEvent>` — consumed by `client-pull`.

- [ ] **Step 1: Write the failing tests**

Create `test/llama-server-sse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sseEvents, type LlamaServerSseEvent } from '../src/backends/llama-server/sse.js';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<LlamaServerSseEvent[]> {
  const events: LlamaServerSseEvent[] = [];
  for await (const event of sseEvents(stream)) events.push(event);
  return events;
}

describe('sseEvents', () => {
  it('parses a single data event', async () => {
    const events = await collect(streamOf('data: {"model":"m","event":"download_finished"}\n\n'));
    expect(events).toEqual([{ model: 'm', event: 'download_finished' }]);
  });

  it('parses an event split across chunks', async () => {
    const events = await collect(
      streamOf('data: {"model":"m","ev', 'ent":"download_finished"}\n\n')
    );
    expect(events).toEqual([{ model: 'm', event: 'download_finished' }]);
  });

  it('parses multiple events in one chunk', async () => {
    const events = await collect(
      streamOf(
        'data: {"model":"m","event":"model_status","data":{"status":"loading"}}\n\n' +
          'data: {"model":"m","event":"download_finished"}\n\n'
      )
    );
    expect(events.map((e) => e.event)).toEqual(['model_status', 'download_finished']);
  });

  it('handles CRLF line endings', async () => {
    const events = await collect(streamOf('data: {"model":"m","event":"download_finished"}\r\n\r\n'));
    expect(events).toEqual([{ model: 'm', event: 'download_finished' }]);
  });

  it('skips SSE comments and non-data fields', async () => {
    const events = await collect(
      streamOf(': keepalive\n\nretry: 3000\n\ndata: {"model":"m","event":"download_finished"}\n\n')
    );
    expect(events).toEqual([{ model: 'm', event: 'download_finished' }]);
  });

  it('skips malformed JSON payloads instead of throwing', async () => {
    const events = await collect(
      streamOf('data: {not json}\n\ndata: {"model":"m","event":"download_finished"}\n\n')
    );
    expect(events).toEqual([{ model: 'm', event: 'download_finished' }]);
  });

  it('yields nothing for a stream that ends mid-event (no trailing blank line)', async () => {
    const events = await collect(streamOf('data: {"model":"m","event":"download_finished"}'));
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/llama-server-sse.test.ts`
Expected: FAIL — cannot resolve `../src/backends/llama-server/sse.js` (module doesn't exist).

- [ ] **Step 3: Write the parser**

Create `src/backends/llama-server/sse.ts`:

```ts
/** One llama-server /models/sse event. The server puts the event name inside the
 * JSON payload (not the SSE `event:` field), so parsing is: concatenate `data:`
 * lines per blank-line-delimited event, JSON-parse the result. */
export interface LlamaServerSseEvent {
  model: string;
  event: string;
  data?: unknown;
}

/** Minimal SSE reader for llama-server's event stream. Ignores comments and
 * non-`data:` fields, skips unparseable payloads, and cancels the underlying
 * stream on early exit (break/throw in the consuming loop) via the generator's
 * finally block. No reconnect: when the stream ends, iteration ends. */
export async function* sseEvents(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<LlamaServerSseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).trim())
          .join('\n');
        if (!data) continue;
        try {
          yield JSON.parse(data) as LlamaServerSseEvent;
        } catch {
          // Malformed payload: skip it rather than killing the whole stream.
        }
      }
    }
  } finally {
    reader.releaseLock();
    await stream.cancel().catch(() => {});
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/llama-server-sse.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backends/llama-server/sse.ts test/llama-server-sse.test.ts
git commit -m "feat: add minimal SSE parser for llama-server event stream (sse-parser)"
```

---

### Task: client-pull

`pullModel(model, onProgress?)` in the llama-server client: subscribe to SSE, POST the download, consume events until terminal, refresh the model list, always release the stream.

**Files:**
- Modify: `src/backends/llama-server/client.ts`
- Test: `test/llama-server-client.test.ts` (append a `describe('pullModel')` block)

**Interfaces:**
- Consumes: `sseEvents`, `LlamaServerSseEvent` from `./sse.js` (sse-parser task); `PullProgress` from `../types.js` (pull-progress-contract task); existing `llamaServerRequest`, `fetchModels`, `LLAMA_SERVER_BASE_URL`.
- Produces: `pullModel(model: string, onProgress?: (p: PullProgress) => void): Promise<void>` — consumed by `adapter-wiring`.

- [ ] **Step 1: Write the failing tests**

Append to `test/llama-server-client.test.ts` (reuses the file's existing `withFetch` helper; add the two new helpers and import):

```ts
import { pullModel } from '../src/backends/llama-server/client.js'; // merge into the existing import
import type { PullProgress } from '../src/backends/types.js';

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

describe('pullModel', () => {
  const MODEL = 'Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q8_0';

  it('resolves after download_finished and refreshes the model list', async () => {
    const calls: string[] = [];
    const routes = {
      'GET /models/sse': () =>
        new Response(
          sseBody(
            event({ model: MODEL, event: 'download_progress', data: { 'https://a.gguf': { done: 5, total: 10 } } }),
            event({ model: MODEL, event: 'download_finished' })
          ),
          { status: 200 }
        ),
      'POST /models': () => new Response(JSON.stringify({ success: true }), { status: 200 }),
      'GET /models': () => new Response(JSON.stringify({ data: [], object: 'list' }), { status: 200 }),
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
              event({ model: MODEL, event: 'download_progress', data: { 'https://a.gguf': { done: 10, total: 100 } } }),
              event({
                model: MODEL,
                event: 'download_progress',
                data: { 'https://a.gguf': { done: 50, total: 100 }, 'https://b.gguf': { done: 5, total: 40 } },
              }),
              event({ model: MODEL, event: 'download_finished' })
            ),
            { status: 200 }
          ),
        'POST /models': () => new Response(JSON.stringify({ success: true }), { status: 200 }),
        'GET /models': () => new Response(JSON.stringify({ data: [], object: 'list' }), { status: 200 }),
      }),
      () => pullModel(MODEL, (p) => seen.push(p))
    );
    expect(seen).toEqual([
      { doneBytes: 10, totalBytes: 100 },
      { doneBytes: 55, totalBytes: 140 },
    ]);
  });

  it("ignores other models' events", async () => {
    const seen: PullProgress[] = [];
    await withFetch(
      routedFetch({
        'GET /models/sse': () =>
          new Response(
            sseBody(
              event({ model: 'someone-else', event: 'download_progress', data: { 'https://x.gguf': { done: 1, total: 2 } } }),
              event({ model: 'someone-else', event: 'download_failed' }),
              event({ model: MODEL, event: 'download_finished' })
            ),
            { status: 200 }
          ),
        'POST /models': () => new Response(JSON.stringify({ success: true }), { status: 200 }),
        'GET /models': () => new Response(JSON.stringify({ data: [], object: 'list' }), { status: 200 }),
      }),
      () => pullModel(MODEL, (p) => seen.push(p))
    );
    expect(seen).toEqual([]); // other model's progress and failure both ignored
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
              sseBody(event({ model: MODEL, event: 'download_progress', data: { 'https://a.gguf': { done: 1, total: 2 } } })),
              { status: 200 }
            ),
          'POST /models': () => new Response(JSON.stringify({ success: true }), { status: 200 }),
        }),
        () => pullModel(MODEL)
      )
    ).rejects.toThrow(/event stream ended/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/llama-server-client.test.ts`
Expected: FAIL — `pullModel` is not exported.

- [ ] **Step 3: Implement `pullModel` in `src/backends/llama-server/client.ts`**

Add imports at the top:

```ts
import type { PullProgress } from '../types.js';
import { sseEvents } from './sse.js';
```

Add after `unloadModel`:

```ts
interface DownloadFileProgress {
  done: number;
  total: number;
}

/** Bridges llama-server's async download API to pull()'s synchronous contract.
 * Subscribes to /models/sse BEFORE POSTing so a download that finishes quickly
 * can't complete before anyone is listening, then consumes events until
 * download_finished/download_failed. A stream that ends without a terminal
 * event (server shutdown, dropped connection) is an error — never a hang or a
 * silent success. No overall timeout: multi-GB downloads are legitimately slow. */
export async function pullModel(
  model: string,
  onProgress?: (p: PullProgress) => void
): Promise<void> {
  const sseRes = await llamaServerRequest('/models/sse');
  if (!sseRes.body) {
    throw new Error(`llama-server returned no body for /models/sse`);
  }
  // Progress arrives per file URL and models can download several files in
  // parallel; keep the latest per-file numbers and report the sums.
  const files: Record<string, DownloadFileProgress> = {};
  try {
    await llamaServerRequest('/models', { method: 'POST', body: JSON.stringify({ model }) });
    for await (const ev of sseEvents(sseRes.body)) {
      if (ev.model !== model) continue;
      if (ev.event === 'download_progress') {
        Object.assign(files, ev.data as Record<string, DownloadFileProgress>);
        let doneBytes = 0;
        let totalBytes = 0;
        for (const file of Object.values(files)) {
          doneBytes += file.done;
          totalBytes += file.total;
        }
        onProgress?.({ doneBytes, totalBytes });
      } else if (ev.event === 'download_failed') {
        throw new Error(`llama-server failed to download '${model}'`);
      } else if (ev.event === 'download_finished') {
        // Per the API docs, a GET /models after completion triggers the
        // router's model-list update so the new model shows up.
        await fetchModels();
        return;
      }
    }
    throw new Error(
      `llama-server event stream ended before '${model}' finished downloading`
    );
  } finally {
    // sseEvents cancels the stream when the for-await exits, but the POST can
    // throw before iteration ever starts — cancel here too (idempotent).
    await sseRes.body.cancel().catch(() => {});
  }
}
```

Note: `sseRes.body.cancel()` after `sseEvents` already consumed/cancelled it can reject or throw on a locked stream depending on runtime — hence `.catch(() => {})`; if the runtime throws synchronously on a locked stream, wrap that line in `try { ... } catch { /* already released by sseEvents */ }` instead. Let the test run tell you which is needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/llama-server-client.test.ts`
Expected: PASS (all, including the pre-existing describe blocks).

- [ ] **Step 5: Run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/backends/llama-server/client.ts test/llama-server-client.test.ts
git commit -m "feat: implement llama-server pullModel via POST /models + SSE (client-pull)"
```

---

### Task: adapter-wiring

Expose `pullModel` as the backend's `pull` capability. This flips the backend-shape test that currently asserts pull is absent — update that assertion first (TDD: the changed test fails, then wiring makes it pass).

**Files:**
- Modify: `src/backends/llama-server/index.ts`
- Test: `test/llama-server-backend.test.ts` (~line 205)

**Interfaces:**
- Consumes: `pullModel` from `./client.js` (client-pull task).
- Produces: `llamaServerBackend.pull` — used by `runBench` via the existing capability checks; no caller changes needed.

- [ ] **Step 1: Update the backend-shape test**

In `test/llama-server-backend.test.ts`, replace the `does not declare loadedModels, remoteCandidates, or pull` test with:

```ts
  it('declares pull and unload, but not loadedModels or remoteCandidates', () => {
    expect('loadedModels' in llamaServerBackend).toBe(false);
    expect('remoteCandidates' in llamaServerBackend).toBe(false);
    expect(typeof llamaServerBackend.pull).toBe('function');
    expect(typeof llamaServerBackend.unload).toBe('function');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/llama-server-backend.test.ts`
Expected: FAIL — `typeof llamaServerBackend.pull` is `'undefined'`.

- [ ] **Step 3: Wire pull into the backend**

In `src/backends/llama-server/index.ts`: add `pullModel` to the import from `./client.js`, add `pull: pullModel,` to the `llamaServerBackend` object (before `unload`), and update the doc comment above it — pull is no longer a tracked fast-follow:

```ts
/** Router mode only. loadedModels() is deliberately absent: no llama-server
 * endpoint reports real per-model VRAM, and faking it from file size would
 * poison bench.ts's calibration provenance (see docs/adapters.md).
 * remoteCandidates() is a tracked fast-follow. */
export const llamaServerBackend: Backend = {
  id: 'llama-server',
  displayName: 'llama-server',
  detect,
  localModels,
  generate: generateResult,
  pull: pullModel,
  unload: unloadModel,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/llama-server-backend.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backends/llama-server/index.ts test/llama-server-backend.test.ts
git commit -m "feat: expose pull() on the llama-server backend (adapter-wiring)"
```

---

### Task: spinner-update

`Spinner.update(message)` so long-running steps can change the rendered message mid-spin. TTY: the ticker renders the new message from the next frame. Non-TTY: no-op — the original message already printed once, and progress spam in piped output helps nobody.

**Files:**
- Modify: `src/progress.ts`
- Test: `test/progress.test.ts`

**Interfaces:**
- Produces: `update(message: string): void` on `Spinner` — consumed by `cli-progress-render`.

- [ ] **Step 1: Write the failing tests**

Add to `test/progress.test.ts` (uses the file's existing `fakeStream` helper):

```ts
describe('spinner.update', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the new message on subsequent ticks on a TTY', () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    const spinner = startSpinner('Pulling model...', { isTTY: true, stream });

    spinner.update('Pulling model... 1.2/2.7 GB (45%)');
    vi.advanceTimersByTime(120);
    expect(stream.writes.at(-1)).toContain('1.2/2.7 GB (45%)');

    spinner.stop();
  });

  it('is a no-op on a non-TTY stream', () => {
    const stream = fakeStream();
    const spinner = startSpinner('Pulling model...', { isTTY: false, stream });

    spinner.update('Pulling model... 1.2/2.7 GB (45%)');
    expect(stream.writes).toEqual(['Pulling model...\n']);

    spinner.stop();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/progress.test.ts`
Expected: FAIL — `spinner.update is not a function`.

- [ ] **Step 3: Implement update**

In `src/progress.ts`:

```ts
export interface Spinner {
  /** Swap the rendered message mid-spin (e.g. live download progress). On a
   * non-TTY stream this is a no-op: the original message already printed once,
   * and repeating every progress change in piped output is just noise. */
  update(message: string): void;
  stop(finalMessage?: string): void;
}
```

Non-TTY branch — add a no-op:

```ts
    return {
      update() {},
      stop(finalMessage) {
        if (finalMessage) stream.write(`${finalMessage}\n`);
      },
    };
```

TTY branch — make the rendered message mutable:

```ts
  let frame = 0;
  let current = message;
  const start = Date.now();
  const render = () => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    stream.write(`\r\x1b[K${FRAMES[frame++ % FRAMES.length]} ${current} (${elapsed}s)`);
  };
  render();
  const timer = setInterval(render, TICK_MS);

  return {
    update(newMessage) {
      current = newMessage;
    },
    stop(finalMessage) {
      clearInterval(timer);
      stream.write('\r\x1b[K');
      if (finalMessage) stream.write(`${finalMessage}\n`);
    },
  };
```

Note the render line now starts with `\r\x1b[K` (clear-to-end-of-line): messages can *shrink* when progress text changes, and without the clear, leftovers from a longer previous render would linger. The existing TTY animation test asserts `writes.every((w) => w.includes('Generating...'))` and the final `\r\x1b[K` — both survive this change; if the exact-write assertion `expect(lineClear).toBe('\r\x1b[K')` still passes (it should — stop's write is unchanged), leave the old test untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/progress.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/progress.ts test/progress.test.ts
git commit -m "feat: allow updating the spinner message mid-spin (spinner-update)"
```

---

### Task: cli-progress-render

Format progress as `<done>/<total> GB (<pct>%)` and feed it into the spinner from `withProgress`'s pull wrapper. The formatting lives in `src/format.ts` as a pure exported function (testable); `cli.ts` just glues it to `spinner.update`.

**Files:**
- Modify: `src/format.ts`
- Modify: `src/cli.ts` (~lines 53-66, the pull wrapper in `withProgress`)
- Test: `test/format.test.ts`

**Interfaces:**
- Consumes: `PullProgress` from `src/backends/types.js`; `Spinner.update` (spinner-update task).
- Produces: `formatPullProgress(p: PullProgress): string`.

- [ ] **Step 1: Write the failing tests**

Add to `test/format.test.ts` (add `formatPullProgress` to the existing import from `../src/format.js`, and `import type { PullProgress } from '../src/backends/types.js';`):

```ts
describe('formatPullProgress', () => {
  it('renders done/total in decimal GB with a percentage', () => {
    expect(formatPullProgress({ doneBytes: 1_200_000_000, totalBytes: 2_700_000_000 })).toBe(
      '1.2/2.7 GB (44%)'
    );
  });

  it('shows 0% instead of dividing by zero when total is unknown', () => {
    expect(formatPullProgress({ doneBytes: 0, totalBytes: 0 })).toBe('0.0/0.0 GB (0%)');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/format.test.ts`
Expected: FAIL — `formatPullProgress` is not exported.

- [ ] **Step 3: Implement in `src/format.ts`**

```ts
import type { PullProgress } from './backends/types.js'; // add to imports

/** Download progress for the bench spinner: decimal GB to one decimal place,
 * matching the table/bench output conventions in this file. */
export function formatPullProgress(p: PullProgress): string {
  const gb = (bytes: number) => (bytes / 1e9).toFixed(1);
  const pct = p.totalBytes > 0 ? Math.round((p.doneBytes / p.totalBytes) * 100) : 0;
  return `${gb(p.doneBytes)}/${gb(p.totalBytes)} GB (${pct}%)`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `withProgress` in `src/cli.ts`**

Add `formatPullProgress` to the existing import from `./format.js`. In the pull wrapper, pass an `onProgress` through to the backend:

```ts
    pull: pull
      ? async (model) => {
          const startedAt = Date.now();
          const spinner = startSpinner(`Pulling ${model}...`);
          try {
            await pull(model, (p) => {
              spinner.update(`Pulling ${model}... ${formatPullProgress(p)}`);
            });
          } catch (err) {
            spinner.stop();
            throw err;
          }
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          spinner.stop(success(`Pulled ${model} (${elapsed}s)`, color));
        }
      : undefined,
```

(Ollama's `pullModel` ignores the extra argument — plain JS, extra args are dropped — so this wrapper works unchanged for both backends.)

- [ ] **Step 6: Run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/format.ts src/cli.ts test/format.test.ts
git commit -m "feat: render live download progress in the bench pull spinner (cli-progress-render)"
```

---

### Task: live-verification

Manual end-to-end check against the real router (running on :8080 with the Qwen 0.5B repo cached). Uses a *different quant of the already-proven repo* so the download is real but small (~600MB), then cleans it up.

**Files:** none (manual verification + wrap-up)

- [ ] **Step 1: Confirm the router is up**

Run: `curl -sS http://localhost:8080/health`
Expected: `{"status":"ok"}`. If not, start it (or ask the human) before continuing.

- [ ] **Step 2: Pull a small model through the real CLI**

Run: `npx tsx src/cli.ts bench 'Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q8_0' --backend llama-server`
(`npm run dev` is the tsx entry per package.json; `--backend llama-server` skips detection of other backends.)

Expected observations:
- Spinner line shows `Pulling Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q8_0... <n>/<n> GB (<pct>%)` with the numbers advancing (progress renders on a real terminal only — piping stderr makes the spinner non-TTY and progress is deliberately silent there, so watch it live).
- Bench completes: pull → generate → unload, no thrown errors.

- [ ] **Step 3: Confirm the model registered**

Run: `curl -sS http://localhost:8080/models | python3 -m json.tool | grep -A2 'Q8_0'`
Expected: the Q8_0 entry appears in the list.

- [ ] **Step 4: Verify the download_failed path live (cheap)**

Run: `npx tsx src/cli.ts bench 'Qwen/nonexistent-repo-xyz-GGUF:Q4_K_M' --backend llama-server`
Expected: a clean thrown error surfacing the server's message (either the POST 400 validation error or `llama-server failed to download ...`), not a hang.

- [ ] **Step 5: Clean up the downloaded model**

Run: `curl -sS -X DELETE http://localhost:8080/models -d '{"model":"Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q8_0"}'`
Expected: success response; a follow-up `GET /models` no longer lists Q8_0.

- [ ] **Step 6: Full suite one last time**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean.

- [ ] **Step 7: Close out**

```bash
task 2363cc71 done
```

If any live observation contradicts the spec (event names, payload shapes), STOP: capture the actual payloads into `.parkinglot/llama-server-captures/`, fix the adapter + tests to match reality, and note the discrepancy in the spec doc before proceeding.
