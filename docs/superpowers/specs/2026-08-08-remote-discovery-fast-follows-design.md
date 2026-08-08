# remote discovery fast-follows — design

Four small fast-follows from
`docs/superpowers/specs/2026-08-07-ollama-hf-second-source-design.md`
(taskwarrior `353`-`356`), bundled into one plan since each is a
disjoint, mechanical change with no shared implementation risk.

## 1. `RemoteSourceReport` → discriminated union (353)

`src/backends/types.ts` currently declares:

```ts
export interface RemoteSourceReport {
  id: string;
  query: string;
  ok: boolean;
  error?: string; // present when ok is false
}
```

The `ok:false ⟹ error present` invariant is comment-enforced only.
Change to:

```ts
export type RemoteSourceReport =
  | { id: string; query: string; ok: true }
  | { id: string; query: string; ok: false; error: string };

export function isFailedSource(
  s: RemoteSourceReport
): s is Extract<RemoteSourceReport, { ok: false }> {
  return !s.ok;
}
```

Three call sites read `.error` after filtering `!s.ok`; a bare
`.filter(s => !s.ok)` predicate doesn't narrow the array element type,
so `.error` would no longer typecheck there. Switch those sites to
`isFailedSource`:

- `src/check.ts` (`failedSources = remoteSources.filter(...)`)
- `test/ollama-backend.test.ts` (two assertions on `.error`)
- `test/llama-server-backend.test.ts` (one assertion on `.error`)

No behavior change — `sources.push({ ok: true, ... })` /
`sources.push({ ok: false, ..., error: msg })` call sites in
`src/backends/ollama/index.ts` and `src/backends/llama-server/index.ts`
already construct one variant or the other; they just get stricter
checking.

## 2. `GapCollector` cross-backend collapse (354)

`GapCollector.add()` (`src/gaps.ts`) dedups on `kind + summary`. In
`src/check.ts`, both the backstop gap (line ~94, summary `'remote
model search failed'`) and the per-source gap (line ~104, summary
`` `remote source ${s.id} failed` ``) omit the backend id from the
*summary* string — it's only in `evidence`. In a multi-backend run,
the same source (e.g. `huggingface`) failing for two different
backends produces two gaps with identical summaries, so the second
`add()` call is silently dropped by dedup and the report reads as if
only one backend hit it.

Fix: fold `backend.id` into both summary strings:

- `` `remote model search failed for backend ${backend.id}` ``
- `` `remote source ${s.id} failed for backend ${backend.id}` ``

## 3. Conformance test for `remoteCandidates()` (355)

`test/conformance/backend.ts` checks generic `Backend` shape
properties but nothing about what `remoteCandidates()` actually
resolves to. Add a case, guarded on the capability being present
(same pattern as the existing "every optional capability is a
function" check):

```ts
it('remoteCandidates(), if present, never rejects and resolves {candidates, sources}', async () => {
  const backend = await setup();
  if (!backend.remoteCandidates) return;
  const discovery = await backend.remoteCandidates();
  expect(Array.isArray(discovery.candidates)).toBe(true);
  expect(Array.isArray(discovery.sources)).toBe(true);
});
```

Runs for free against both existing backends via their existing
`describeBackendConformance(...)` calls in `test/ollama-backend.test.ts`
and `test/llama-server-backend.test.ts` — those already set up a
fixture-backed or mocked backend, so no live network call happens
here. No new fixture wiring needed. This is the guardrail for a
hypothetical third backend: it fails loudly if that backend's
`remoteCandidates()` throws instead of reporting per-source failure,
the same contract `test/conformance/backend.ts` already enforces for
`detect()`.

## 4. Docs fixture note (356)

`docs/adapters.md`'s Fixture conventions section (~line 348) lists
`hf-models-search.json` consumers as `test/hf-model-info.test.ts`,
`test/llama-server-backend.test.ts`, and `test/ollama-backend.test.ts`.
`test/hf-discovery.test.ts` also loads it directly and is missing from
the list. Add it.

## Testing

- 353: existing test suites continue to pass once call sites use
  `isFailedSource`; `tsc --noEmit` is the real check here (catches any
  other narrowing gaps this design missed).
- 354: a `check.ts` test with two backends (or two calls) where the
  same source id fails for both, asserting two distinct gaps land in
  `GapCollector.list()`.
- 355: the new conformance case itself is the test; run the full suite
  to confirm it passes against both current backends.
- 356: docs-only, no test.

## Non-goals

- Renaming `scrape-failed` gap kind or `scrapeWarning` field (already
  called out as out-of-scope in the second-source design).
- Any change to `RemoteDiscovery`, `ModelInfo`, or the check-table
  footer format — this is type-safety and test-coverage hardening on
  the existing shapes, not a behavior change.
