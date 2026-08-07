# ollama HF Second Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Hugging Face Hub discovery to the ollama backend as a second remote source alongside its ollama.com scrape, with per-source query/success reporting that flows to `check --json` and the human footer.

**Architecture:** `Backend.remoteCandidates` changes to return `RemoteDiscovery` (`{ candidates, sources }`) so source-level failures and per-source queries are data, not throws. The shared HF hit→ModelInfo mapping is extracted to `src/hf/model-info.ts` parameterized by pull-name shape (`owner/repo` for llama-server, `hf.co/owner/repo` for ollama). Per-backend query defaults move out of `cli.ts` into the backends (ollama: scrape `'mlx'` / HF `''`; llama-server: `''`). check.ts turns failed sources into `scrape-failed` gaps + warnings while surviving sources' rows still render.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest 2, native `fetch`, `Promise.allSettled`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-07-ollama-hf-second-source-design.md` — read it first.

## Global Constraints

- Task headers are kebab-case slugs; commits reference the slug, e.g. `feat: extract shared HF candidate mapper (hf-shared-mapper)`.
- Fixtures are real captured data, never hand-rolled (`docs/adapters.md` rule). Both fixtures this plan needs already exist: `test/fixtures/hf-models-search.json`, `test/fixtures/ollama-search-mlx.html`.
- `src/hf/discovery.ts` keeps its zero-project-imports property — the new mapper lives in `src/hf/model-info.ts`, not there.
- Source ids are exactly `'ollama.com'` and `'huggingface'`.
- ollama HF row names are exactly `hf.co/<repoId>` (e.g. `hf.co/ggml-org/gemma-3-4b-it-GGUF`). llama-server names stay bare `repoId`.
- Candidate order within ollama: all scrape rows, then all HF rows.
- No dedup across sources (spec non-goal). No new CLI flags. `scrape-failed` gap kind and `scrapeWarning` field keep their names.
- A `remoteCandidates` throw is a bug; source failures are `ok: false` reports. check.ts keeps its try/catch as a backstop.
- Run tests with `npx vitest run` (single file: `npx vitest run test/<file>.test.ts`); typecheck with `npx tsc --noEmit`.

---

### Task: hf-shared-mapper

Extract llama-server's candidate→ModelInfo mapping into a shared module so ollama can reuse it with a different pull-name shape. Pure refactor — llama-server behavior is unchanged.

**Files:**
- Create: `src/hf/model-info.ts`
- Create: `test/hf-model-info.test.ts`
- Modify: `src/backends/llama-server/index.ts` (delete local `mapCandidatesToModelInfo`, use the shared one)

**Interfaces:**
- Consumes: `HfCandidate` from `src/hf/discovery.ts` (fields: `repoId`, `author`, `url`, `parameterSizeB`, `availableQuants`, `signals`).
- Produces: `hfCandidatesToModelInfo(candidates: HfCandidate[], toName: (c: HfCandidate) => string): ModelInfo[]` — later tasks call this from both backends.

- [ ] **Step 1: Write the failing test**

Create `test/hf-model-info.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { hfCandidatesToModelInfo } from '../src/hf/model-info.js';
import { mapHitToCandidate, type HfModelHit } from '../src/hf/discovery.js';

function loadHits(): HfModelHit[] {
  return JSON.parse(
    readFileSync(new URL('./fixtures/hf-models-search.json', import.meta.url), 'utf-8')
  );
}

describe('hfCandidatesToModelInfo', () => {
  const candidates = loadHits().map(mapHitToCandidate);

  it('maps candidates through the caller-supplied name shape', () => {
    const rows = hfCandidatesToModelInfo(candidates, (c) => `hf.co/${c.repoId}`);
    expect(rows[0].name).toBe(`hf.co/${candidates[0].repoId}`);
    expect(rows[0].source).toBe('remote');
    expect(rows[0].url).toBe(candidates[0].url);
    expect(rows[0].author).toBe(candidates[0].author);
    expect(rows[0].availableQuants).toEqual(candidates[0].availableQuants);
    expect(rows[0].signals).toEqual(candidates[0].signals);
  });

  it('never assigns a per-repo quantization or disk size', () => {
    const rows = hfCandidatesToModelInfo(candidates, (c) => c.repoId);
    expect(rows.every((r) => r.quantizationLevel === null)).toBe(true);
    expect(rows.every((r) => r.diskSizeBytes === null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/hf-model-info.test.ts`
Expected: FAIL — cannot resolve `../src/hf/model-info.js`.

- [ ] **Step 3: Create the shared mapper**

Create `src/hf/model-info.ts`. This is llama-server's existing `mapCandidatesToModelInfo` (in `src/backends/llama-server/index.ts` around line 128) with the name computation parameterized — copy its comment along:

```ts
import type { ModelInfo } from '../types.js';
import type { HfCandidate } from './discovery.js';

/** Shared HF candidate → ModelInfo mapping. Per the remote-candidates spec,
 * only the pull-name shape is per-backend: llama-server uses the bare repoId,
 * ollama uses `hf.co/<repoId>`. */
export function hfCandidatesToModelInfo(
  candidates: HfCandidate[],
  toName: (c: HfCandidate) => string
): ModelInfo[] {
  return candidates.map((c) => ({
    name: toName(c),
    source: 'remote',
    url: c.url,
    parameterSizeB: c.parameterSizeB,
    // Repos ship many quants; no single quant describes the repo. The
    // estimator's fallback covers the estimate, availableQuants covers pulling.
    quantizationLevel: null,
    diskSizeBytes: null,
    author: c.author,
    availableQuants: c.availableQuants,
    signals: c.signals,
  }));
}
```

- [ ] **Step 4: Point llama-server at it**

In `src/backends/llama-server/index.ts`:
- Add `import { hfCandidatesToModelInfo } from '../../hf/model-info.js';`
- Delete the local `mapCandidatesToModelInfo` function (and the now-unused `HfCandidate` type import if nothing else uses it).
- In `remoteCandidates`, replace `mapCandidatesToModelInfo(...)` with `hfCandidatesToModelInfo(await searchGgufModels(...), (c) => c.repoId)`.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass — this task changes no behavior.

- [ ] **Step 6: Commit**

```bash
git add src/hf/model-info.ts test/hf-model-info.test.ts src/backends/llama-server/index.ts
git commit -m "refactor: extract shared HF candidate mapper (hf-shared-mapper)"
```

---

### Task: remote-discovery-flip

The interface migration: `remoteCandidates` returns `RemoteDiscovery` everywhere, `discoverySource` lands on rows, per-backend query defaults move out of cli.ts, and check.ts consumes source reports. Both backends stay single-source in this task (ollama scrape-only; the HF source arrives in `ollama-hf-source`). TypeScript forces this to be one atomic task; the steps keep it reviewable.

**Files:**
- Modify: `src/backends/types.ts` (new types, changed signature)
- Modify: `src/types.ts` (`ModelInfo.discoverySource`)
- Modify: `src/hf/model-info.ts` (mapper stamps `discoverySource: 'huggingface'`)
- Modify: `src/backends/llama-server/index.ts` (wrap in `RemoteDiscovery`, error capture)
- Modify: `src/backends/ollama/index.ts` (wrap scrape in `RemoteDiscovery`, own the `'mlx'` default)
- Modify: `src/check.ts` (consume `RemoteDiscovery`, per-source gaps, `remoteSources` on result, `discoverySource` passthrough, `query` may be undefined)
- Modify: `src/cli.ts` (drop the per-backend query conditional)
- Modify: `test/helpers/fixture-backend.ts`, `test/check.test.ts`, `test/cli.test.ts`, `test/llama-server-backend.test.ts`, `test/ollama-backend.test.ts`
- Modify (snapshot refresh): `test/fixtures/guardrail-check.json`

**Interfaces:**
- Consumes: `hfCandidatesToModelInfo(candidates, toName)` from `hf-shared-mapper`; existing `scrapeSearch`, `mapCandidates`, `searchGgufModels`.
- Produces: the shapes every later task relies on:

```ts
// src/backends/types.ts
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

// Backend interface — signature change:
remoteCandidates?(query?: string, opts?: RemoteCandidateOptions): Promise<RemoteDiscovery>;
```

`CheckResult` gains `remoteSources: RemoteSourceReport[]`; `ModelInfo` and `CheckRow` gain `discoverySource?: string`; `runCheck(query: string | undefined, deps)` accepts undefined.

- [ ] **Step 1: Add the types**

In `src/backends/types.ts`, add `RemoteSourceReport` and `RemoteDiscovery` (exact shapes above, with the comments) above the `Backend` interface, and change the `remoteCandidates` signature to return `Promise<RemoteDiscovery>`. Extend its doc comment: source-level failures must be reported via `sources[].ok === false`, never thrown — a throw from `remoteCandidates` is a bug.

In `src/types.ts`, extend the existing "Remote-discovery metadata" optional block on `ModelInfo` with:

```ts
  /** Which discovery source produced this row ('ollama.com', 'huggingface'). */
  discoverySource?: string;
```

- [ ] **Step 2: Stamp discoverySource in the mappers**

- `src/hf/model-info.ts`: add `discoverySource: 'huggingface',` to the returned object (after `signals`).
- `src/backends/ollama/index.ts` `mapCandidates`: add `discoverySource: 'ollama.com',` to the returned object.

- [ ] **Step 3: Flip llama-server**

In `src/backends/llama-server/index.ts` (import `RemoteDiscovery` from `../types.js`):

```ts
async function remoteCandidates(
  query = '',
  opts: RemoteCandidateOptions = {}
): Promise<RemoteDiscovery> {
  try {
    const candidates = await searchGgufModels(query, {
      maxParameterSizeB: opts.maxParameterSizeB,
    });
    return {
      candidates: hfCandidatesToModelInfo(candidates, (c) => c.repoId),
      sources: [{ id: 'huggingface', query, ok: true }],
    };
  } catch (err) {
    return {
      candidates: [],
      sources: [{ id: 'huggingface', query, ok: false, error: (err as Error).message }],
    };
  }
}
```

- [ ] **Step 4: Flip ollama (still scrape-only)**

In `src/backends/ollama/index.ts` (import `RemoteCandidateOptions`, `RemoteDiscovery` from `../types.js`):

```ts
/** ollama.com's historical search default, applied when the user gave no query.
 * The HF source (ollama-hf-source task) defaults to '' — bare trending. */
const SCRAPE_DEFAULT_QUERY = 'mlx';

async function remoteCandidates(
  query?: string,
  _opts: RemoteCandidateOptions = {}
): Promise<RemoteDiscovery> {
  const scrapeQuery = query ?? SCRAPE_DEFAULT_QUERY;
  try {
    const candidates = mapCandidates(await scrapeSearch(scrapeQuery));
    return { candidates, sources: [{ id: 'ollama.com', query: scrapeQuery, ok: true }] };
  } catch (err) {
    return {
      candidates: [],
      sources: [{ id: 'ollama.com', query: scrapeQuery, ok: false, error: (err as Error).message }],
    };
  }
}
```

- [ ] **Step 5: Consume RemoteDiscovery in check.ts**

In `src/check.ts`:
- Import `RemoteSourceReport` from `./backends/types.js`.
- `CheckRow`: add `discoverySource?: string;` after `signals`.
- `CheckResult`: add `remoteSources: RemoteSourceReport[];` after `scrapeWarning`.
- `runCheck` signature: `export async function runCheck(query: string | undefined, deps: CheckDeps)`.
- Replace the fetch block (currently lines ~74–91) with:

```ts
  let remoteCandidates: ModelInfo[] = [];
  let remoteSources: RemoteSourceReport[] = [];
  let scrapeWarning: string | null = null;
  try {
    const discovery = await backend.remoteCandidates?.(query, {
      // Baseline headroom, not current: discovery shows what the machine can
      // run, not what this moment's memory pressure allows.
      maxParameterSizeB: maxCandidateParamsB(baselineHeadroomGb),
    });
    if (discovery) {
      remoteCandidates = discovery.candidates;
      remoteSources = discovery.sources;
    }
  } catch (err) {
    // Backstop only: backends report source failures via sources[].ok, so a
    // throw landing here is a backend bug — treated as every source failing.
    const message = (err as Error).message;
    scrapeWarning = `Could not fetch remote model list: ${message}`;
    gaps.add({
      kind: 'scrape-failed',
      summary: 'remote model search failed',
      evidence: { backend: backend.id, query, error: message },
    });
  }
  const failedSources = remoteSources.filter((s) => !s.ok);
  for (const s of failedSources) {
    // Per-source summary keeps GapCollector's kind+summary dedup from
    // collapsing two different failed sources into one gap.
    gaps.add({
      kind: 'scrape-failed',
      summary: `remote source ${s.id} failed`,
      evidence: { backend: backend.id, source: s.id, query: s.query, error: s.error },
    });
  }
  if (failedSources.length > 0) {
    scrapeWarning = failedSources
      .map((s) => `Could not fetch remote candidates from ${s.id}: ${s.error}`)
      .join('; ');
  }
```

- In the `remoteRows` mapping, add `...(c.discoverySource !== undefined ? { discoverySource: c.discoverySource } : {}),` alongside the existing author/availableQuants/signals spreads.
- In the returned object, add `remoteSources,` after `scrapeWarning`.

- [ ] **Step 6: Drop the cli.ts conditional**

In `src/cli.ts` (~line 336), replace:

```ts
      // 'mlx' is the historical ollama.com search default; HF-backed backends get
      // bare trending. An explicit --query overrides both.
      const query = opts.query ?? (backend.id === 'ollama' ? 'mlx' : '');
```

with:

```ts
      // Query defaults are per-source and live in the backends; undefined
      // means "no query given — apply yours". sources[] reports what ran.
      const query = opts.query;
```

- [ ] **Step 7: Update the fixture helper**

In `test/helpers/fixture-backend.ts`, replace the `remoteCandidates` member:

```ts
    remoteCandidates: async (query?: string) => ({
      candidates: mapCandidates(parseSearchResults(loadTextFixture('ollama-search-mlx.html'))),
      sources: [{ id: 'ollama.com', query: query ?? 'mlx', ok: true }],
    }),
```

- [ ] **Step 8: Update existing tests to the new shape**

Mechanical updates — every test-local `remoteCandidates` override now returns `RemoteDiscovery`:
- `test/check.test.ts`: `async () => []` becomes `async () => ({ candidates: [], sources: [] })`; `async () => remote` becomes `async () => ({ candidates: remote, sources: [{ id: 'huggingface', query: '', ok: true }] })`. The two throw-based tests (`scrapeWarning` at ~line 74, `scrape-failed gap` at ~line 198) keep throwing — they now document the backstop path; keep their assertions unchanged.
- `test/cli.test.ts`: same `{ candidates: [], sources: [] }` conversion for overrides at ~lines 190, 215. Rewrite the `per-backend query default` describe (~line 360): the CLI no longer applies defaults, it passes the flag through. Replace the two `it`s with:

```ts
  it('passes undefined through when --query is not given (defaults are per-source, in the backend)', async () => {
    const { seen, h } = setup();

    await runCheckCommand({ color: false }, h.deps);

    expect(seen).toContainEqual(['ollama', undefined]);
    expect(seen).toContainEqual(['llama-server', undefined]);
  });

  it('an explicit --query reaches every backend verbatim', async () => {
    const { seen, h } = setup();

    await runCheckCommand({ query: 'qwen', color: false }, h.deps);

    expect(seen).toContainEqual(['ollama', 'qwen']);
    expect(seen).toContainEqual(['llama-server', 'qwen']);
  });
```

  In `setup()`, the overrides become `async (q?: string) => { seen.push(['ollama', q]); return { candidates: [], sources: [] }; }` (and likewise for llama-server). Update the describe's doc comment to say defaults moved into the backends.
- `test/llama-server-backend.test.ts`: wherever `remoteCandidates` results are asserted, reach through `.candidates`; add assertions that `sources` is `[{ id: 'huggingface', query: <expected>, ok: true }]` on success, and that a stubbed fetch failure yields `ok: false` with an `error` string and `candidates: []` instead of a throw.
- `test/ollama-backend.test.ts`: add a fetch-stub branch for `ollama.com/search` returning the `ollama-search-mlx.html` fixture text, then:

```ts
  it('remoteCandidates defaults the scrape query to mlx and reports the source', async () => {
    const discovery = await ollamaBackend.remoteCandidates!();
    expect(discovery.sources).toContainEqual({ id: 'ollama.com', query: 'mlx', ok: true });
    expect(discovery.candidates.length).toBeGreaterThan(0);
    expect(discovery.candidates.every((c) => c.discoverySource === 'ollama.com')).toBe(true);
  });
```

  (The stub can capture the requested URL into a variable and assert it contains `q=mlx`.)

- [ ] **Step 9: Add the new check.ts coverage**

In `test/check.test.ts`, new tests:

```ts
  it('exposes the backend source reports as remoteSources', async () => {
    const sources = [{ id: 'huggingface', query: 'qwen', ok: true }];
    const result = await runCheck(
      'qwen',
      makeDeps({
        backend: fixtureBackend({
          remoteCandidates: async () => ({ candidates: [], sources }),
        }),
      })
    );
    expect(result.remoteSources).toEqual(sources);
  });

  it('a failed source becomes a gap and a warning while surviving rows still render', async () => {
    const gaps = new GapCollector();
    const result = await runCheck(
      '',
      makeDeps({
        gaps,
        backend: fixtureBackend({
          loadedModels: async () => [],
          remoteCandidates: async () => ({
            candidates: [
              {
                name: 'hf.co/ggml-org/some-model-GGUF',
                source: 'remote',
                url: 'https://huggingface.co/ggml-org/some-model-GGUF',
                parameterSizeB: 4,
                quantizationLevel: null,
                diskSizeBytes: null,
                discoverySource: 'huggingface',
              },
            ],
            sources: [
              { id: 'ollama.com', query: 'mlx', ok: false, error: 'network unreachable' },
              { id: 'huggingface', query: '', ok: true },
            ],
          }),
        }),
      })
    );
    expect(result.rows.some((r) => r.name === 'hf.co/ggml-org/some-model-GGUF')).toBe(true);
    expect(result.scrapeWarning).toMatch(/ollama\.com.*network unreachable/);
    const failed = gaps.list().filter((g) => g.kind === 'scrape-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].evidence).toMatchObject({ source: 'ollama.com', error: 'network unreachable' });
  });

  it('remote rows carry their discoverySource through to CheckRow', async () => {
    const result = await runCheck('mlx', makeDeps({}));
    const remote = result.rows.filter((r) => r.source === 'remote');
    expect(remote.length).toBeGreaterThan(0);
    expect(remote.every((r) => r.discoverySource === 'ollama.com')).toBe(true);
  });
```

(Adapt `makeDeps` usage to the file's existing helper shape — it already threads `gaps` and `backend` overrides.)

- [ ] **Step 10: Run the suite, refresh the guardrail JSON snapshot**

Run: `npx vitest run`
Expected: only `test/output-guardrail.test.ts` fails — `guardrail-check.json` now differs by the additive `remoteSources` field and per-row `discoverySource`.

Run: `npx vitest run test/output-guardrail.test.ts -u && git diff test/fixtures/guardrail-check.json`
Verify the diff is *only*: `"discoverySource": "ollama.com"` on remote rows, and a new `"remoteSources": [{ "id": "ollama.com", "query": "mlx", "ok": true }]` field. Any other change means a behavior regression — stop and investigate.

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add -A src test
git commit -m "feat: remoteCandidates returns RemoteDiscovery with per-source reports (remote-discovery-flip)"
```

---

### Task: ollama-hf-source

The feature itself: ollama queries HF alongside the scrape, concurrently, with per-source defaults and independent failure.

**Files:**
- Modify: `src/backends/ollama/index.ts`
- Test: `test/ollama-backend.test.ts`

**Interfaces:**
- Consumes: `searchGgufModels(query, { maxParameterSizeB })` from `src/hf/discovery.ts`; `hfCandidatesToModelInfo(candidates, toName)` from `src/hf/model-info.ts`; `RemoteDiscovery`/`RemoteSourceReport` from `remote-discovery-flip`.
- Produces: ollama rows named `hf.co/<repoId>` with `discoverySource: 'huggingface'`; `sources` always has exactly two entries, `ollama.com` first.

- [ ] **Step 1: Write the failing tests**

In `test/ollama-backend.test.ts`, extend the fetch stub so `huggingface.co/api/models` returns the JSON fixture (load it next to the existing fixtures at the top of the file):

```ts
const hfSearch = readFileSync(new URL('./fixtures/hf-models-search.json', import.meta.url), 'utf-8');
```

and in the stub: `if (url.includes('huggingface.co/api/models')) return new Response(hfSearch, { status: 200 });`. Capture every requested URL into a `fetched: string[]` array (reset in `beforeEach`) so tests can assert query routing.

New tests:

```ts
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
    // Re-stub: HF returns 500, scrape still serves the fixture.
    const { candidates, sources } = await ollamaBackend.remoteCandidates!();
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.discoverySource === 'ollama.com')).toBe(true);
    expect(sources.find((s) => s.id === 'huggingface')).toMatchObject({ ok: false });
    expect(sources.find((s) => s.id === 'huggingface')!.error).toMatch(/500/);
  });

  it('both sources failing returns empty candidates and two failure reports, no throw', async () => {
    // Re-stub: every fetch rejects with ECONNREFUSED.
    const { candidates, sources } = await ollamaBackend.remoteCandidates!();
    expect(candidates).toEqual([]);
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => !s.ok && typeof s.error === 'string')).toBe(true);
  });
});
```

(For the two failure tests, override `globalThis.fetch` inside the `it` — the file already does per-test re-stubbing in its `detect()` tests.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/ollama-backend.test.ts`
Expected: the new describe FAILs — no HF rows, single source report.

- [ ] **Step 3: Implement the two-source remoteCandidates**

In `src/backends/ollama/index.ts`, add imports:

```ts
import { searchGgufModels } from '../../hf/discovery.js';
import { hfCandidatesToModelInfo } from '../../hf/model-info.js';
import type { HfCandidate } from '../../hf/discovery.js';
```

Replace the flip task's scrape-only implementation:

```ts
/** ollama.com's historical search default, applied when the user gave no query.
 * The HF source defaults to '' — bare trending, matching llama-server. */
const SCRAPE_DEFAULT_QUERY = 'mlx';

/** ollama pulls HF repos as `ollama pull hf.co/<owner>/<repo>[:<quant>]`; the
 * quant tag is the caller's pick from availableQuants. */
function hfPullName(c: HfCandidate): string {
  return `hf.co/${c.repoId}`;
}

async function remoteCandidates(
  query?: string,
  opts: RemoteCandidateOptions = {}
): Promise<RemoteDiscovery> {
  const scrapeQuery = query ?? SCRAPE_DEFAULT_QUERY;
  const hfQuery = query ?? '';
  // allSettled: the sources fail independently — one being down must not
  // blank the other's rows.
  const [scrapeResult, hfResult] = await Promise.allSettled([
    scrapeSearch(scrapeQuery),
    // The scrape can't size-filter server-side (oversized rows still get
    // informative "won't fit" verdicts); HF can, so only it takes the cap.
    searchGgufModels(hfQuery, { maxParameterSizeB: opts.maxParameterSizeB }),
  ]);

  const candidates: ModelInfo[] = [];
  const sources: RemoteSourceReport[] = [];

  if (scrapeResult.status === 'fulfilled') {
    candidates.push(...mapCandidates(scrapeResult.value));
    sources.push({ id: 'ollama.com', query: scrapeQuery, ok: true });
  } else {
    sources.push({
      id: 'ollama.com',
      query: scrapeQuery,
      ok: false,
      error: (scrapeResult.reason as Error).message,
    });
  }

  if (hfResult.status === 'fulfilled') {
    candidates.push(...hfCandidatesToModelInfo(hfResult.value, hfPullName));
    sources.push({ id: 'huggingface', query: hfQuery, ok: true });
  } else {
    sources.push({
      id: 'huggingface',
      query: hfQuery,
      ok: false,
      error: (hfResult.reason as Error).message,
    });
  }

  return { candidates, sources };
}
```

(Import `RemoteSourceReport` alongside `RemoteDiscovery`; `ModelInfo` is already imported.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/ollama-backend.test.ts`
Expected: PASS, including the flip task's scrape-default test (its `sources` assertion used `toContainEqual`, still satisfied with two entries).

- [ ] **Step 5: Full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass. `check.test.ts`'s fixture-backend-based tests are unaffected — the helper stubs `remoteCandidates` wholesale, so no real HF calls happen.

- [ ] **Step 6: Commit**

```bash
git add src/backends/ollama/index.ts test/ollama-backend.test.ts
git commit -m "feat: HF Hub as second discovery source for ollama (ollama-hf-source)"
```

---

### Task: remote-sources-footer

Human-facing rendering: a footer line saying what each source searched and whether it failed.

**Files:**
- Modify: `src/format.ts`
- Test: `test/format.test.ts`
- Modify (snapshot refresh): `test/fixtures/guardrail-check-table.txt`

**Interfaces:**
- Consumes: `CheckResult.remoteSources` from `remote-discovery-flip`.
- Produces: exact footer strings (asserted by tests):
  - ok with query: `ollama.com search "mlx"`
  - ok without query: `huggingface (default list)`
  - failed: `huggingface failed: <error>`
  - joined with ` · ` after the `Remote sources: ` label; whole line dimmed; omitted when `remoteSources` is empty.

- [ ] **Step 1: Write the failing tests**

In `test/format.test.ts` (the file's `sampleResult` needs `remoteSources: []` added to keep compiling — do that first, in the same shape as its other fields):

```ts
describe('remote sources footer', () => {
  it('names each source with the query it ran', () => {
    const result: CheckResult = {
      ...sampleResult,
      remoteSources: [
        { id: 'ollama.com', query: 'mlx', ok: true },
        { id: 'huggingface', query: '', ok: true },
      ],
    };
    const out = formatCheckTable(result);
    expect(out).toContain('Remote sources: ollama.com search "mlx" · huggingface (default list)');
  });

  it('marks a failed source inline', () => {
    const result: CheckResult = {
      ...sampleResult,
      remoteSources: [
        { id: 'ollama.com', query: 'mlx', ok: true },
        { id: 'huggingface', query: '', ok: false, error: 'HTTP 429' },
      ],
    };
    expect(formatCheckTable(result)).toContain('huggingface failed: HTTP 429');
  });

  it('omits the line when there are no source reports', () => {
    expect(formatCheckTable({ ...sampleResult, remoteSources: [] })).not.toContain('Remote sources:');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/format.test.ts`
Expected: the new describe FAILs (missing footer). If the file fails to compile before that, `remoteSources: []` is missing from `sampleResult` — that's Step 1's first edit.

- [ ] **Step 3: Render the footer**

In `src/format.ts` `formatCheckTable`, after the remote-links block and before the `remoteGuidance` block:

```ts
  if (result.remoteSources.length > 0) {
    const parts = result.remoteSources.map((s) => {
      if (!s.ok) return `${s.id} failed: ${s.error}`;
      return s.query.length > 0 ? `${s.id} search "${s.query}"` : `${s.id} (default list)`;
    });
    lines.push('', dim(`Remote sources: ${parts.join(' · ')}`, color));
  }
```

- [ ] **Step 4: Run tests, refresh the guardrail table snapshot**

Run: `npx vitest run test/format.test.ts`
Expected: PASS.

Run: `npx vitest run test/output-guardrail.test.ts`
Expected: FAIL — the table snapshot lacks the footer.

Run: `npx vitest run test/output-guardrail.test.ts -u && git diff test/fixtures/guardrail-check-table.txt`
Verify the diff is only the added `Remote sources: ollama.com search "mlx"` line (fixture backend reports one ok source). Anything else is a regression — stop and investigate.

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/format.ts test/format.test.ts test/fixtures/guardrail-check-table.txt
git commit -m "feat: remote sources footer in check table (remote-sources-footer)"
```

---

### Task: docs-and-live-verify

Bring the docs in line with the new contract, then verify against the real ollama.com and HF before merge.

**Files:**
- Modify: `README.md` (line ~10)
- Modify: `docs/adapters.md` (signature at ~228, opts note at ~240, no-remoteCandidates fallback at ~266, ollama reference section at ~271, llama-server section at ~341)

**Interfaces:**
- Consumes: everything shipped by the earlier tasks; no code changes here.

- [ ] **Step 1: Update README**

Line ~10 currently says discovery is "a live scrape of `ollama.com/search`". Reword to cover both sources, e.g.: "locally-pulled models plus remote candidates from `ollama.com/search` and Hugging Face Hub (pullable as `hf.co/<owner>/<repo>:<quant>`), estimates …". Check line ~107's flaky-scrape sentence still reads correctly (it does — one source failing is still just a warning — but confirm the wording doesn't imply scrape is the only source).

- [ ] **Step 2: Update docs/adapters.md**

- ~228: signature becomes `remoteCandidates?(query?: string, opts?: RemoteCandidateOptions): Promise<RemoteDiscovery>;` — add `RemoteSourceReport`/`RemoteDiscovery` to the shown types with a sentence: source failures are `ok: false` reports, never throws; `query === undefined` means "apply your per-source defaults".
- ~240: keep the size-filter note; add that backends with multiple sources apply it only where the source supports it (ollama: HF yes, scrape no).
- ~266: the fallback snippet `(await backend.remoteCandidates?.(query)) ?? []` no longer matches check.ts — update it to the discovery-object shape.
- ~271 (ollama reference section): document the two sources, per-source defaults (`'mlx'` scrape / `''` HF), `hf.co/<repoId>` pull names, `Promise.allSettled` independence.
- ~341 (llama-server section): note the mapper now lives in `src/hf/model-info.ts`, shared with ollama.

- [ ] **Step 3: Full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass (docs-only task; this catches accidental code edits).

- [ ] **Step 4: Live verification**

Requires a running ollama (`ollama serve`, default port 11434) and network access to ollama.com + huggingface.co. Run each and eyeball:

```bash
npx tsx src/cli.ts check --backend ollama
```
Expected: remote rows from both sources (library names *and* `hf.co/...` names), quant lists on the HF link lines, the unvetted-candidates guidance line, and the footer `Remote sources: ollama.com search "mlx" · huggingface (default list)`.

```bash
npx tsx src/cli.ts check --backend ollama --query qwen
```
Expected: footer shows `search "qwen"` for both sources; rows match the query.

```bash
npx tsx src/cli.ts check --backend ollama --json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['remoteSources']); print([r['name'] for r in d['rows'] if r.get('discoverySource')=='huggingface'][:3])"
```
Expected: two source reports; `hf.co/<owner>/<repo>` names.

Optional end-to-end pull sanity (network-heavy, skippable): `ollama pull hf.co/<one of the listed repos>:<a small quant from its list>` completes.

Also verify llama-server didn't regress if the test router is up: `npx tsx src/cli.ts check --backend llama-server` shows the huggingface source in the footer.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/adapters.md
git commit -m "docs: two-source ollama discovery and RemoteDiscovery contract (docs-and-live-verify)"
```
