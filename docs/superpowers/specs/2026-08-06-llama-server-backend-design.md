# llama-server Backend Adapter (Router Mode): Design

## Purpose

Implement `Backend` (`src/backends/types.ts`) for llama.cpp's `llama-server`,
closing taskwarrior `fc0885b9`. This is the first of three roadmap adapters
called out in the llamafit generalization spec
(`docs/superpowers/specs/2026-08-05-llamafit-generalization-design.md`);
`23a848dd` (generalizing `format.ts` labels) rides along once this and the
linux-probe land.

## Decisions already made

- **Target router mode, not classic single-instance.** llama-server has two
  deployment shapes: classic (`llama-server -m model.gguf`, exactly one
  model, no load/unload) and router mode (`llama-server` with no `-m`,
  multi-model via `--models-dir`/`--models-preset`/HF cache, with
  `/models/load` and `/models/unload`). Router mode is newer and less
  widely deployed, but it's the one that gives real load/unload semantics
  instead of nothing — chosen deliberately over the more conservative
  single-instance-only option.
- **All API shapes below were captured live**, not taken from documentation
  alone. A real router instance was stood up locally (`llama-server -hf
  Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M` to seed the HF cache, then
  `llama-server` with no flags to enter router mode) and every endpoint in
  this doc was hit for real. Raw captures live at
  `scratchpad/llama-server-captures/*.json` in this session and become
  `test/fixtures/llama-server-*.json` verbatim during implementation, per
  `docs/adapters.md`'s "real captured data, not hand-rolled" rule. Two
  things the README doesn't document, confirmed live:
  - `meta.ftype` gives quantization directly as a human string (e.g.
    `"Q4_K - Medium"`) — no need to parse it out of the model `id` suffix.
  - Bare `GET /props` (no `?model=`) works in router mode and returns
    `{role: "router", build_info: "b10280-...", model_path: "none", ...}`
    — version info without needing any model loaded.
- **`loadedModels()` is deliberately not implemented.** No llama-server
  endpoint exposes real per-model VRAM (`/slots` and `/metrics` don't have
  it; memory is managed implicitly through slot allocation). Faking it from
  `meta.size` (on-disk file size) would silently mislabel `check.ts` rows as
  `estimateSource: 'measured'` and — worse — `bench.ts` uses
  `loadedModels()` output as ground truth for `data/calibration.json`
  provenance rows. A fabricated number there would poison the calibration
  data set with no way to tell it apart from a real measurement later. This
  follows `docs/adapters.md`'s own principle: "prefer under-reporting than
  fabricating."
- **`remoteCandidates()` and `pull()` are fast-follows, not this scope.**
  Discovery: llama-server's own catalog is whatever's in the cache/dir/preset
  already — no built-in remote search. The real analog to Ollama's
  ollama.com scrape is the Hugging Face Hub's model API (official JSON, not
  HTML scraping): `GET /api/models?search=<q>&filter=gguf&...` for repo
  hits, then a per-repo detail call (`GET /api/models/<repo>?expand[]=gguf&
  expand[]=siblings`) for parameter count (`gguf.total` — confirmed live,
  matched the running server's `meta.n_params` exactly) and available quant
  files (`siblings`, filename-parsed). Two-tier and bounded (top-N repos by
  downloads), meaningfully more than Ollama's single-page scrape. Punted per
  explicit human call: HF is "a good place to get model info once we know
  them," not a well-scoped discovery/search source, so building the search
  half now is premature. `pull()` is real (`POST /models` triggers an async
  HF-cache download) but SSE-progress-driven — implementing its synchronous
  `Promise<void>` contract means polling `GET /models` or consuming
  `/models/sse` until the status leaves `downloading`, handling the
  `failed: true` case. Both tracked as new fast-follow tasks once this
  lands, same pattern as `06c17db1`.

## Non-goals

- Classic single-instance mode. Not handled by this adapter at all —
  `detect()` targets router-mode responses specifically (see below); a
  classic-mode server will simply fail detection or behave oddly, and
  that's fine for this scope.
- `remoteCandidates()`, `pull()` — see fast-follows above.
- Any GGUF-metadata-based quant/size story for models that have never been
  loaded (see `localModels()` below) — genuinely unavailable from the
  router without loading, not something to invent.

## API surface

Base URL: new `LLAMA_SERVER_BASE_URL` env var, same handling as
`OLLAMA_HOST` (`src/backends/ollama/client.ts`'s scheme-prefixing logic),
default `http://localhost:8080`.

### `detect()`

`GET /health` for presence — `{"status":"ok"}` (200) means detected;
non-200 (including the documented 503 "Loading model" case) means not.
Never throws, matching `ollamaBackend.detect()`'s pattern of catching
network errors into `{detected: false, evidence: {error}}`.

Version: best-effort follow-up `GET /props` (no `?model=` — confirmed this
works bare in router mode) for `build_info`. If that call fails, `detect()`
still resolves `detected: true` with `version: null` — version is a nice-to
-have, not a gate.

### `localModels()`

`GET /models` is the single source of truth — every model the router knows
about (cache/`--models-dir`/preset), any status
(`unloaded`/`loading`/`loaded`/`sleeping`/`downloading`). Maps each entry to
a `ModelInfo`:

- `name`: the `id` field verbatim (e.g.
  `"Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M"`).
- `source`: `'local'` always — an unloaded-but-known model is still
  "installed," just not resident. No `skipped`/cloud-model concept here;
  that's an Ollama-specific idea (models that run on Ollama's remote
  infra), which router mode has no equivalent of.
- `parameterSizeB`, `diskSizeBytes`, `quantizationLevel`: present **only
  when `meta` is present** — confirmed live that `meta` appears after a
  model has been loaded at least once and disappears again after unload.
  `parameterSizeB` = `meta.n_params / 1e9`, `diskSizeBytes` = `meta.size`,
  `quantizationLevel` from `meta.ftype` through a small normalizing map
  (llama.cpp's `ftype` strings like `"Q4_K - Medium"` → the canonical IDs
  `data/quants.json` already uses, e.g. `"Q4_K_M"` — table to be built
  during implementation against llama.cpp's own `llama_ftype` enum names,
  cross-checked against `data/quants.json`'s existing ids/aliases). For any
  model without `meta` (never loaded this server lifetime), all three are
  `null` — a real, disclosed gap: llamafit genuinely cannot know an
  unloaded model's footprint without loading it first, unlike Ollama where
  `ollama list` always reports parameter size and quant for anything
  pulled.
- `url`: `null` — no per-model detail page in this API (unlike Ollama's
  library page).

### `generate()`

`POST /completion` (llama.cpp's native endpoint, not the OAI-compatible
`/v1/chat/completions`) — matches Ollama's choice of raw-completion over
chat-templated for benchmarking, sidesteps per-model jinja-template
variance. `model` field is required in router mode (ignored/optional in
classic mode, irrelevant here since router mode is the only target).

Maps the response's `timings` object (confirmed live shape:
`{cache_n, prompt_n, prompt_ms, prompt_per_second, predicted_n,
predicted_ms, predicted_per_second}`) to `GenerateResult`:

- `evalCount` ← `predicted_n` (also mirrored at top level as
  `tokens_predicted`; `timings.predicted_n` is the one to use for
  consistency with the rest of the timing block)
- `evalDurationSeconds` ← `predicted_ms / 1000`
- `totalDurationSeconds` ← `(prompt_ms + predicted_ms) / 1000`
- `loadDurationSeconds` ← always `null`. No such field exists; router-mode
  auto-load latency (if the model wasn't already loaded) is absorbed into
  the request's overall latency, not broken out anywhere.

Timeout handling mirrors `ollamaBackend`'s `generate()`: `AbortController`
+ `setTimeout`, resolves `null` on abort rather than throwing (a meaningful
result per the `Backend` interface's doc comment).

### `unload()`

`POST /models/unload {"model": "<id>"}` → `{"success": true}`. Confirmed
live, clean 1:1 match — no mapping needed beyond checking the response
isn't an error shape (`{"error": {code, message, type}}`, confirmed live
for the "unknown model" case via `/models/load`, presumably identical shape
for `/models/unload` against an unknown id though not separately captured).

## Testing

Same conformance pattern as `ollamaBackend`:
`describeBackendConformance('llama-server', async () => llamaServerBackend)`
in the new backend's test file. Fixtures under `test/fixtures/`, sourced
from the live captures in `scratchpad/llama-server-captures/` (this
session): health, props (router-level, no model), props (model-specific,
loaded), models (unloaded / loading / loaded-with-meta / after-unload),
completion success, models/load success, models/load error (unknown
model), models/unload success. `fetch` stubbed the same way
`test/ollama-backend.test.ts` does (`globalThis.fetch` in
`beforeEach`/`afterEach`), no real network calls or system commands.

Pure mapping functions (`mapModelsToLocalModels`, `mapCompletionToGenerate`,
the `ftype`-normalizing lookup) tested directly against the captured
fixtures, following `src/backends/ollama/index.ts`'s
`mapTagsToLocalModels`/`mapPsToLoaded`/`mapCandidates` precedent — each
independently testable with no network involved.

## Docs

`docs/adapters.md` gets a short addition noting the `meta`-only-when-loaded
behavior and the `loadedModels()`-omission rationale (real per-model VRAM
doesn't exist in this API) — both are things a future backend author
working against a different llama.cpp-family server will plausibly hit
too.
