# llama-server pull() with SSE download progress

**Date:** 2026-08-06
**Status:** Approved
**Taskwarrior:** 2363cc71 (llamafit llama-server pull())
**Parent spec:** 2026-08-06-llama-server-backend-design.md (fast-follows section)

## Goal

Implement `pull()` on the llama-server backend adapter so `llamafit bench
<model>` can download a model the router doesn't have yet, with live
download progress rendered in the existing CLI spinner.

llama-server's download API is asynchronous: `POST /models` returns
immediately and the download runs in the background. The adapter bridges
that to `pull()`'s synchronous `Promise<void>` contract by consuming the
`/models/sse` event stream until a terminal event arrives.

## API surface (verified against llama.cpp server README, build b10280;
corrected against a real router — see `.parkinglot/llama-server-captures/`)

- `POST /models`, body `{"model": "org/repo:QUANT"}` → `{"success":true}`
  (download started, non-blocking) or 400 with
  `{"error":{"message":...}}` when validation fails. **Live-verified
  gap:** for a repo/quant that doesn't exist on Hugging Face, this still
  returns 2xx — validation is lazy/absent, not a 400. See
  `.parkinglot/llama-server-captures/BUG-nonexistent-repo-does-not-fail-at-pull.md`.
- `GET /models/sse` — server-sent events. Relevant events, each tagged
  with a `model` field:
  - `download_progress`: data is **`{ progress: { <file URL>:
    {done: <bytes>, total: <bytes>} } }`** — the per-file map sits one
    level deeper than initially assumed, under a `progress` key.
    Getting this wrong silently aggregates to `NaN`/`NaN` (185/185 real
    progress events did so before the fix — nothing throws, since
    `Object.assign`/arithmetic on `undefined` just produces `NaN`
    quietly). See
    `.parkinglot/llama-server-captures/BUG-download-progress-shape.md`
    for the raw captured payload. Multiple files can download in
    parallel.
  - `download_finished` / `download_failed`: terminal events for the
    download. **Live-verified gap:** `download_failed` is not reliably
    reachable. For a nonexistent repo, the router emits
    `download_finished` (twice, with no `data` field) instead of
    `download_failed`, and the model is never actually added to
    `GET /models`. Treating `download_finished` as unconditional success
    is wrong — the adapter must re-fetch the model list and confirm the
    requested id is present before resolving. See
    `.parkinglot/llama-server-captures/BUG-nonexistent-repo-does-not-fail-at-pull.md`.
  - A `model_status` event (`{"status":"downloading"}`) precedes the
    first `download_progress` event; not branched on, silently ignored.
  - The stream is silent when nothing is changing (verified live —
    no initial snapshot event on connect).
- `GET /models` after completion triggers the router's model-list
  update so the new model appears — and per the point above, its
  response body is now load-bearing: the adapter checks
  `result.data.some((m) => m.id === model)` (exact id match, no
  `:latest`-style normalization) before treating the pull as
  successful.

## Contract change: progress callback on Backend.pull

`src/backends/types.ts`:

```ts
export interface PullProgress {
  doneBytes: number;
  totalBytes: number;
}

pull?(model: string, onProgress?: (p: PullProgress) => void): Promise<void>;
```

- Progress is aggregated across parallel files (sum of `done`, sum of
  `total`).
- The Ollama adapter ignores the new optional param — no change there.
- `onProgress` is best-effort UI plumbing: throwing inside it is not
  guarded against, and it may never fire (e.g. terminal event arrives
  before any progress event).

## CLI rendering

- `src/progress.ts`: `Spinner` gains `update(message: string): void`.
  On a TTY it swaps the message the ticker renders; on a non-TTY it is
  a no-op (the message was already printed once; progress spam in
  piped output helps nobody).
- `src/cli.ts` `withProgress`: the pull wrapper passes an `onProgress`
  that calls `spinner.update` with
  `Pulling <model>... <done>/<total> GB (<pct>%)` (GB to one decimal;
  fall back to the plain `Pulling <model>...` message until the first
  progress event).

## Adapter pull flow (src/backends/llama-server/)

Ordered to close the race where a small model finishes downloading
before the subscriber is attached:

1. Open `/models/sse` via `fetch` and hold the body stream.
2. `POST /models` with `{model}`. Non-OK → close the stream, throw
   with the server's `error.message` (existing `errorDetail` helper).
3. Read the stream through a minimal SSE parser (split on blank-line
   event boundaries, concatenate `data:` lines, JSON-parse; ignore
   comment/retry/event fields — this server puts the event name inside
   the JSON payload). Filter to events whose `model` matches the
   requested id. Then:
   - `download_progress` → unwrap `data.progress` (guard for it being
     absent), aggregate `{done,total}` across files, invoke
     `onProgress`.
   - `download_failed` → throw
     `llama-server failed to download '<model>'`.
   - `download_finished` → `GET /models` (existing `fetchModels()`) and
     check the result for the requested model id. Present → resolve.
     Absent → throw (phantom-finish case; see error-handling table).
   - Anything else (model_status, models_reload, other models'
     events) → ignore.
4. Stream ends without a terminal event (server shutdown, connection
   drop) → throw; never hang or silently succeed.
5. Always close/cancel the SSE stream on every exit path.

No overall timeout: multi-GB downloads are legitimately slow and the
Ollama `pull` has no timeout either. No reconnect logic: a dropped
stream mid-download is an error, not a resume point.

## Error handling summary

| Failure | Behavior |
|---|---|
| POST /models 400 (bad model id) | throw with server message |
| `download_failed` event | throw |
| SSE stream drops before terminal event | throw |
| Progress events never arrive but `download_finished` does, and the model *is* in the post-finish `GET /models` | resolve (spinner just never updates) |
| `download_finished` fires (even repeatedly) but the model is **absent** from the post-finish `GET /models` — e.g. nonexistent repo/quant, where the router never sends `download_failed` at all | throw `llama-server reported the download of '<model>' finished, but it never appeared in the model list — does that repo/quant exist?` |

## Testing

Existing patterns: adapter unit tests with mocked `fetch` /
fixture-backed client tests (`test/` + `test/helpers/`).

- SSE parser: pure-function tests over chunked input — events split
  across chunks, multiple events per chunk, non-progress events
  interleaved, other models' events filtered out.
- pull() flow: mocked fetch returning a scripted SSE body —
  happy path (progress → finished → resolves, onProgress saw
  aggregated bytes, `download_progress` data mocked in the real
  `{progress: {...}}`-wrapped shape), download_failed → rejects,
  POST 400 → rejects without consuming stream, stream EOF without
  terminal event → rejects, phantom-finish (download_finished but the
  post-finish `GET /models` list omits the model) → rejects naming the
  backend and model. Happy-path `GET /models` mocks include the pulled
  model in `data` (previously an empty list, which is no longer valid
  once the finished-but-absent check exists).
- Spinner.update: TTY swap renders new message; non-TTY no-op.
- withProgress pull wrapper: onProgress formats GB/percent into
  spinner.update.
- Live verification (manual): router on :8080, pull a small model
  (e.g. Qwen2.5-0.5B repo already proven), watch progress render,
  confirm model appears in `GET /models`.

## Non-goals

- Download cancellation (`POST /models/unload` mid-download).
- Reconnect/resume of a dropped SSE stream.
- Progress for Ollama pulls (its adapter shells out to `ollama pull`;
  adopting the callback there is separate work).
- `remoteCandidates()` — still blocked on the discovery-scoping
  conversation (task 4212cb92).
