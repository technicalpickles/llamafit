# Remote Discovery Fast-Follows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the `RemoteSourceReport`/`GapCollector`/conformance surface shipped in the ollama-HF second-source work with four small, independent fixes (taskwarrior `353`-`356`).

**Architecture:** `RemoteSourceReport` becomes a discriminated union with a `isFailedSource` type guard so `ok:false ⟹ error` is compiler-enforced; three call sites that filtered on `!s.ok` switch to the guard. `GapCollector`'s `kind+summary` dedup starts including `backend.id` in the summary text so the same failing source across two backends produces two gaps, not one. `test/conformance/backend.ts` gains a case asserting `remoteCandidates()` never throws and resolves `{candidates, sources}` as arrays. `docs/adapters.md` gets a one-line fixture-consumer correction.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest 2. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-08-remote-discovery-fast-follows-design.md` — read it first.

## Global Constraints

- Task headers are kebab-case slugs; commits reference the slug, e.g. `refactor: RemoteSourceReport discriminated union (remote-source-discriminated-union)`.
- Source ids stay exactly `'ollama.com'` and `'huggingface'` (unchanged by this plan).
- No behavior change to `RemoteDiscovery`, `ModelInfo`, or the check-table footer — this plan is type-safety and test-coverage hardening only (spec non-goals).
- `scrape-failed` gap kind and `scrapeWarning` field keep their names (only the *summary text* changes, not the kind).
- Run tests with `npx vitest run` (single file: `npx vitest run test/<file>.test.ts`); typecheck with `npx tsc --noEmit`.
- This plan uses direct/inline execution (lightweight process, no worktree isolation, no multi-agent task fan-out) — the user explicitly opted out of the heavier process used for the original feature.

---

### Task: remote-source-discriminated-union

Make `RemoteSourceReport`'s `ok:false ⟹ error` invariant compiler-enforced, and fix every call site that breaks under the stricter type.

**Files:**
- Modify: `src/backends/types.ts:14-19` (the `RemoteSourceReport` interface)
- Modify: `src/check.ts:1` (import), `src/check.ts:100-108` (`failedSources` filter + loop)
- Modify: `test/ollama-backend.test.ts:1-5` (import), `test/ollama-backend.test.ts:160-161` (failed-source assertion)
- Modify: `test/llama-server-backend.test.ts:1-10` (import — check current imports), `test/llama-server-backend.test.ts:254-260` (failed-source assertion)
- Test: `npx tsc --noEmit` is the primary check for this task (a type change, not new runtime behavior) plus the existing suites in the modified files

**Interfaces:**
- Produces: `RemoteSourceReport` (discriminated union, same field names as before: `id`, `query`, `ok`, `error`) and `isFailedSource(s: RemoteSourceReport): s is Extract<RemoteSourceReport, { ok: false }>`, both exported from `src/backends/types.ts`. Later tasks and existing call sites import `isFailedSource` from `'./backends/types.js'` (or `'../src/backends/types.js'` from `test/`).

- [ ] **Step 1: Change the type in `src/backends/types.ts`**

Replace:

```ts
export interface RemoteSourceReport {
  id: string; // 'ollama.com' | 'huggingface'
  query: string; // the query actually sent to this source
  ok: boolean;
  error?: string; // present when ok is false
}
```

with:

```ts
export type RemoteSourceReport =
  | { id: string; query: string; ok: true } // 'ollama.com' | 'huggingface'
  | { id: string; query: string; ok: false; error: string };

export function isFailedSource(
  s: RemoteSourceReport
): s is Extract<RemoteSourceReport, { ok: false }> {
  return !s.ok;
}
```

- [ ] **Step 2: Run the typecheck to see the breakage**

Run: `npx tsc --noEmit`
Expected: FAIL, with errors at `src/check.ts` (property `error` does not exist on the narrowed-away branch) and the two backend test files.

- [ ] **Step 3: Fix `src/check.ts`**

Change the import on line 1:

```ts
import type { Backend, RemoteSourceReport } from './backends/types.js';
```

to:

```ts
import { isFailedSource } from './backends/types.js';
import type { Backend, RemoteSourceReport } from './backends/types.js';
```

Change the filter on line 100 from:

```ts
const failedSources = remoteSources.filter((s) => !s.ok);
```

to:

```ts
const failedSources = remoteSources.filter(isFailedSource);
```

The loop body (lines 101-109) and the `.map((s) => ...)` on lines 111-113 are unchanged — `failedSources` is now correctly typed as the `ok:false` variant, so `s.error` on both already typechecks.

- [ ] **Step 4: Fix `test/ollama-backend.test.ts`**

Add to the imports at the top of the file:

```ts
import { isFailedSource } from '../src/backends/types.js';
```

Replace lines 160-161:

```ts
    expect(sources.find((s) => s.id === 'huggingface')).toMatchObject({ ok: false });
    expect(sources.find((s) => s.id === 'huggingface')!.error).toMatch(/500/);
```

with:

```ts
    const hfSource = sources.find(isFailedSource);
    expect(hfSource).toMatchObject({ id: 'huggingface', ok: false });
    expect(hfSource!.error).toMatch(/500/);
```

(Only the HF source fails in this test — the ollama.com scrape succeeds — so `sources.find(isFailedSource)` unambiguously finds it.)

- [ ] **Step 5: Fix `test/llama-server-backend.test.ts`**

Add this import after the existing `import { hfCandidatesToModelInfo } from '../src/hf/model-info.js';` line near the top of the file (line 10):

```ts
import { isFailedSource } from '../src/backends/types.js';
```

Replace lines 257-260:

```ts
    expect(discovery.candidates).toEqual([]);
    expect(discovery.sources).toHaveLength(1);
    expect(discovery.sources[0].ok).toBe(false);
    expect(discovery.sources[0].error).toEqual(expect.any(String));
```

with:

```ts
    expect(discovery.candidates).toEqual([]);
    expect(discovery.sources).toHaveLength(1);
    const [source] = discovery.sources;
    if (!isFailedSource(source)) throw new Error('expected a failed source');
    expect(source.error).toEqual(expect.any(String));
```

- [ ] **Step 6: Run the typecheck again**

Run: `npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 7: Run the affected test suites**

Run: `npx vitest run test/check.test.ts test/ollama-backend.test.ts test/llama-server-backend.test.ts`
Expected: PASS, same test counts as before this task (no test was added or removed, only rewritten).

- [ ] **Step 8: Commit**

```bash
git add src/backends/types.ts src/check.ts test/ollama-backend.test.ts test/llama-server-backend.test.ts
git commit -m "refactor: RemoteSourceReport discriminated union (remote-source-discriminated-union)"
```

---

### Task: gap-summary-backend-id

Fold `backend.id` into the `scrape-failed` gap summary text so `GapCollector`'s `kind+summary` dedup doesn't collapse the same failing source across two different backends.

**Files:**
- Modify: `src/check.ts:94-108` (both `gaps.add` calls in `runCheck`)
- Test: `test/check.test.ts`

**Interfaces:**
- Consumes: `isFailedSource` from Task `remote-source-discriminated-union` (already imported in `src/check.ts` from that task).
- No new exports — internal summary-string change only.

- [ ] **Step 1: Write the failing test**

Add to `test/check.test.ts`, inside (or right after) the `describe('runCheck', ...)` block that contains the existing `'records a scrape-failed gap and still returns local rows'` test (around line 234):

```ts
  it('does not collapse the same failed source across two different backends', async () => {
    const gaps = new GapCollector();
    const failingDiscovery = async () => ({
      candidates: [],
      sources: [{ id: 'huggingface', query: 'mlx', ok: false, error: 'network unreachable' } as const],
    });

    await runCheck(
      'mlx',
      makeDeps({
        gaps,
        backend: fixtureBackend({
          id: 'ollama',
          loadedModels: async () => [],
          remoteCandidates: failingDiscovery,
        }),
      })
    );
    await runCheck(
      'mlx',
      makeDeps({
        gaps,
        backend: fixtureBackend({
          id: 'llama-server',
          loadedModels: async () => [],
          remoteCandidates: failingDiscovery,
        }),
      })
    );

    const scrapeFailed = gaps.list().filter((g) => g.kind === 'scrape-failed');
    expect(scrapeFailed).toHaveLength(2);
    expect(scrapeFailed.map((g) => g.summary)).toEqual([
      'remote source huggingface failed for backend ollama',
      'remote source huggingface failed for backend llama-server',
    ]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/check.test.ts -t "does not collapse"`
Expected: FAIL — only 1 gap in the list (current summary text is identical for both calls, so the second `gaps.add` is deduped away).

- [ ] **Step 3: Update the summary strings in `src/check.ts`**

Change line 96 from:

```ts
      summary: 'remote model search failed',
```

to:

```ts
      summary: `remote model search failed for backend ${backend.id}`,
```

Change line 106 from:

```ts
      summary: `remote source ${s.id} failed`,
```

to:

```ts
      summary: `remote source ${s.id} failed for backend ${backend.id}`,
```

- [ ] **Step 4: Run the test again to verify it passes**

Run: `npx vitest run test/check.test.ts -t "does not collapse"`
Expected: PASS.

- [ ] **Step 5: Run the full check.test.ts suite**

Run: `npx vitest run test/check.test.ts`
Expected: PASS. In particular, re-check the existing `'records a scrape-failed gap and still returns local rows'` test (asserts `scrapeFailed[0].evidence` — unaffected, since evidence still carries the plain `error`/`query`/`source` fields) and the `describe('remote discovery reporting', ...)` block's gap assertions around line 377 — those only assert on `evidence` and `kind`, not `summary`, so this change should not break them. If either asserts on the literal summary string, update it to match the new `for backend ${backend.id}` suffix.

- [ ] **Step 6: Commit**

```bash
git add src/check.ts test/check.test.ts
git commit -m "fix: fold backend id into scrape-failed gap summaries (gap-summary-backend-id)"
```

---

### Task: remote-candidates-conformance

Add a `describeBackendConformance` case asserting `remoteCandidates()`, when present, never rejects and resolves `{candidates, sources}` as arrays.

**Files:**
- Modify: `test/conformance/backend.ts`
- Test: `test/ollama-backend.test.ts`, `test/llama-server-backend.test.ts` (both already call `describeBackendConformance`, so this task's new case runs there automatically — no changes needed in either file)

**Interfaces:**
- Consumes: `Backend.remoteCandidates` from `src/backends/types.ts` (unchanged signature).
- No new exports.

- [ ] **Step 1: Write the failing test**

Add a new `it` block inside the existing `describe(\`Backend conformance: ${label}\`, ...)` in `test/conformance/backend.ts`, after the `'every declared optional capability is a function'` case:

```ts
    it('remoteCandidates(), if present, never rejects and resolves {candidates, sources}', async () => {
      const backend = await setup();
      if (!backend.remoteCandidates) return;
      const discovery = await backend.remoteCandidates();
      expect(Array.isArray(discovery.candidates)).toBe(true);
      expect(Array.isArray(discovery.sources)).toBe(true);
    });
```

- [ ] **Step 2: Run it to verify it fails (or trivially passes) for the right reason**

Run: `npx vitest run test/ollama-backend.test.ts test/llama-server-backend.test.ts -t "remoteCandidates(), if present"`
Expected: PASS immediately — both current backends already satisfy this contract (this is guardrail coverage against future regressions, not a bug fix). Confirm the test actually ran (2 passes, one per backend) rather than being skipped, by checking the reporter output names both `Backend conformance: ollama` and `Backend conformance: llama-server`.

- [ ] **Step 3: Run the full suite to confirm no regressions**

Run: `npx vitest run`
Expected: PASS, all suites green.

- [ ] **Step 4: Commit**

```bash
git add test/conformance/backend.ts
git commit -m "test: conformance case for remoteCandidates() contract (remote-candidates-conformance)"
```

---

### Task: adapters-doc-fixture-note

Add `test/hf-discovery.test.ts` to the list of `hf-models-search.json` consumers in `docs/adapters.md`.

**Files:**
- Modify: `docs/adapters.md` (Fixture conventions section, ~line 348-352)

**Interfaces:**
- None — documentation only.

- [ ] **Step 1: Update the fixture-consumer list**

In `docs/adapters.md`, find:

```
`hf-models-search.json` is a captured
Hugging Face Hub search response, shared across every HF-consuming backend:
`test/hf-model-info.test.ts`, `test/llama-server-backend.test.ts`, and
`test/ollama-backend.test.ts` all load it directly rather than each keeping
their own copy.
```

Replace with:

```
`hf-models-search.json` is a captured
Hugging Face Hub search response, shared across every HF-consuming backend:
`test/hf-model-info.test.ts`, `test/hf-discovery.test.ts`,
`test/llama-server-backend.test.ts`, and `test/ollama-backend.test.ts` all
load it directly rather than each keeping their own copy.
```

- [ ] **Step 2: Verify the claim**

Run: `grep -l "hf-models-search.json" test/*.ts`
Expected: exactly the four files now named in the doc (`test/hf-model-info.test.ts`, `test/hf-discovery.test.ts`, `test/llama-server-backend.test.ts`, `test/ollama-backend.test.ts`).

- [ ] **Step 3: Commit**

```bash
git add docs/adapters.md
git commit -m "docs: add hf-discovery.test.ts to fixture consumer list (adapters-doc-fixture-note)"
```

---

## Final Verification

- [ ] **Run the full test suite:** `npx vitest run` — expect the same pass count as before this plan plus the one new conformance case per backend and the one new gap-collision test.
- [ ] **Run the full typecheck:** `npx tsc --noEmit` — expect no errors.
- [ ] **Push and open a PR** (single PR covering all four tasks — see `git:pull-request` skill for PR body conventions).
