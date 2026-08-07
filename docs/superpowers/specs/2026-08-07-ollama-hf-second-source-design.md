# ollama HF second source — design

Add Hugging Face Hub discovery to the ollama backend as a second remote
source alongside its ollama.com scrape (taskwarrior `26f8c33e`), the
tracked fast-follow from
`docs/superpowers/specs/2026-08-07-llama-server-remote-candidates-design.md`.
`src/hf/discovery.ts` was built backend-agnostic for exactly this; only
the pull-name mapping is per-backend.

## Decisions already made

- **The ollama.com scrape stays.** HF is an *additional* source, not a
  replacement (human call from the remote-candidates session:
  ollama.com's library is the marginally easier, more accessible path
  for ollama users).
- **No author allowlist; signals + rubric.** HF rows carry the same
  trust signals (author/downloads/likes/trendingScore/lastModified) and
  the same `REMOTE_GUIDANCE` rubric as llama-server's rows. check.ts
  already emits the rubric whenever any row has signals — it lights up
  for ollama with no changes.
- **Discovery must be agent-legible** (human steer this session): the
  output should tell a consumer what each source actually searched and
  whether it succeeded, so an agent reading `check --json` can decide to
  re-run with an explicit `--query` instead of guessing at defaults.

## Interface: `RemoteDiscovery` return type

`Backend.remoteCandidates` returns a structured result instead of bare
`ModelInfo[]` (`src/backends/types.ts`):

```ts
export interface RemoteSourceReport {
  id: string;        // 'ollama.com' | 'huggingface'
  query: string;     // the query actually sent to this source
  ok: boolean;
  error?: string;    // present when ok is false
}

export interface RemoteDiscovery {
  candidates: ModelInfo[];
  sources: RemoteSourceReport[];
}
```

Source-level failures (network, HTTP status, rate limit, parse) become
`ok: false` reports, not throws. A throw from `remoteCandidates` now
means a bug, but check.ts keeps its existing try/catch as a backstop
(treated as every source failing).

`ModelInfo` gains `discoverySource?: string` (remote rows only), so
consumers attribute rows without parsing `hf.co/` prefixes out of names.
It flows through to `CheckRow` like author/availableQuants/signals.

## Query semantics move into the backend

The per-backend default in `cli.ts` (`opts.query ?? (backend.id ===
'ollama' ? 'mlx' : '')`) is removed. `runCheck` and `remoteCandidates`
accept `query?: string`; `undefined` means "no query given — apply your
defaults", and each backend decides per source:

- **ollama**: scrape gets `'mlx'` (historical default preserved), HF
  gets `''` (bare trending, same as llama-server).
- **llama-server**: `''`.

An explicit `--query` goes to every source verbatim. Whatever happened
is visible in `sources[].query`.

## ollama implementation

`remoteCandidates(query?, opts?)` runs both sources concurrently via
`Promise.allSettled`:

- `scrapeSearch(scrapeQuery)` — unchanged. Scrape rows keep their
  current mapping plus `discoverySource: 'ollama.com'`. No size cap:
  the scrape can't filter server-side, and "won't fit" verdicts on
  oversized rows are still informative.
- `searchGgufModels(hfQuery, { maxParameterSizeB: opts.maxParameterSizeB })`
  — the headroom cap check.ts already passes (and ollama currently
  drops on the floor) finally applies, server-side.

HF hits map exactly like llama-server's rows (author, availableQuants,
signals, `quantizationLevel: null`, `diskSizeBytes: null`) except:

- `name` is the ollama pull shape: `hf.co/<owner>/<repo>`. One row per
  repo; the quant is chosen at pull time by appending `:<quant>` from
  `availableQuants` (ollama resolves a default quant when the tag is
  omitted).
- `discoverySource: 'huggingface'`.

The shared hit→ModelInfo mapping moves to a small helper module,
`src/hf/model-info.ts`, parameterized by a name-mapping function;
llama-server refactors to use it (`name: repoId` there). It lives
outside `discovery.ts` so that file keeps its zero-project-imports
property.

Candidates concatenate scrape-first. **No dedup across sources**: the
same underlying model appearing as both `qwen3` and
`hf.co/Qwen/Qwen3-...-GGUF` is two genuinely different pull paths with
different provenance; signals + guidance help the consumer choose.

## check.ts and output

- Each `ok: false` source → a `scrape-failed` gap (evidence gains
  `source` alongside backend/query/error) and a stderr warning line, but
  the other source's rows still render — one source down no longer
  blanks the remote section. `scrapeWarning` stays as the human-facing
  aggregate (joined per-source failure messages, `null` when all ok).
- `CheckResult` gains `remoteSources: RemoteSourceReport[]`, emitted
  as-is in `--json`.
- `formatCheckTable` adds a footer line near the remote-links section,
  e.g.:

  ```
  Remote sources: ollama.com search "mlx" · huggingface trending (no query)
  ```

  A failed source renders in that line as `huggingface: failed (<error>)`
  (exact wording is the plan's call). Backends reporting no sources
  (none today) omit the line.

## Error handling summary

| scrape | HF   | result |
|--------|------|--------|
| ok     | ok   | merged rows, no warning |
| ok     | fail | scrape rows render; HF gap + warning; `sources` shows it |
| fail   | ok   | HF rows render; scrape gap + warning; `sources` shows it |
| fail   | fail | empty remote section; two gaps + warnings |

## Testing

- ollama `remoteCandidates` unit tests (mock fetch): both ok (merge
  order, HF name shape, signals present), each source failing alone,
  both failing, query-default routing (`undefined` → `'mlx'`/`''`,
  explicit query → both).
- llama-server wrapper: returns `RemoteDiscovery` with a single
  huggingface source report; its fetch failure becomes `ok: false`, not
  a throw.
- check.ts: partial-failure produces a gap per failed source and still
  returns the surviving rows; `remoteSources` lands in `CheckResult`.
- format: footer line for ok/failed/mixed sources; guardrail fixtures
  (`guardrail-check*.txt/json`) updated for the new footer and JSON
  fields.
- Fixtures: `test/fixtures/hf-models-search.json` exists; add an
  ollama.com search HTML fixture if scrape tests don't already have one
  inline.
- Live verification against real ollama.com + HF before merge, per repo
  pattern.

## Non-goals

- Dedup/merge of the same model across sources (see above).
- New CLI flags (per-source query overrides, `--remote-limit`, source
  enable/disable). `--json` + `sources[]` covers the agent path; flags
  are cheap fast-follows if wanted.
- Renaming the `scrape-failed` gap kind or `scrapeWarning` field — the
  names predate multi-source and renaming is churn out of this scope
  (the fast-follows task `06c17db1` already tracks gap-summary cleanup).
- Docker Hub `ai/` namespace as a source.
- `HF_TOKEN` auth / rate-limit handling beyond the existing 429 message.
