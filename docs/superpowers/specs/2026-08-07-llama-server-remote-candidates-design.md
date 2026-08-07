# llama-server `remoteCandidates()`: Design

## Purpose

Implement the `remoteCandidates()` fast-follow for the llama-server backend
(taskwarrior `4212cb92`), deferred from the adapter spec
(`docs/superpowers/specs/2026-08-06-llama-server-backend-design.md`,
fast-follows section). Discovery source: the Hugging Face Hub model API —
the same place llama-server's own `-hf` pull mechanism draws from, so
discovery and pull line up by construction.

## Decisions already made

- **HF Hub API is the single discovery source.** A research pass over
  alternatives found nothing better: every non-HF catalog is either an HF
  scrape re-serving HF URLs (Jan.ai, LM Studio, local-ai-zone), archived or
  dead (lmstudio-ai/model-catalog, mygguf.com), too small and stale
  (GPT4All, ~30 models), or not pullable by llama-server at all (Ollama's
  registry). Docker Hub's `ai/` namespace (~93 models, pullable via `-dr`)
  is the only structurally interesting alternative and is explicitly out of
  scope.
- **No author allowlist; ship a qualification rubric instead.** Live
  testing showed raw `sort=trendingScore` results are ~80% finetune spam
  with botted download counts (e.g. a 477k-download "Uncensored" repo),
  and `author=` filtering fixes it — but maintaining an org allowlist is a
  curation burden the project doesn't want. Decision: fetch broadly,
  annotate every candidate with trust signals, and emit a prose rubric in
  the output describing how to qualify a trustworthy quant source. The
  consumer (human or agent reading `check --json`) applies the judgment.
  Orgs named in the rubric (ggml-org, bartowski, unsloth,
  lmstudio-community) are examples illustrating the criteria, not a
  filter.
- **Server-side size filtering via `num_parameters`, cap passed by the
  caller.** `check.ts` knows the machine's headroom; the backend doesn't.
  The `Backend` interface gains an options argument so check can pass a
  headroom-derived parameter cap and HF filters server-side — every
  candidate slot goes to a model that could plausibly fit. Cap derivation
  inverts the footprint formula using existing data, no new constants:
  `maxParameterSizeB = baselineHeadroomGb / (fallbackQuant.bytesPerParam *
  overheadMultiplier)`.
- **Candidates carry their available quants**, parsed from
  `expand[]=siblings` filenames in the same request, so a row is directly
  actionable as a `<owner>/<repo>:<QUANT>` pull/bench target.
- **The HF client is a shared module** (`src/hf/discovery.ts`), not
  llama-server-internal. Ollama can also pull from HF
  (`ollama pull hf.co/<owner>/<repo>:<quant>`), so a tracked fast-follow
  can point the ollama backend at this same module and retire the
  ollama.com scrape. Only the hit→ModelInfo mapping (pull-name shape) is
  per-backend.
- **API facts verified live (2026-08-07), not from docs** — the docs
  reference has rotted to an incomplete OpenAPI spec, so live probing is
  ground truth (same lesson as the pull() work):
  - `expand[]=gguf` works on the **list** endpoint — parameter counts
    (`gguf.total`) for all hits in one request, no N+1. `expand[]`
    **replaces** the default field set, so downloads/likes/etc. must be
    requested explicitly. `expand[]=siblings` composes with the rest.
  - `num_parameters` works on the API: `max:12B`, `min:X,max:Y`, raw
    integers. Composes with search/filter/sort/expand.
  - `sort=trendingScore` is the API spelling; the web UI's
    `sort=trending` returns HTTP 400.
  - `base_model_relation=base` + `filter=gguf` returns an empty array
    (GGUF repos are `quantized` relations by definition) — can't be used
    to cut finetune noise here.
  - `apps=llama.cpp` is validated server-side but was a near-no-op on
    result quality in testing; harmless, not load-bearing.
  - `pipeline_tag=text-generation` cuts non-LLM noise (image-gen, ASR,
    embeddings) — this one matters.
  - Anonymous access: 500 requests/5min per IP. This feature uses 1 per
    invocation. No `HF_TOKEN` handling in v1.

## Non-goals

- New CLI flags (`--remote-limit`, `--remote-filter`, etc.) — existing
  `--json` covers the agent path; flags are cheap fast-follows if wanted.
- Docker Hub `ai/` as a secondary source.
- `HF_TOKEN` auth / rate-limit sophistication.
- Switching the ollama backend to HF discovery (tracked fast-follow, not
  this scope — it touches scrape tests and cloud-model `skipped`
  handling).
- Retiring the `scrape-failed` gap kind (rides with the ollama
  switchover).

## The HF request

`src/hf/discovery.ts`, one GET per invocation:

```
https://huggingface.co/api/models
  ?search=<query>                    — omitted when query is empty
  &filter=gguf
  &pipeline_tag=text-generation
  &num_parameters=max:<capParams>    — raw integer param count (cap in
                                       billions × 1e9): decimal "B" suffixes
                                       were never live-verified, raw integers
                                       were. Omitted when caller passes no cap
  &sort=trendingScore
  &limit=10
  &expand[]=gguf&expand[]=siblings&expand[]=downloads
  &expand[]=likes&expand[]=lastModified&expand[]=trendingScore
```

Per-hit mapping:

- `id` (`<owner>/<repo>`) → candidate name (llama-server pull shape is
  `<owner>/<repo>:<QUANT>`; name stays the bare repo id, quants listed
  separately) and `author` (owner prefix).
- `gguf.total / 1e9` → `parameterSizeB`. Hits missing `gguf.total` map to
  `null` and get dropped by check's existing remote-row filter. Note for
  MoE repos `total` is total params, not active — accepted approximation,
  consistent with how `localModels()` reports `meta.n_params`.
- `https://huggingface.co/<id>` → `url`.
- `siblings` → `availableQuants`: parse `*.gguf` filenames for the quant
  token (`Q4_K_M`, `IQ4_XS`, `Q8_0`, `F16`, `BF16`, ...), collapse
  multi-part shards (`-00001-of-00002`), dedupe, preserve repo order.
  Unparseable filenames are skipped, never guessed.
- `downloads`, `likes`, `trendingScore`, `lastModified` → `signals`.

Failures throw with status-aware messages (429 named explicitly);
`check.ts` already converts throws into a `scrape-failed` gap plus a
warning, and that existing rail is reused unchanged.

## Interface changes

`src/backends/types.ts`:

```ts
remoteCandidates?(query?: string, opts?: RemoteCandidateOptions): Promise<ModelInfo[]>;

interface RemoteCandidateOptions {
  maxParameterSizeB?: number;
}
```

The ollama implementation ignores `opts` (no signature change needed —
extra args are invisible to it).

`ModelInfo` gains optional remote-metadata fields, unset for local rows
and for backends that don't provide them:

```ts
author?: string | null;
availableQuants?: string[];
signals?: {
  downloads: number | null;
  likes: number | null;
  trendingScore: number | null;
  lastModified: string | null;
} | null;
```

`CheckRow` carries the same optional fields through so they reach both
formatters. `CheckResult` gains `remoteGuidance: string | null`.

## check.ts changes

Headroom is already computed before candidates are fetched, so the only
changes are:

- Derive the cap: `maxParameterSizeB = baselineHeadroomGb /
  (fallbackQuant.bytesPerParam * overheadMultiplier)`, via a small
  exported helper next to the formula estimator (inverse of its own
  formula, reading the same `data.ts` tables). Baseline headroom, not
  current: discovery should show what the machine can run, not what this
  moment's memory pressure allows.
- Pass `{ maxParameterSizeB }` to `backend.remoteCandidates(query, opts)`.
- Copy `author`/`availableQuants`/`signals` onto remote rows.
- Set `remoteGuidance` to the rubric when any remote row carries signals;
  `null` otherwise (keeps ollama output byte-identical today).

## The rubric (`remoteGuidance`)

A short prose block, stored as a constant next to the discovery module.
Content contract (exact wording at implementation time):

- Qualify a source by: official model-vendor orgs (Qwen, meta-llama,
  google, microsoft, LiquidAI); established quant houses with history
  across many model families — examples: ggml-org, bartowski, unsloth,
  lmstudio-community; verified-org badges on HF.
- Distrust: single-model orgs, "uncensored"/"abliterated"/merge-word-salad
  naming, download counts wildly out of proportion to likes and account
  age (download counts are botted in practice — never trust them alone).
- Candidates are pullable as `<owner>/<repo>:<QUANT>` using
  `availableQuants`.

## Output

- `check --json`: new fields flow through `formatCheckJson`'s existing
  whole-struct serialization automatically — no formatter change.
- `formatCheckTable`: remote rows append a compact quant list (truncated
  with a `+N more` when long); when `remoteGuidance` is set, a one-line
  footer points to `--json` for signals + guidance. No table columns for
  raw signals — that's the agent path's job.

## Testing

- Fixture: one real captured HF list response (full query shape above)
  checked in as `test/fixtures/hf-models-*.json` per `docs/adapters.md`'s
  "real captured data, not hand-rolled" rule; discovery tests run against
  it (mapping, missing-`gguf` hits, URL building incl. omitted params).
- Table-driven quant-filename parsing tests (standard quants, IQ variants,
  F16/BF16, sharded files, unparseable names).
- Cap-derivation helper test: inverse-formula round-trips with the quant
  table's fallback entry.
- check-flow test with a stub backend: opts passed through, signals land
  on rows, `remoteGuidance` set/null appropriately, ollama-shaped backends
  (no signals) produce today's output unchanged.
- Live-verification task before merge: run the real query against HF,
  confirm the six-`expand[]` composition and capture the fixture from that
  run.

## Fast-follows (tracked, not this scope)

- Point ollama's `remoteCandidates` at `src/hf/discovery.ts`
  (`hf.co/<owner>/<repo>:<quant>` pull names), retire the ollama.com
  scrape and eventually the `scrape-failed` gap kind.
- Optional flags: `--remote-limit`, broad/curated source toggle.
- `HF_TOKEN` passthrough if anonymous rate limits ever bite.
