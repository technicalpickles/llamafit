# check Output Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut `llamafit check` from 80 lines of stdout to ~20 by fixing the data feeding it, then rendering ranked, capped sections instead of one undifferentiated table.

**Architecture:** Seven data-quality fixes land first, each independently testable, in the backend mappers and `check.ts`. Then `CheckRow` gains a derived fit-group key and `CheckResult` gains explicit recommendations, so presentation stops inferring meaning from insertion order. Finally `src/format.ts` splits into three focused modules and the new rendering is built there. Cloud models leave rendered output entirely.

**Tech Stack:** TypeScript (ESM, NodeNext resolution), vitest, commander, cheerio. Node >= 20. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-09-check-output-redesign-design.md` (approved via crit, zero comments)

## Global Constraints

- **TDD, strictly.** Failing test first, watched failing for the right reason, then minimal implementation. Per `CLAUDE.md` and `superpowers:test-driven-development`.
- **Two typecheck configs, both must pass.** `npm run typecheck` (tests, `tsconfig.test.json`) and `npm run build` (src, `tsconfig.json`). A green one does not imply the other.
- **`--json` output is never capped and never reordered by presentation concerns.** Additive fields only; `cloudModels` stays even though nothing renders it.
- **`stdout` stays pipeable.** All warnings, gap reports, and advisory text go to `stderr`.
- **Verdict thresholds, the 8GB reserve, and `overheadMultiplier` are out of scope.** Do not touch `data/thresholds.json` or `data/calibration.json`.
- **Local models are never filtered.** The non-chat filter applies to remote candidates only. A user's own pulled model is theirs to see.
- **Fixtures are real captured data.** Never invent an API response shape; capture it from the live service.
- **Commit after every task.** Conventional-commit prefixes (`fix:`, `feat:`, `refactor:`, `test:`, `docs:`).

---

## File Structure

**Modified:**
- `src/types.ts` — `ModelInfo` gains `digest?`, `alsoTagged?`
- `src/backends/ollama/client.ts` — `normalizeQuant()`, `quantFromTag()`
- `src/backends/ollama/index.ts` — mappers use them; `collapseByDigest()`; delete `SCRAPE_DEFAULT_QUERY`
- `src/hf/model-info.ts` — `pickQuant()`, real quant on candidates
- `src/check.ts` — `fitGroup()`, ranking, filtering, `recommendations`
- `src/cli.ts` — `--local` / `--remote` / `--all`
- `test/fixtures/api-tags.json` — add two real `hf.co/` entries
- `test/helpers/fixture-backend.ts` — drop the `'mlx'` default

**Created:**
- `src/format/table.ts` — ANSI-aware width/padding helpers (pure)
- `src/format/check.ts` — grouping, capping, sections, recommendations rendering
- `src/format/bench.ts` — `formatBenchResult`, `formatPullProgress` (moved unchanged)
- `src/format.ts` — becomes a re-export barrel, so no import site outside `src/format/` changes

**Test files:** `test/ollama-backend.test.ts`, `test/ollama-client.test.ts`, `test/hf-model-info.test.ts`, `test/check.test.ts`, `test/format.test.ts`, `test/cli.test.ts`, `test/output-guardrail.test.ts`, plus new `test/format-table.test.ts`.

---

## Task 1: `quant-sentinel`

Ollama reports a missing quantization two ways: `''` and the literal string `'unknown'`. Only the first is handled, so the second reaches the estimator as a quant name and raises an `unknown-quant` gap whose agent prompt asks for a bytes-per-param value for the concept *unknown*. This is an independent correctness bug and lands as its own commit ahead of the redesign.

**Files:**
- Modify: `test/fixtures/api-tags.json` (add two entries)
- Modify: `src/backends/ollama/client.ts`
- Modify: `src/backends/ollama/index.ts:36-45` (`mapTagsToLocalModels`), `:50-56` (`mapPsToLoaded`)
- Test: `test/ollama-client.test.ts`, `test/ollama-backend.test.ts`, `test/check.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `normalizeQuant(raw: string | undefined | null): string | null` exported from `src/backends/ollama/client.ts`

- [ ] **Step 1: Add the two real `hf.co/` entries to the tags fixture**

These are captured verbatim from this machine's `/api/tags` on 2026-08-09. They carry `quantization_level: "unknown"`, share digest `036489398bf6…`, and their repo id matches an entry in `test/fixtures/hf-models-search.json` — so this one fixture change sets up Tasks 1, 2, 3, and 6.

Insert both objects into the `models` array of `test/fixtures/api-tags.json`, immediately after the `llama3.2:3b` entry:

```json
{
  "name": "hf.co/yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF:Q4_K_M",
  "model": "hf.co/yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF:Q4_K_M",
  "modified_at": "2026-08-08T21:24:53.35962927-04:00",
  "size": 7381382430,
  "digest": "036489398bf6af6874783c754592a90f12a036b20cbbf47a867a3ac938868aff",
  "details": {
    "parent_model": "",
    "format": "gguf",
    "family": "gemma4",
    "families": ["gemma4"],
    "parameter_size": "11.9B",
    "quantization_level": "unknown",
    "context_length": 262144,
    "embedding_length": 3840
  },
  "capabilities": ["completion"]
},
{
  "name": "hf.co/yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF:latest",
  "model": "hf.co/yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF:latest",
  "modified_at": "2026-08-08T21:03:56.149412934-04:00",
  "size": 7381382430,
  "digest": "036489398bf6af6874783c754592a90f12a036b20cbbf47a867a3ac938868aff",
  "details": {
    "parent_model": "",
    "format": "gguf",
    "family": "gemma4",
    "families": ["gemma4"],
    "parameter_size": "11.9B",
    "quantization_level": "unknown",
    "context_length": 262144,
    "embedding_length": 3840
  },
  "capabilities": ["completion"]
},
```

- [ ] **Step 2: Write the failing test for `normalizeQuant`**

Add to `test/ollama-client.test.ts`:

```ts
import { normalizeQuant } from '../src/backends/ollama/client.js';

describe('normalizeQuant', () => {
  it('treats the literal string "unknown" as not-reported', () => {
    expect(normalizeQuant('unknown')).toBeNull();
  });

  it('treats empty and whitespace-only as not-reported', () => {
    expect(normalizeQuant('')).toBeNull();
    expect(normalizeQuant('   ')).toBeNull();
    expect(normalizeQuant(undefined)).toBeNull();
    expect(normalizeQuant(null)).toBeNull();
  });

  it('is case-insensitive about the sentinel', () => {
    expect(normalizeQuant('Unknown')).toBeNull();
    expect(normalizeQuant('UNKNOWN')).toBeNull();
  });

  it('passes a real quantization through untouched, preserving case', () => {
    expect(normalizeQuant('Q4_K_M')).toBe('Q4_K_M');
    expect(normalizeQuant('bf16')).toBe('bf16');
  });

  it('trims surrounding whitespace off a real value', () => {
    expect(normalizeQuant('  Q4_K_M  ')).toBe('Q4_K_M');
  });
});
```

- [ ] **Step 3: Run it and confirm it fails for the right reason**

Run: `npx vitest run test/ollama-client.test.ts -t normalizeQuant`
Expected: FAIL — `normalizeQuant is not a function` / no such export. Not a wrong-value assertion failure.

- [ ] **Step 4: Implement `normalizeQuant`**

Add to `src/backends/ollama/client.ts`, next to `isCloudModel`:

```ts
/** Ollama signals "no quantization reported" two ways: an empty string and the
 * literal string 'unknown'. Both must collapse to null so the row renders `?`
 * and the estimator uses its fallback — treating 'unknown' as a quant *name*
 * raises an unknown-quant gap whose agent prompt asks for a bytes-per-param
 * value for the concept "unknown", which has none. Add to this set if another
 * backend invents its own sentinel ('none', 'N/A'). */
const NOT_REPORTED_QUANTS: ReadonlySet<string> = new Set(['', 'unknown']);

export function normalizeQuant(raw: string | undefined | null): string | null {
  const trimmed = (raw ?? '').trim();
  return NOT_REPORTED_QUANTS.has(trimmed.toLowerCase()) ? null : trimmed;
}
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `npx vitest run test/ollama-client.test.ts -t normalizeQuant`
Expected: PASS

- [ ] **Step 6: Write the failing test that no gap is raised**

This is the behavioural point of the task — the unit test above does not prove the gap stops firing. Add to `test/check.test.ts`:

```ts
it('records no unknown-quant gap for a model whose quant is the string "unknown"', async () => {
  const gaps = new GapCollector();
  await runCheck('mlx', {
    backend: fixtureBackend(),
    probe: fixtureProbe(SYSTEM),
    estimator: formulaEstimator,
    gaps,
  });
  expect(gaps.list().filter((g) => g.kind === 'unknown-quant')).toEqual([]);
});

it('still records unknown-quant for a genuinely unrecognized quantization', async () => {
  const gaps = new GapCollector();
  await runCheck('mlx', {
    backend: fixtureBackend({
      localModels: async () => ({
        models: [
          {
            name: 'weird:latest',
            source: 'local',
            url: null,
            parameterSizeB: 7,
            quantizationLevel: 'Q3_K_XL_TURBO',
            diskSizeBytes: null,
          },
        ],
        skipped: [],
      }),
    }),
    probe: fixtureProbe(SYSTEM),
    estimator: formulaEstimator,
    gaps,
  });
  expect(gaps.list().map((g) => g.kind)).toContain('unknown-quant');
});
```

Reuse whatever `SYSTEM` / import bindings already exist at the top of `test/check.test.ts`; add `GapCollector` and `formulaEstimator` imports only if absent.

- [ ] **Step 7: Run it and confirm the first test fails**

Run: `npx vitest run test/check.test.ts -t unknown-quant`
Expected: the "records no unknown-quant gap" test FAILS with one gap present (the fixture's `'unknown'` entries). The "still records" test should already PASS — that is the guard proving the fix is narrow.

- [ ] **Step 8: Wire `normalizeQuant` into both mappers**

In `src/backends/ollama/index.ts`, import `normalizeQuant` from `./client.js` and use it in `mapTagsToLocalModels`:

```ts
    models.push({
      name: model.name,
      source: 'local',
      url: null,
      parameterSizeB: parseParameterSize(model.details.parameter_size),
      quantizationLevel: normalizeQuant(model.details.quantization_level),
      diskSizeBytes: model.size,
    });
```

and in `mapPsToLoaded`:

```ts
export function mapPsToLoaded(ps: OllamaPsResponse): LoadedModel[] {
  return ps.models.map((model) => ({
    name: model.name,
    sizeVramGb: model.size_vram / 1e9,
    quantizationLevel: normalizeQuant(model.details.quantization_level),
  }));
}
```

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: the two new `check.test.ts` tests PASS. `output-guardrail` snapshots will FAIL — the fixture gained two rows. Do **not** update them yet; Task 3 changes those rows again.

- [ ] **Step 10: Refresh the guardrail snapshots**

Run: `npx vitest run test/output-guardrail.test.ts -u`
Then read the diff and confirm it shows exactly: two new rows with `?` in the QUANT column, and no other change.

Run: `npm test` — expected: all PASS.

- [ ] **Step 11: Typecheck both configs**

Run: `npm run typecheck && npm run build`
Expected: both clean.

- [ ] **Step 12: Commit**

```bash
git add src/backends/ollama/client.ts src/backends/ollama/index.ts \
        test/ollama-client.test.ts test/check.test.ts \
        test/fixtures/api-tags.json test/fixtures/guardrail-check-table.txt \
        test/fixtures/guardrail-check.json
git commit -m "fix: treat Ollama's 'unknown' quantization string as not-reported

Ollama signals a missing quantization two ways: '' and the literal string
'unknown'. Only '' was handled, so 'unknown' reached the estimator as a quant
name and raised an unknown-quant gap. That gap's agent prompt says to add a
bytes-per-param value for it to data/quants.json -- there is no correct value
for the concept 'unknown', so the prompt invited a wrong number into the
estimator.

Verified live: two locally-pulled hf.co models report exactly this string.
Both are now in the tags fixture as real captured data."
```

---

## Task 2: `quant-from-tag`

Ollama pulls HF repos as `hf.co/<owner>/<repo>:<quant>`, so the tag names the quantization the manifest failed to report. Recovering it turns `?` into a real quant for exactly the models Task 1 just made honest.

**Files:**
- Create: `src/model-names.ts`
- Modify: `src/backends/ollama/client.ts`
- Modify: `src/backends/ollama/index.ts` (`mapTagsToLocalModels`)
- Test: `test/model-names.test.ts` (new), `test/ollama-client.test.ts`

**Interfaces:**
- Consumes: `normalizeQuant` (Task 1); `loadQuantTable`, `lookupQuant`, `QuantTable` from `src/data.js`
- Produces:
  - `splitModelTag(name: string): { base: string; tag: string | null }` from `src/model-names.ts` — **Task 6 consumes this too**
  - `quantFromTag(name: string, table: QuantTable): string | null` from `src/backends/ollama/client.ts`

- [ ] **Step 1: Write the failing test for the shared tag splitter**

Both this task (read the tag) and Task 6 (strip the tag) need the same rule about what counts as a tag, so it lives in one place. Create `test/model-names.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { splitModelTag } from '../src/model-names.js';

describe('splitModelTag', () => {
  it('splits a normal tagged name', () => {
    expect(splitModelTag('gemma3:12b')).toEqual({ base: 'gemma3', tag: '12b' });
    expect(splitModelTag('hf.co/o/r:Q4_K_M')).toEqual({ base: 'hf.co/o/r', tag: 'Q4_K_M' });
  });

  it('reports no tag when there is no colon', () => {
    expect(splitModelTag('mistrallite')).toEqual({ base: 'mistrallite', tag: null });
  });

  it('does not treat a colon followed by a path as a tag', () => {
    // A slash after the last colon means we're looking at a path segment.
    expect(splitModelTag('hf.co/owner:weird/repo')).toEqual({
      base: 'hf.co/owner:weird/repo',
      tag: null,
    });
  });

  it('reports no tag for a trailing colon', () => {
    expect(splitModelTag('gemma3:')).toEqual({ base: 'gemma3:', tag: null });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run test/model-names.test.ts`
Expected: FAIL — cannot resolve `../src/model-names.js`.

- [ ] **Step 3: Create `src/model-names.ts`**

```ts
/** Model-name parsing shared across backends. Both Ollama and llama-server name
 * models `<base>:<tag>`, and two callers need the same answer to "is that colon
 * a tag separator?" — one to read the tag (quantFromTag), one to strip it
 * (check.ts's untagged, for local/remote dedup). One rule, one place. */

export function splitModelTag(name: string): { base: string; tag: string | null } {
  const colon = name.lastIndexOf(':');
  if (colon === -1) return { base: name, tag: null };
  const tag = name.slice(colon + 1);
  // Empty means a trailing colon; a slash means we're looking at a path segment.
  if (tag.length === 0 || tag.includes('/')) return { base: name, tag: null };
  return { base: name.slice(0, colon), tag };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/model-names.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test for `quantFromTag`**

Add to `test/ollama-client.test.ts`:

```ts
import { quantFromTag } from '../src/backends/ollama/client.js';
import { loadQuantTable } from '../src/data.js';

describe('quantFromTag', () => {
  const table = loadQuantTable();

  it('reads a known quant off an hf.co tag', () => {
    expect(
      quantFromTag('hf.co/yuxinlu1/gemma-4-12B-agentic-GGUF:Q4_K_M', table)
    ).toBe('Q4_K_M');
  });

  it('resolves an alias to its canonical id', () => {
    expect(quantFromTag('hf.co/o/r:bf16', table)).toBe('F16');
  });

  it('returns null for a tag that is not a quantization', () => {
    expect(quantFromTag('hf.co/o/r:latest', table)).toBeNull();
    expect(quantFromTag('gemma3:12b', table)).toBeNull();
    expect(quantFromTag('cyborgxx101/gemma-4-12b-mlx:4bit', table)).toBeNull();
  });

  it('returns null when there is no tag at all', () => {
    expect(quantFromTag('mistrallite', table)).toBeNull();
  });

  it('ignores a colon that belongs to a namespace rather than a tag', () => {
    // Delegated to splitModelTag; asserted here so the behaviour is pinned at
    // this layer too, not just in the helper's own tests.
    expect(quantFromTag('hf.co/owner:weird/repo', table)).toBeNull();
  });
});
```

`bf16` → `F16` because `data/quants.json` lists `BF16` as an alias of the `F16` entry.

- [ ] **Step 6: Run it and confirm it fails for the right reason**

Run: `npx vitest run test/ollama-client.test.ts -t quantFromTag`
Expected: FAIL — no such export.

- [ ] **Step 7: Implement `quantFromTag`**

Add to `src/backends/ollama/client.ts`:

```ts
/** Ollama pulls HF repos as `hf.co/<owner>/<repo>:<quant>`, so the tag names the
 * quantization when the manifest doesn't report one. Gated on the tag actually
 * matching a known entry or alias, which is what makes it safe to try on every
 * name: `gemma3:12b` and `…-mlx:4bit` simply don't match and fall through. */
export function quantFromTag(name: string, table: QuantTable): string | null {
  const { tag } = splitModelTag(name);
  if (tag === null) return null;
  const { id, known } = lookupQuant(table, tag);
  return known ? id : null;
}
```

Add the imports at the top of `client.ts`:

```ts
import { lookupQuant, type QuantTable } from '../../data.js';
import { splitModelTag } from '../../model-names.js';
```

- [ ] **Step 8: Run it and confirm it passes**

Run: `npx vitest run test/ollama-client.test.ts -t quantFromTag`
Expected: PASS

- [ ] **Step 9: Write the failing integration test**

Add to `test/ollama-backend.test.ts`:

```ts
it('recovers the quantization from an hf.co tag when the manifest says nothing', () => {
  const { models } = mapTagsToLocalModels(
    loadJsonFixture<OllamaTagsResponse>('api-tags.json')
  );
  const tagged = models.find((m) => m.name.endsWith('-GGUF:Q4_K_M'));
  expect(tagged?.quantizationLevel).toBe('Q4_K_M');

  const untagged = models.find((m) => m.name.endsWith('-GGUF:latest'));
  expect(untagged?.quantizationLevel).toBeNull();
});

it('prefers a quantization the manifest did report over the tag', () => {
  const { models } = mapTagsToLocalModels({
    models: [
      {
        name: 'hf.co/o/r:Q2_K',
        model: 'hf.co/o/r:Q2_K',
        modified_at: '',
        size: 0,
        digest: 'aaa',
        details: {
          parent_model: '',
          format: 'gguf',
          family: 'x',
          families: null,
          parameter_size: '7B',
          quantization_level: 'Q8_0',
        },
        capabilities: [],
      },
    ],
  });
  expect(models[0].quantizationLevel).toBe('Q8_0');
});
```

Use whatever `loadJsonFixture` / `OllamaTagsResponse` imports the file already has.

- [ ] **Step 10: Run it and confirm it fails**

Run: `npx vitest run test/ollama-backend.test.ts -t "hf.co tag"`
Expected: FAIL — `quantizationLevel` is `null`, expected `'Q4_K_M'`.

- [ ] **Step 11: Wire it into the mapper**

In `src/backends/ollama/index.ts`, import `quantFromTag` from `./client.js` and `loadQuantTable` from `../../data.js`, then in `mapTagsToLocalModels`:

```ts
      quantizationLevel:
        normalizeQuant(model.details.quantization_level) ??
        quantFromTag(model.name, loadQuantTable()),
```

`loadQuantTable()` memoizes internally, so calling it per row is free.

- [ ] **Step 12: Run the tests**

Run: `npx vitest run test/ollama-backend.test.ts`
Expected: PASS

Run: `npm test` — the guardrail snapshots FAIL again (one row's QUANT changed `?` → `Q4_K_M`). Refresh: `npx vitest run test/output-guardrail.test.ts -u`, read the diff, confirm only that one cell changed.

- [ ] **Step 13: Typecheck both configs**

Run: `npm run typecheck && npm run build`

- [ ] **Step 14: Commit**

```bash
git add src/model-names.ts src/backends/ollama/client.ts src/backends/ollama/index.ts \
        test/model-names.test.ts test/ollama-client.test.ts test/ollama-backend.test.ts \
        test/fixtures/
git commit -m "feat: recover quantization from hf.co pull tags

Ollama pulls HF repos as hf.co/<owner>/<repo>:<quant>, so the tag names the
quant when the manifest reports none. Gated on matching a known entry or
alias, which makes it safe to try on every name -- gemma3:12b and
...-mlx:4bit don't match and fall through to null. A reported quant always
wins over the tag."
```

---

## Task 3: `digest-collapse`

Seven local rows are six models: `…-GGUF:Q4_K_M` and `…-GGUF:latest` share digest `036489398bf6…`. Collapse them.

**Ordering matters:** this must run *after* quant resolution, because the representative-tag rule prefers whichever tag yielded a quant. Reverse the order and every tag's quant is still `null` at collapse time, so that preference cannot fire and the shortest-name fallback decides alone.

**Corrected during execution — the original justification here was wrong.** It claimed the shortest-name fallback "would pick `:latest`" over `:Q4_K_M`. Both tags are exactly 6 characters, so shortest-name does not discriminate between them; the tie resolves by insertion order, which in `api-tags.json` already favours `:Q4_K_M`. Replaying the real fixture through both orders yields identical output, so the real fixture **cannot** pin this constraint. A test that discriminates needs the quant-bearing tag to be both longer and later than its sibling — see the synthetic-input test in Step 7.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/backends/ollama/index.ts`
- Test: `test/ollama-backend.test.ts`

**Interfaces:**
- Consumes: `quantFromTag`, `normalizeQuant` (Tasks 1–2)
- Produces: `collapseByDigest(models: ModelInfo[]): ModelInfo[]` exported from `src/backends/ollama/index.ts`; `ModelInfo.digest?: string`; `ModelInfo.alsoTagged?: string[]`

- [ ] **Step 1: Extend `ModelInfo`**

In `src/types.ts`, add to the `ModelInfo` interface, after `discoverySource`:

```ts
  /** Content digest, when the backend reports one. Two tags sharing a digest are
   * the same weights, so they collapse to one row. */
  digest?: string;
  /** Other tags pointing at this same digest, for display. Absent when there
   * are none, keeping JSON output byte-identical for single-tag models. */
  alsoTagged?: string[];
```

- [ ] **Step 2: Write the failing test**

Add to `test/ollama-backend.test.ts`:

```ts
import { collapseByDigest } from '../src/backends/ollama/index.js';
import type { ModelInfo } from '../src/types.js';

function local(name: string, digest?: string, quant: string | null = null): ModelInfo {
  return {
    name,
    source: 'local',
    url: null,
    parameterSizeB: 11.9,
    quantizationLevel: quant,
    diskSizeBytes: 1,
    ...(digest !== undefined ? { digest } : {}),
  };
}

describe('collapseByDigest', () => {
  it('collapses two tags on one digest, preferring the quant-bearing tag', () => {
    const out = collapseByDigest([
      local('hf.co/o/r:latest', 'aaa', null),
      local('hf.co/o/r:Q4_K_M', 'aaa', 'Q4_K_M'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('hf.co/o/r:Q4_K_M');
    expect(out[0].quantizationLevel).toBe('Q4_K_M');
    expect(out[0].alsoTagged).toEqual(['hf.co/o/r:latest']);
  });

  it('falls back to the shortest name when no tag yields a quant', () => {
    const out = collapseByDigest([
      local('hf.co/o/r:some-long-tag', 'aaa', null),
      local('hf.co/o/r:v2', 'aaa', null),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('hf.co/o/r:v2');
    expect(out[0].alsoTagged).toEqual(['hf.co/o/r:some-long-tag']);
  });

  it('leaves distinct digests alone and sets no alsoTagged', () => {
    const out = collapseByDigest([local('a:1', 'aaa'), local('b:1', 'bbb')]);
    expect(out.map((m) => m.name)).toEqual(['a:1', 'b:1']);
    expect(out[0].alsoTagged).toBeUndefined();
  });

  it('passes through models with no digest, one row each', () => {
    const out = collapseByDigest([local('a:1'), local('b:1')]);
    expect(out.map((m) => m.name)).toEqual(['a:1', 'b:1']);
  });

  it('preserves input order by first appearance of each digest', () => {
    const out = collapseByDigest([
      local('z:1', 'zzz'),
      local('a:1', 'aaa'),
      local('z:2', 'zzz'),
    ]);
    expect(out.map((m) => m.name)).toEqual(['z:1', 'a:1']);
  });
});

it('collapses the two hf.co tags in the real tags fixture', () => {
  const { models } = mapTagsToLocalModels(
    loadJsonFixture<OllamaTagsResponse>('api-tags.json')
  );
  const agentic = models.filter((m) => m.name.includes('gemma-4-12B-agentic'));
  expect(agentic).toHaveLength(1);
  expect(agentic[0].name).toMatch(/:Q4_K_M$/);
  expect(agentic[0].alsoTagged).toEqual([
    'hf.co/yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF:latest',
  ]);
});
```

- [ ] **Step 3: Run it and confirm it fails for the right reason**

Run: `npx vitest run test/ollama-backend.test.ts -t collapseByDigest`
Expected: FAIL — no such export.

- [ ] **Step 4: Implement `collapseByDigest`**

Add to `src/backends/ollama/index.ts`:

```ts
/** Two tags pointing at the same digest are the same weights, so they are one
 * row. Representative choice: prefer a tag whose quantization resolved (which,
 * after quantFromTag, means the tag itself named a quant), else the shortest
 * name, ties going to first appearance.
 *
 * Call this AFTER quant resolution. Before it, every quant is still null, so
 * the preference can't fire and the survivor is decided by name length and
 * insertion order — neither of which tracks which tag carries usable
 * information. Equal-length siblings like `:latest` and `:Q4_K_M` make that
 * especially arbitrary. */
export function collapseByDigest(models: ModelInfo[]): ModelInfo[] {
  const groups = new Map<string, ModelInfo[]>();
  const out: ModelInfo[] = [];

  for (const model of models) {
    if (model.digest === undefined) {
      out.push(model);
      continue;
    }
    const existing = groups.get(model.digest);
    if (existing) {
      existing.push(model);
    } else {
      const group: ModelInfo[] = [model];
      groups.set(model.digest, group);
      // Placeholder holds this digest's slot so first-appearance order survives.
      out.push(model);
    }
  }

  return out.map((model) => {
    if (model.digest === undefined) return model;
    const group = groups.get(model.digest)!;
    if (group.length === 1) return model;
    const best =
      group.find((m) => m.quantizationLevel !== null) ??
      group.reduce((a, b) => (b.name.length < a.name.length ? b : a));
    return {
      ...best,
      alsoTagged: group.filter((m) => m.name !== best.name).map((m) => m.name),
    };
  });
}
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `npx vitest run test/ollama-backend.test.ts -t collapseByDigest`
Expected: PASS

- [ ] **Step 6: Carry `digest` through the mapper and collapse**

In `src/backends/ollama/index.ts`, add `digest: model.digest` to the object pushed in `mapTagsToLocalModels`, then collapse before returning:

```ts
  return { models: collapseByDigest(models), skipped };
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/ollama-backend.test.ts`
Expected: PASS, including the real-fixture test.

Run: `npm test` — guardrail snapshots FAIL (one fewer row). Refresh with `-u`, read the diff, confirm exactly one row disappeared.

- [ ] **Step 8: Typecheck both configs**

Run: `npm run typecheck && npm run build`

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/backends/ollama/index.ts test/ollama-backend.test.ts test/fixtures/
git commit -m "feat: collapse local models sharing a digest

Two tags on one digest are the same weights. Representative tag prefers one
whose quantization resolved, else the shortest name. Runs after quant
resolution: before it, every quant is null, so the preference can't fire and
the survivor is picked by name length and insertion order instead."
```

---

## Task 4: `remote-real-quants`

`hfCandidatesToModelInfo` discards `availableQuants` and sets `quantizationLevel: null`, so every remote row blind-guesses `Q4_K_M?` — while the real quant list prints in a separate block at the bottom of the output.

**Files:**
- Modify: `src/hf/model-info.ts`
- Test: `test/hf-model-info.test.ts`

**Interfaces:**
- Consumes: `QuantTable`, `QuantEntry`, `loadQuantTable` from `src/data.js`
- Produces: `pickQuant(availableQuants: string[], table: QuantTable): string | null` exported from `src/hf/model-info.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/hf-model-info.test.ts`:

```ts
import { pickQuant } from '../src/hf/model-info.js';
import { loadQuantTable, type QuantTable } from '../src/data.js';

describe('pickQuant', () => {
  const table = loadQuantTable();

  it('prefers the table fallback quant when the repo offers it', () => {
    expect(pickQuant(['BF16', 'Q8_0', 'Q4_K_M', 'Q6_K'], table)).toBe('Q4_K_M');
  });

  it('picks the nearest bytes-per-param when the fallback is absent', () => {
    // Q4_K_M is 0.5625. Q4_0 is 0.5 (Δ0.0625), Q5_K_M is 0.69 (Δ0.1275).
    expect(pickQuant(['Q8_0', 'Q5_K_M', 'Q4_0'], table)).toBe('Q4_0');
  });

  it('resolves an alias to its canonical id via the nearest-match branch', () => {
    expect(pickQuant(['MXFP4'], table)).toBe('Q4_0');
  });

  it('breaks an exact tie toward the smaller value', () => {
    // No two entries in data/quants.json are equidistant from Q4_K_M, so the
    // tie-break is unreachable with the real table. Test it against a synthetic
    // one rather than leave the rule uncovered — pickQuant takes the table as a
    // parameter precisely so this is possible.
    const synthetic: QuantTable = {
      fallback: 'MID',
      entries: [
        { id: 'MID', bytesPerParam: 0.5, aliases: [] },
        { id: 'HIGH', bytesPerParam: 0.6, aliases: [] },
        { id: 'LOW', bytesPerParam: 0.4, aliases: [] },
      ],
    };
    expect(pickQuant(['HIGH', 'LOW'], synthetic)).toBe('LOW');
    // Order-independent: the reducer must not just take whichever came first.
    expect(pickQuant(['LOW', 'HIGH'], synthetic)).toBe('LOW');
  });

  it('resolves aliases to canonical ids', () => {
    expect(pickQuant(['bf16'], table)).toBe('F16');
  });

  it('ignores quants absent from the table', () => {
    expect(pickQuant(['IQ4_XS', 'Q4_K_M'], table)).toBe('Q4_K_M');
  });

  it('returns null when nothing offered is in the table', () => {
    expect(pickQuant(['IQ4_XS', 'TQ2_0'], table)).toBeNull();
    expect(pickQuant([], table)).toBeNull();
  });
});

describe('hfCandidatesToModelInfo quant selection', () => {
  it('sets a real quantization from availableQuants', () => {
    const [info] = hfCandidatesToModelInfo(
      [
        {
          repoId: 'o/r',
          author: 'o',
          url: 'https://huggingface.co/o/r',
          parameterSizeB: 8,
          availableQuants: ['BF16', 'Q4_K_M', 'Q8_0'],
          signals: { downloads: 1, likes: 1, trendingScore: 1, lastModified: null },
        },
      ],
      (c) => `hf.co/${c.repoId}`
    );
    expect(info.quantizationLevel).toBe('Q4_K_M');
  });

  it('leaves quantizationLevel null when no offered quant is known', () => {
    const [info] = hfCandidatesToModelInfo(
      [
        {
          repoId: 'o/r',
          author: 'o',
          url: 'https://huggingface.co/o/r',
          parameterSizeB: 8,
          availableQuants: ['IQ4_XS'],
          signals: { downloads: 1, likes: 1, trendingScore: 1, lastModified: null },
        },
      ],
      (c) => `hf.co/${c.repoId}`
    );
    expect(info.quantizationLevel).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run test/hf-model-info.test.ts`
Expected: FAIL — `pickQuant` is not exported.

- [ ] **Step 3: Implement `pickQuant` and use it**

Replace the body of `src/hf/model-info.ts`:

```ts
import type { ModelInfo } from '../types.js';
import type { HfCandidate } from './discovery.js';
import { loadQuantTable, type QuantEntry, type QuantTable } from '../data.js';

function findEntry(table: QuantTable, raw: string): QuantEntry | undefined {
  const key = raw.trim().toUpperCase();
  return table.entries.find((e) => e.id === key || e.aliases.includes(key));
}

/** A repo ships many quants, so no single one describes it — but the estimate
 * has to assume something, and assuming the table's fallback blindly is worse
 * than reading what the repo actually publishes. Prefer the fallback quant when
 * offered (it is the common default), else the nearest bytes-per-param,
 * resolving ties toward the smaller value. Returns null when nothing offered is
 * in the table, which keeps today's behaviour for exotic repos. */
export function pickQuant(availableQuants: string[], table: QuantTable): string | null {
  const known = availableQuants
    .map((raw) => findEntry(table, raw))
    .filter((e): e is QuantEntry => e !== undefined);
  if (known.length === 0) return null;

  const target = table.entries.find((e) => e.id === table.fallback)!;
  const exact = known.find((e) => e.id === target.id);
  if (exact) return exact.id;

  return known.reduce((best, e) => {
    const de = Math.abs(e.bytesPerParam - target.bytesPerParam);
    const db = Math.abs(best.bytesPerParam - target.bytesPerParam);
    if (de < db) return e;
    if (de === db && e.bytesPerParam < best.bytesPerParam) return e;
    return best;
  }).id;
}

/** Shared HF candidate → ModelInfo mapping. Per the remote-candidates spec,
 * only the pull-name shape is per-backend: llama-server uses the bare repoId,
 * ollama uses `hf.co/<repoId>`. */
export function hfCandidatesToModelInfo(
  candidates: HfCandidate[],
  toName: (c: HfCandidate) => string
): ModelInfo[] {
  const table = loadQuantTable();
  return candidates.map((c) => ({
    name: toName(c),
    source: 'remote',
    url: c.url,
    parameterSizeB: c.parameterSizeB,
    quantizationLevel: pickQuant(c.availableQuants, table),
    diskSizeBytes: null,
    author: c.author,
    availableQuants: c.availableQuants,
    signals: c.signals,
    discoverySource: 'huggingface',
  }));
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/hf-model-info.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and refresh snapshots**

Run: `npm test`
Expected: guardrail FAILs — remote rows lose their `?` and their footprints shift where the picked quant differs from `Q4_K_M`.

Refresh: `npx vitest run test/output-guardrail.test.ts -u`. Read the diff and confirm remote QUANT cells no longer carry `?`.

- [ ] **Step 6: Typecheck both configs**

Run: `npm run typecheck && npm run build`

- [ ] **Step 7: Commit**

```bash
git add src/hf/model-info.ts test/hf-model-info.test.ts test/fixtures/
git commit -m "feat: estimate remote candidates against a real published quant

availableQuants was fetched and discarded, so every remote row blind-guessed
the table fallback and printed Q4_K_M? -- while the real quant list printed
in a separate block at the bottom of the output. Prefer the fallback quant
when the repo offers it, else nearest bytes-per-param."
```

---

## Task 4b: `fixture-hf-coverage`

**Added during execution.** Task 4's implementer reported that the guardrail snapshots did not change, and was right to be suspicious. `fixtureBackend()`'s `remoteCandidates` returns only `mapCandidates(parseSearchResults('ollama-search-mlx.html'))` — scrape candidates. Verified: all 16 remote rows in `guardrail-check.json` have `discoverySource: 'ollama.com'` and **zero** carry `signals`. So `hfCandidatesToModelInfo` has no end-to-end coverage at all.

That blinds four tasks, not one:

| Task | What it needs that scrape rows cannot provide |
| --- | --- |
| 4 `remote-real-quants` | `availableQuants` — scrape candidates have none |
| 5 `remote-rank` | `signals.downloads` — only HF supplies it |
| 6 `remote-filter` | `hf.co/<repo>` pull names, which is what dedup matches on |
| 11 `render-sections` | the downloads column |

It also becomes actively misleading after Task 7, which makes HF the default source and drops the scraper to `--query` only: the fixture would model a path the default no longer takes.

Slug-named rather than renumbered to Task 5, so every later task keeps its number and no existing cross-reference rots.

**Files:**
- Modify: `test/helpers/fixture-backend.ts`
- Test: `test/output-guardrail.test.ts` (snapshots), plus any count assertions

**Interfaces:**
- Consumes: `hfCandidatesToModelInfo` (`src/hf/model-info.js`), `mapHitToCandidate` (`src/hf/discovery.js`), the `hf-models-search.json` fixture
- Produces: `fixtureBackend()` returning candidates from **both** sources with two source reports, matching what the real ollama backend does

- [ ] **Step 1: Make the fixture backend mirror the real backend's two-source shape**

The real `ollamaBackend.remoteCandidates` queries `ollama.com` and Hugging Face and concatenates both. Mirror that, running the HF fixture through the *same* mapping functions the real backend uses, so a mapping bug cannot hide behind hand-rolled test data — the property the existing helper's docstring already claims.

In `test/helpers/fixture-backend.ts`:

```ts
import { mapHitToCandidate, type HfModelHit } from '../../src/hf/discovery.js';
import { hfCandidatesToModelInfo } from '../../src/hf/model-info.js';
```

and replace the `remoteCandidates` stub with:

```ts
    // Mirrors the real ollama backend: ollama.com scrape plus Hugging Face,
    // concatenated, both through the production mapping functions. The HF half
    // is what carries availableQuants and signals — without it, nothing in the
    // guardrail exercises the quant-picking, ranking, or dedup paths.
    remoteCandidates: async (query?: string) => ({
      candidates: [
        ...mapCandidates(parseSearchResults(loadTextFixture('ollama-search-mlx.html'))),
        ...hfCandidatesToModelInfo(
          loadJsonFixture<HfModelHit[]>('hf-models-search.json').map(mapHitToCandidate),
          (c) => `hf.co/${c.repoId}`
        ),
      ],
      sources: [
        { id: 'ollama.com', query: query ?? '', ok: true },
        { id: 'huggingface', query: query ?? '', ok: true },
      ],
    }),
```

The `hf.co/${c.repoId}` pull-name shape matches ollama's `hfPullName`. This also lands Task 7's `query ?? ''` change to this helper early, which is fine — Task 7 Step 5 then has nothing left to do here and should say so rather than redo it.

- [ ] **Step 2: Run the suite and see what moves**

Run: `npm test`

Expect the guardrail snapshots to fail with 10 new remote rows, and expect some count assertions elsewhere to fail. Fix count assertions to their correct new values — never loosen them.

- [ ] **Step 3: Refresh snapshots and verify the HF path is genuinely covered**

Run: `npx vitest run test/output-guardrail.test.ts -u`

Then confirm, by reading `test/fixtures/guardrail-check.json`:

- Remote rows now include entries with `discoverySource: 'huggingface'`.
- Those rows carry `signals` with real `downloads` values.
- Those rows carry `availableQuants`.
- **Their `quantizationLevel` is a real quant with `quantKnown: true`** — this is the end-to-end proof of Task 4 that was missing. `ornith-ai/Ornith-1.0-9B-GGUF` should show `Q4_K_M`, not `Q4_K_M?`.
- Local rows are unchanged.

If HF rows show `quantKnown: false`, Task 4 is not working end to end and this task has found a real bug — stop and report rather than committing.

- [ ] **Step 4: Typecheck both configs**

Run: `npm run typecheck && npm run build`

- [ ] **Step 5: Commit**

```bash
git add test/helpers/fixture-backend.ts test/fixtures/ test/
git commit -m "test: cover the Hugging Face path in the fixture backend

fixtureBackend() returned only ollama.com scrape candidates, so all 16 remote
rows in the guardrail carried no signals and no availableQuants -- meaning
hfCandidatesToModelInfo had no end-to-end coverage, and the ranking, dedup,
and downloads-column work that depends on HF metadata would have been
snapshot-blind too.

Now mirrors the real backend: both sources, concatenated, both through the
production mapping functions."
```

---

## Task 5: `remote-rank`

`signals.downloads` is fetched and never used. The HF API's own `trendingScore` sort put a 928-download 0.1B model above a 4.5M-download 9B one in the checked-in fixture.

**Files:**
- Modify: `src/check.ts`
- Test: `test/check.test.ts`

**Interfaces:**
- Consumes: `CheckRow` (existing)
- Produces: remote rows in `CheckResult.rows` sorted by downloads descending, nulls last. Local rows keep their order and stay ahead of remote rows.

- [ ] **Step 1: Write the failing test**

Add to `test/check.test.ts`:

```ts
it('orders remote rows by downloads descending, nulls last', async () => {
  const result = await runCheck('mlx', {
    backend: fixtureBackend({
      remoteCandidates: async () => ({
        candidates: [
          { name: 'few', source: 'remote', url: null, parameterSizeB: 7, quantizationLevel: 'Q4_K_M', diskSizeBytes: null, signals: { downloads: 10, likes: 0, trendingScore: 99, lastModified: null } },
          { name: 'none', source: 'remote', url: null, parameterSizeB: 7, quantizationLevel: 'Q4_K_M', diskSizeBytes: null, signals: { downloads: null, likes: 0, trendingScore: 50, lastModified: null } },
          { name: 'many', source: 'remote', url: null, parameterSizeB: 7, quantizationLevel: 'Q4_K_M', diskSizeBytes: null, signals: { downloads: 5000, likes: 0, trendingScore: 1, lastModified: null } },
        ],
        sources: [{ id: 'huggingface', query: '', ok: true }],
      }),
    }),
    probe: fixtureProbe(SYSTEM),
    estimator: formulaEstimator,
    gaps: new GapCollector(),
  });

  const remote = result.rows.filter((r) => r.source === 'remote').map((r) => r.name);
  expect(remote).toEqual(['many', 'few', 'none']);
});

it('keeps local rows ahead of remote rows', async () => {
  const result = await runCheck('mlx', {
    backend: fixtureBackend(),
    probe: fixtureProbe(SYSTEM),
    estimator: formulaEstimator,
    gaps: new GapCollector(),
  });
  const firstRemote = result.rows.findIndex((r) => r.source === 'remote');
  const lastLocal = result.rows.map((r) => r.source).lastIndexOf('local');
  expect(lastLocal).toBeLessThan(firstRemote);
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run test/check.test.ts -t "downloads descending"`
Expected: FAIL — order is `['few', 'none', 'many']` (input order).

- [ ] **Step 3: Sort the remote rows**

In `src/check.ts`, after `remoteRows` is built and before the `return`, add:

```ts
  // The HF API sorts by trendingScore, which rewards novelty: in the checked-in
  // fixture it ranks a 928-download 0.1B model above a 4.5M-download 9B one.
  // downloads is already in the payload and answers "is this worth pulling"
  // far better. trendingScore stays on the row for --json consumers.
  const rankedRemoteRows = [...remoteRows].sort(
    (a, b) => (b.signals?.downloads ?? -1) - (a.signals?.downloads ?? -1)
  );
```

and use `rankedRemoteRows` in the returned `rows`:

```ts
    rows: [...localRows, ...rankedRemoteRows],
```

Note `remoteGuidance` already reads `remoteRows`; leave that as-is since it only tests for presence.

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/check.test.ts`
Expected: PASS

- [ ] **Step 5: Full suite and snapshot refresh**

Run: `npm test` → guardrail FAILs (remote rows reordered). Refresh with `-u`, confirm the diff is a reordering only, no cell values changed.

- [ ] **Step 6: Typecheck both configs**

Run: `npm run typecheck && npm run build`

- [ ] **Step 7: Commit**

```bash
git add src/check.ts test/check.test.ts test/fixtures/
git commit -m "feat: rank remote candidates by downloads

signals.downloads was fetched and never used for ordering. The HF API's own
trendingScore sort rewards novelty -- in the checked-in fixture it ranks a
928-download 0.1B model above a 4.5M-download 9B one. trendingScore stays on
the row for --json."
```

---

## Task 6: `remote-filter`

Two filters are missing: a candidate already pulled locally is offered as a "pullable" suggestion, and embedding models come through as chat candidates.

**Files:**
- Modify: `src/check.ts`
- Test: `test/check.test.ts`

**Interfaces:**
- Consumes: `localRows` (existing, within `runCheck`); `splitModelTag` from `src/model-names.js` (Task 2)
- Produces: `untagged(name: string): string` and `isNonChat(name: string): boolean`, both exported from `src/check.ts`

Add `import { splitModelTag } from './model-names.js';` to `src/check.ts`. for testing

- [ ] **Step 1: Write the failing test**

Add to `test/check.test.ts`:

```ts
import { untagged, isNonChat } from '../src/check.js';

describe('untagged', () => {
  it('strips an Ollama tag', () => {
    expect(untagged('gemma3:12b')).toBe('gemma3');
    expect(untagged('hf.co/o/r:Q4_K_M')).toBe('hf.co/o/r');
  });

  it('leaves a name with no tag alone', () => {
    expect(untagged('mistrallite')).toBe('mistrallite');
    expect(untagged('hf.co/o/r')).toBe('hf.co/o/r');
  });

  it('does not mistake a namespace colon for a tag', () => {
    expect(untagged('hf.co/owner:weird/repo')).toBe('hf.co/owner:weird/repo');
  });
});

describe('isNonChat', () => {
  it('flags embedding and reranker models', () => {
    expect(isNonChat('mxbai-embed-large')).toBe(true);
    expect(isNonChat('charaf/qwen3-embedding-8b-mlx-mxfp8')).toBe(true);
    expect(isNonChat('BAAI/bge-reranker-v2-m3')).toBe(true);
  });

  it('does not flag ordinary chat models', () => {
    expect(isNonChat('gemma3:12b')).toBe(false);
    expect(isNonChat('ornith-ai/Ornith-1.0-9B-GGUF')).toBe(false);
  });
});

it('drops a remote candidate that is already pulled locally', async () => {
  const result = await runCheck('mlx', {
    backend: fixtureBackend({
      localModels: async () => ({
        models: [
          { name: 'hf.co/o/r:Q4_K_M', source: 'local', url: null, parameterSizeB: 8, quantizationLevel: 'Q4_K_M', diskSizeBytes: 1 },
        ],
        skipped: [],
      }),
      remoteCandidates: async () => ({
        candidates: [
          { name: 'hf.co/o/r', source: 'remote', url: null, parameterSizeB: 8, quantizationLevel: 'Q4_K_M', diskSizeBytes: null },
          { name: 'hf.co/other/repo', source: 'remote', url: null, parameterSizeB: 8, quantizationLevel: 'Q4_K_M', diskSizeBytes: null },
        ],
        sources: [{ id: 'huggingface', query: '', ok: true }],
      }),
    }),
    probe: fixtureProbe(SYSTEM),
    estimator: formulaEstimator,
    gaps: new GapCollector(),
  });

  const remote = result.rows.filter((r) => r.source === 'remote').map((r) => r.name);
  expect(remote).toEqual(['hf.co/other/repo']);
});

it('never filters a local model, even one that looks like an embedding model', async () => {
  const result = await runCheck('mlx', {
    backend: fixtureBackend({
      localModels: async () => ({
        models: [
          { name: 'mxbai-embed-large', source: 'local', url: null, parameterSizeB: 0.3, quantizationLevel: 'Q4_K_M', diskSizeBytes: 1 },
        ],
        skipped: [],
      }),
      remoteCandidates: async () => ({
        candidates: [
          { name: 'some/other-embed-model', source: 'remote', url: null, parameterSizeB: 1, quantizationLevel: 'Q4_K_M', diskSizeBytes: null },
        ],
        sources: [{ id: 'huggingface', query: '', ok: true }],
      }),
    }),
    probe: fixtureProbe(SYSTEM),
    estimator: formulaEstimator,
    gaps: new GapCollector(),
  });

  expect(result.rows.map((r) => r.name)).toEqual(['mxbai-embed-large']);
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run test/check.test.ts -t untagged`
Expected: FAIL — no such export.

- [ ] **Step 3: Implement both helpers and apply them**

Add near the top of `src/check.ts`:

```ts
/** Same tag rule as quantFromTag, via the same helper — one is asking what the
 * tag says, the other is asking what the name is without it. */
export function untagged(name: string): string {
  return splitModelTag(name).base;
}

/** Embedding and reranking models are not what "which model should I run"
 * means, and HF's pipeline_tag filter doesn't cover the ollama.com scrape.
 * Applied to candidates only — a user's own pulled model is theirs to see
 * regardless of what we think it's for. */
const NON_CHAT_PATTERNS: readonly RegExp[] = [/embed/i, /rerank/i];

export function isNonChat(name: string): boolean {
  return NON_CHAT_PATTERNS.some((re) => re.test(name));
}
```

Then, where `remoteRows` is built, filter the candidates before mapping. Replace the `.filter((c) => c.parameterSizeB !== null)` line with:

```ts
  const localNames = new Set(localRows.map((r) => untagged(r.name)));
  const remoteRows: CheckRow[] = remoteCandidates
    .filter((c) => c.parameterSizeB !== null)
    .filter((c) => !localNames.has(untagged(c.name)))
    .filter((c) => !isNonChat(c.name))
```

This requires `localRows` to be declared before `remoteRows`, which it already is.

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/check.test.ts`
Expected: PASS

- [ ] **Step 5: Full suite and snapshot refresh**

Run: `npm test` → guardrail FAILs (fewer remote rows). Refresh with `-u` and confirm only removals.

- [ ] **Step 6: Typecheck both configs**

Run: `npm run typecheck && npm run build`

- [ ] **Step 7: Commit**

```bash
git add src/check.ts test/check.test.ts test/fixtures/
git commit -m "feat: drop already-pulled and non-chat remote candidates

A candidate already pulled locally was offered as a pullable suggestion --
one model occupied three rows of one table (two local tags plus a remote
candidate). Embedding models came through as chat candidates because HF's
pipeline_tag filter doesn't cover the ollama.com scrape. Local models are
never filtered."
```

---

## Task 7: `drop-mlx-default`

`SCRAPE_DEFAULT_QUERY = 'mlx'` produces 16 of 26 remote rows. Not because MLX models are broken — verified live, they are ordinary GGUFs that run fine — but because a hardcoded default query is a filter, and no-query should not mean filtered. It selected four 35B and three 27B models against a 16GB budget.

**Files:**
- Modify: `src/backends/ollama/index.ts:100-102`
- Modify: `test/helpers/fixture-backend.ts`
- Test: `test/ollama-backend.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `remoteCandidates(undefined, …)` passes `''` to both sources

- [ ] **Step 1: Write the failing test**

Add to `test/ollama-backend.test.ts`:

```ts
it('defaults both sources to an empty query when none is given', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('ollama.com')) {
      return new Response('<html></html>', { status: 200 });
    }
    return new Response('[]', { status: 200 });
  }) as typeof fetch;

  try {
    const discovery = await ollamaBackend.remoteCandidates!(undefined, {});
    expect(discovery.sources.map((s) => s.query)).toEqual(['', '']);
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(calls.some((u) => u.includes('q=mlx'))).toBe(false);
  expect(calls.some((u) => u.includes('search=mlx'))).toBe(false);
});
```

Add `import { ollamaBackend } from '../src/backends/ollama/index.js';` if absent.

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run test/ollama-backend.test.ts -t "empty query"`
Expected: FAIL — sources report `['mlx', '']` and a URL contains `q=mlx`.

- [ ] **Step 3: Delete the constant**

In `src/backends/ollama/index.ts`, remove the `SCRAPE_DEFAULT_QUERY` declaration and its doc comment (lines 100–102), then in `remoteCandidates`:

```ts
  // No query means "show me what's relevant and fits", not "filter to one
  // arbitrary slice". A hardcoded default query is a filter: 'mlx' used to
  // live here and selected four 35B and three 27B models against a 16GB
  // budget, plus whatever reuploaders had appended the tag. MLX-tagged models
  // are ordinary GGUFs and still appear when they rank well or via --query.
  const scrapeQuery = query ?? '';
  const hfQuery = query ?? '';
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/ollama-backend.test.ts -t "empty query"`
Expected: PASS

- [ ] **Step 5: Drop the `'mlx'` default from the test helper** — *already done by Task 4b*

Task 4b changed this helper's source reports to `query ?? ''` while adding HF coverage. Verify that is still the case and move on; do not redo it.

In `test/helpers/fixture-backend.ts`, change the `remoteCandidates` stub's source report so it no longer invents a default:

```ts
    remoteCandidates: async (query?: string) => ({
      candidates: mapCandidates(parseSearchResults(loadTextFixture('ollama-search-mlx.html'))),
      sources: [{ id: 'ollama.com', query: query ?? '', ok: true }],
    }),
```

The fixture *file* keeps its name — it is a real captured `ollama.com/search?q=mlx` response and remains a valid scrape-parsing fixture. Only the default query changes.

- [ ] **Step 6: Full suite and snapshot refresh**

Run: `npm test`

Expected: **guardrail snapshots do not change at all.** An earlier draft of this step predicted a shift in the "Remote sources:" footer; that was wrong. `fixtureBackend()`'s `remoteCandidates` is a complete replacement for the real backend's and never consults `SCRAPE_DEFAULT_QUERY`, and `output-guardrail.test.ts` passes an explicit `'mlx'` query anyway.

The consequence is the important part: **the fixture backend cannot verify this task.** The only meaningful test drives the real `ollamaBackend.remoteCandidates` with `fetch` stubbed, which is what Step 1 does. If snapshots *do* move, something consults the constant that this plan has not accounted for — investigate rather than refreshing.

Expect instead that pre-existing tests in `test/ollama-backend.test.ts` which hard-assert the `'mlx'` default will fail. Rewrite them to assert the new contract; do not delete their assertions.

- [ ] **Step 7: Typecheck both configs**

Run: `npm run typecheck && npm run build`

- [ ] **Step 8: Commit**

```bash
git add src/backends/ollama/index.ts test/helpers/fixture-backend.ts \
        test/ollama-backend.test.ts test/fixtures/
git commit -m "feat: no-query discovery stops filtering to 'mlx'

Not because MLX models are broken -- verified live, a locally-pulled
mlx-tagged model reports format gguf, Q4_K_M, and runs fine. The tag is
cosmetic. A hardcoded default query is a filter, and no-query should not mean
filtered: this one selected four 35B and three 27B models against a 16GB
budget, and searching a community tag selects for reuploaders rather than
quality. MLX models still appear when they rank well or via --query mlx."
```

---

## Task 8: `fit-groups`

`BASELINE` and `CURRENT` agree on 28 of 33 rows, spending two columns to say one thing. Replace both with a derived group key so the group header carries the verdict.

**Files:**
- Modify: `src/check.ts`
- Test: `test/check.test.ts`

**Interfaces:**
- Consumes: `Verdict` from `src/estimators/types.js`
- Produces: `FitGroup` type and `fitGroup(baseline: Verdict | 'unknown', current: Verdict | 'unknown'): FitGroup`, both exported from `src/check.ts`; `CheckRow.fit: FitGroup`

- [ ] **Step 1: Write the failing test**

Add to `test/check.test.ts`:

```ts
import { fitGroup } from '../src/check.js';

describe('fitGroup', () => {
  it('groups agreement under the shared verdict', () => {
    expect(fitGroup('comfortable', 'comfortable')).toBe('comfortable');
    expect(fitGroup('tight', 'tight')).toBe('tight');
  });

  it('reports pressured when right-now is worse than the baseline budget', () => {
    expect(fitGroup('comfortable', 'tight')).toBe('pressured');
    expect(fitGroup('comfortable', 'will-thrash')).toBe('pressured');
    expect(fitGroup('tight', 'will-thrash')).toBe('pressured');
  });

  it('reports over-budget when the model fits right now but not the safe budget', () => {
    expect(fitGroup('will-thrash', 'tight')).toBe('over-budget');
    expect(fitGroup('will-thrash', 'comfortable')).toBe('over-budget');
    expect(fitGroup('tight', 'comfortable')).toBe('tight');
  });

  it('keeps a model that fits nowhere out of over-budget', () => {
    // Equal severities don't trip `pressured`, so a naive
    // `baseline === 'will-thrash'` test would file this under a header
    // reading "fits right now". It fits nowhere.
    expect(fitGroup('will-thrash', 'will-thrash')).toBe('will-thrash');
  });

  it('is unclassified when the baseline verdict is unknown', () => {
    expect(fitGroup('unknown', 'unknown')).toBe('unclassified');
    expect(fitGroup('unknown', 'comfortable')).toBe('unclassified');
  });

  it('falls back to the baseline when only current is unknown', () => {
    expect(fitGroup('comfortable', 'unknown')).toBe('comfortable');
    expect(fitGroup('will-thrash', 'unknown')).toBe('will-thrash');
  });
});

it('puts a fit group on every row', async () => {
  const result = await runCheck('mlx', {
    backend: fixtureBackend(),
    probe: fixtureProbe(SYSTEM),
    estimator: formulaEstimator,
    gaps: new GapCollector(),
  });
  for (const row of result.rows) {
    expect(row.fit).toBeDefined();
  }
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run test/check.test.ts -t fitGroup`
Expected: FAIL — no such export.

- [ ] **Step 3: Implement `fitGroup`**

Add to `src/check.ts`:

```ts
export type FitGroup =
  | 'comfortable'
  | 'pressured'
  | 'tight'
  | 'over-budget'
  | 'will-thrash'
  | 'unclassified';

const SEVERITY: Record<Verdict, number> = { comfortable: 0, tight: 1, 'will-thrash': 2 };

/** Collapses the baseline/current verdict pair into one group. Baseline is the
 * grouping axis because it is the conservative, trustworthy figure; the two
 * derived groups carry the disagreement.
 *
 * The `over-budget` branch must test that current is *strictly* better than
 * will-thrash. Testing only `baseline === 'will-thrash'` would send
 * (will-thrash, will-thrash) — a model that fits nowhere — into a group
 * labelled "fits right now", since equal severities don't trip `pressured`. */
export function fitGroup(
  baseline: Verdict | 'unknown',
  current: Verdict | 'unknown'
): FitGroup {
  if (baseline === 'unknown') return 'unclassified';
  if (current === 'unknown') return baseline;
  if (SEVERITY[current] > SEVERITY[baseline]) return 'pressured';
  if (baseline === 'will-thrash' && SEVERITY[current] < SEVERITY['will-thrash']) {
    return 'over-budget';
  }
  return baseline;
}
```

- [ ] **Step 4: Add `fit` to `CheckRow` and populate it**

In the `CheckRow` interface:

```ts
  /** Derived from baselineVerdict + currentVerdict; see fitGroup(). Additive —
   * both raw verdicts stay on the row for --json consumers. */
  fit: FitGroup;
```

Then add `fit: fitGroup(<baseline>, <current>)` to each of the four `CheckRow` object literals in `runCheck` (the measured-local branch, the null-params local branch, the estimated-local branch, and the remote branch), using that branch's own verdict values. For the null-params branch both are `'unknown'`, so `fit: 'unclassified'`.

- [ ] **Step 5: Project `alsoTagged` from `ModelInfo` onto `CheckRow`**

**Plan defect found during execution** (Task 3's implementer caught it): Task 3 sets `alsoTagged` on `ModelInfo`, but `CheckRow` is a separate interface and nothing projected the field across — so the collapsed tags never reached rendering, and Task 11's `cells()` would read `r.alsoTagged` off a row that never had it. It was dead data. Task 3's tests didn't catch it because they assert on `mapTagsToLocalModels` output, not on `runCheck`. Assigned here because this task already touches `CheckRow` and every literal in `runCheck`.

Add to the `CheckRow` interface:

```ts
  /** Other tags pointing at the same weights, collapsed by the backend. Absent
   * when there are none, so --json output stays byte-identical for single-tag
   * models. Display-only — the collapse decision already happened upstream. */
  alsoTagged?: string[];
```

Populate it on the **three local** branches only (remote candidates have no tags to collapse), spreading conditionally so the key stays absent rather than becoming `undefined`:

```ts
        ...(model.alsoTagged !== undefined ? { alsoTagged: model.alsoTagged } : {}),
```

Do **not** project `digest`. It is an internal grouping key with no display use, and adding it to `CheckRow` would change `--json` output for every row to no purpose.

Add a test to `test/check.test.ts` pinning the projection end to end — the gap existed precisely because nothing tested this seam:

```ts
it('carries collapsed tags through to the check row', async () => {
  const result = await runCheck('mlx', {
    backend: fixtureBackend(),
    probe: fixtureProbe(SYSTEM),
    estimator: formulaEstimator,
    gaps: new GapCollector(),
  });
  const collapsed = result.rows.find((r) => r.name.includes('gemma-4-12B-agentic'));
  expect(collapsed?.alsoTagged).toEqual([
    'hf.co/yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF:latest',
  ]);
});

it('leaves alsoTagged absent on a single-tag model', async () => {
  const result = await runCheck('mlx', {
    backend: fixtureBackend(),
    probe: fixtureProbe(SYSTEM),
    estimator: formulaEstimator,
    gaps: new GapCollector(),
  });
  const single = result.rows.find((r) => r.name === 'gemma3:12b');
  expect(single).toBeDefined();
  expect('alsoTagged' in single!).toBe(false);
});
```

Reuse the `SYSTEM`/binding names already present in `test/check.test.ts`.

- [ ] **Step 6: Fix the hand-built row literals in the tests**

`fit` is required, so every hand-built `CheckRow` literal stops typechecking — and `npm test` alone will not tell you, because vitest transpiles without typechecking. `test/format.test.ts` has 9 such literals; `test/check.test.ts` has 1.

Run `npm run typecheck` to get the exact list, then add the correct `fit` value to each. Derive it from that literal's own `baselineVerdict`/`currentVerdict` per the table in Step 1 — do **not** blanket-add `fit: 'comfortable'`. `test/format.test.ts`'s `sampleResult` is `comfortable`/`will-thrash`, so its `fit` is `'pressured'`, and Task 11 has a test asserting exactly that. Getting this wrong here makes that test fail for a confusing reason two tasks later.

`test/formula-estimator.test.ts` builds `Estimate` objects, not `CheckRow`s, so it needs no change.

- [ ] **Step 7: Run it and confirm it passes**

Run: `npx vitest run test/check.test.ts`
Expected: PASS

- [ ] **Step 8: Full suite and snapshot refresh**

Run: `npm test` → `guardrail-check.json` FAILs (new `fit` field on every row, plus `alsoTagged` on the collapsed row); the table snapshot should be unchanged, since `fit` is not rendered until Task 11. Refresh with `-u`.

The `alsoTagged` appearing in `guardrail-check.json` is the visible proof the Step 5 projection works — Task 3's snapshot refresh did **not** show it, which is how the gap was found.

- [ ] **Step 9: Typecheck both configs**

Run: `npm run typecheck && npm run build`
Expected: both clean. If `typecheck` still reports missing `fit`, Step 6 is incomplete.

- [ ] **Step 10: Commit**

```bash
git add src/check.ts test/check.test.ts test/format.test.ts test/fixtures/guardrail-check.json
git commit -m "feat: derive a fit group from the baseline/current verdict pair

The two verdict columns agree on 28 of 33 rows, spending two columns to say
one thing. Group on baseline (the conservative figure) with derived
'pressured' and 'over-budget' groups carrying the disagreement. over-budget
requires current strictly better than will-thrash, else a model that fits
nowhere lands in a group labelled 'fits right now'."
```

---

## Task 9: `recommendations`

`src/format.ts:124` picks the suggested model as `rows.find(r => r.baselineVerdict !== 'unknown')` — whatever landed first in insertion order. Make both recommendations explicit so sort order stops carrying meaning it cannot express.

**Files:**
- Modify: `src/check.ts`
- Test: `test/check.test.ts`

**Interfaces:**
- Consumes: `CheckRow.fit` (Task 8), `CheckRow.footprintGb`
- Produces: `Recommendations` interface and `CheckResult.recommendations: Recommendations`

```ts
export interface Recommendations {
  /** Largest local row in the best available fit group (comfortable →
   * pressured → tight → over-budget), falling back to the first local row if
   * none of those has one. Null only when there are no local models. */
  runNow: string | null;
  /** A larger local row in `over-budget`, mentioned as the bigger-but-riskier option. */
  runNowBigger: string | null;
  /** Highest-ranked remote row in `comfortable`. Rows arrive pre-sorted by downloads. */
  worthPulling: string | null;
}
```

- [ ] **Step 1: Write the failing test**

Add to `test/check.test.ts`:

```ts
it('recommends the largest comfortable local model and the top comfortable candidate', async () => {
  const result = await runCheck('mlx', {
    backend: fixtureBackend(),
    probe: fixtureProbe(SYSTEM),
    estimator: formulaEstimator,
    gaps: new GapCollector(),
  });

  const local = result.rows.filter((r) => r.source === 'local' && r.fit === 'comfortable');
  const largest = local.reduce((a, b) => ((b.footprintGb ?? 0) > (a.footprintGb ?? 0) ? b : a));
  expect(result.recommendations.runNow).toBe(largest.name);

  const topRemote = result.rows.find((r) => r.source === 'remote' && r.fit === 'comfortable');
  expect(result.recommendations.worthPulling).toBe(topRemote?.name ?? null);
});

it('names a larger over-budget local model as the bigger option', async () => {
  const result = await runCheck('mlx', {
    backend: fixtureBackend(),
    probe: fixtureProbe(SYSTEM),
    estimator: formulaEstimator,
    gaps: new GapCollector(),
  });
  // gemma3:27b is over-budget against the 16GB baseline and larger than any
  // comfortable row, so it must surface as the bigger-but-riskier option.
  expect(result.recommendations.runNowBigger).toBe('gemma3:27b');
});

it('returns nulls when a side has no qualifying row', async () => {
  const result = await runCheck('mlx', {
    backend: fixtureBackend({
      localModels: async () => ({ models: [], skipped: [] }),
      remoteCandidates: async () => ({ candidates: [], sources: [] }),
    }),
    probe: fixtureProbe(SYSTEM),
    estimator: formulaEstimator,
    gaps: new GapCollector(),
  });
  expect(result.recommendations).toEqual({
    runNow: null,
    runNowBigger: null,
    worthPulling: null,
  });
});

it('recommends the best available group when nothing is comfortable', async () => {
  // A machine under pressure: nothing classifies comfortable, so Run now must
  // still name something rather than going silent. Requiring 'comfortable'
  // here would regress aa4a7d0.
  const result = await runCheck('mlx', {
    backend: fixtureBackend({
      localModels: async () => ({
        models: [
          { name: 'big:latest', source: 'local', url: null, parameterSizeB: 27, quantizationLevel: 'Q4_K_M', diskSizeBytes: 1 },
          { name: 'bigger:latest', source: 'local', url: null, parameterSizeB: 30, quantizationLevel: 'Q4_K_M', diskSizeBytes: 1 },
        ],
        skipped: [],
      }),
      remoteCandidates: async () => ({ candidates: [], sources: [] }),
    }),
    probe: fixtureProbe(SYSTEM),
    estimator: formulaEstimator,
    gaps: new GapCollector(),
  });
  expect(result.recommendations.runNow).not.toBeNull();
  expect(result.recommendations.worthPulling).toBeNull();
});

it('falls back to the first local row when every row is unclassified', async () => {
  // llama-server reports no size for a model it has never loaded. Benching it
  // is exactly how it becomes classifiable, so it must still be named.
  const result = await runCheck('mlx', {
    backend: fixtureBackend({
      localModels: async () => ({
        models: [
          { name: 'never-loaded:latest', source: 'local', url: null, parameterSizeB: null, quantizationLevel: null, diskSizeBytes: null },
        ],
        skipped: [],
      }),
      remoteCandidates: async () => ({ candidates: [], sources: [] }),
    }),
    probe: fixtureProbe(SYSTEM),
    estimator: formulaEstimator,
    gaps: new GapCollector(),
  });
  expect(result.recommendations.runNow).toBe('never-loaded:latest');
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run test/check.test.ts -t recommend`
Expected: FAIL — `result.recommendations` is `undefined`.

- [ ] **Step 3: Implement**

Add to `src/check.ts`:

```ts
export interface Recommendations {
  runNow: string | null;
  runNowBigger: string | null;
  worthPulling: string | null;
}

/** Fit groups in Run now preference order. Best-available wins; this is not a
 * filter. See recommend() for why the fallback beyond these matters. */
const RUN_NOW_PREFERENCE: readonly FitGroup[] = [
  'comfortable',
  'pressured',
  'tight',
  'over-budget',
];

/** Computed rather than inferred from sort position, so the recommendation can
 * encode nuance a sort order cannot — notably that the largest model a machine
 * can run right now may be one the conservative budget rejects. */
function recommend(rows: CheckRow[]): Recommendations {
  const biggest = (candidates: CheckRow[]): CheckRow | null =>
    candidates.length === 0
      ? null
      : candidates.reduce((a, b) => ((b.footprintGb ?? 0) > (a.footprintGb ?? 0) ? b : a));

  const local = rows.filter((r) => r.source === 'local');
  // Preference order, not a filter. Insisting on 'comfortable' would print no
  // hint at all on a machine whose models are all tight or over-budget, and the
  // final fallback preserves aa4a7d0: on llama-server a never-loaded model
  // reports no size, and benching it is exactly how it becomes classifiable, so
  // declining to name it leaves the user no way forward.
  const preferred = RUN_NOW_PREFERENCE.map((g) =>
    biggest(local.filter((r) => r.fit === g))
  ).find((r) => r !== null);
  const runNow = preferred ?? local[0] ?? null;
  const overBudget = biggest(local.filter((r) => r.fit === 'over-budget'));
  // Rows arrive pre-sorted by downloads, so the first match is the top-ranked one.
  const worthPulling =
    rows.find((r) => r.source === 'remote' && r.fit === 'comfortable') ?? null;

  return {
    runNow: runNow?.name ?? null,
    runNowBigger:
      overBudget && (overBudget.footprintGb ?? 0) > (runNow?.footprintGb ?? 0)
        ? overBudget.name
        : null,
    worthPulling: worthPulling?.name ?? null,
  };
}
```

Then in the returned object, with `rows` already assembled into a local const:

```ts
  const rows = [...localRows, ...rankedRemoteRows];
  return {
    rows,
    recommendations: recommend(rows),
    cloudModels,
    // …the rest unchanged
  };
```

Add `recommendations: Recommendations;` to the `CheckResult` interface.

- [ ] **Step 4: Fix the hand-built `CheckResult` literals in the tests**

Same trap as Task 8 Step 5, for the same reason: `recommendations` is required, and vitest won't tell you. Run `npm run typecheck` for the list and add a `recommendations` object to each hand-built `CheckResult` — `{ runNow: null, runNowBigger: null, worthPulling: null }` is the right default for literals whose recommendations aren't what the test is about. Task 11's tests override it explicitly where they need to.

- [ ] **Step 5: Run it and confirm it passes**

Run: `npx vitest run test/check.test.ts`
Expected: PASS

- [ ] **Step 6: Full suite and snapshot refresh**

Run: `npm test` → `guardrail-check.json` FAILs (new object). Refresh with `-u`.

- [ ] **Step 7: Typecheck both configs**

Run: `npm run typecheck && npm run build`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add src/check.ts test/check.test.ts test/format.test.ts test/fixtures/guardrail-check.json
git commit -m "feat: compute run-now and worth-pulling recommendations explicitly

format.ts picked its suggestion as the first row with a known verdict, i.e.
whatever insertion order produced -- which is why it suggested
gemma4-composer-64k:latest, not because it was good but because it was first.
Computing both explicitly lets the recommendation say that the largest model
the machine can run right now is one the conservative budget rejects, which a
sort position cannot express."
```

---

## Task 10: `format-split`

`src/format.ts` is 196 lines and `formatCheckTable` is 108 of them; Task 11 grows it substantially. Split first as a **pure refactor** — the guardrail snapshots must not change, which is what proves it.

**Files:**
- Create: `src/format/table.ts`, `src/format/check.ts`, `src/format/bench.ts`
- Modify: `src/format.ts` (becomes a barrel)
- Test: `test/format-table.test.ts` (new)

**Interfaces:**
- Produces, from `src/format/table.ts`:
  - `padCell(display: string, plain: string, width: number): string`
  - `columnWidths(plainRows: string[][]): number[]` — takes *all* rows including any header row, rather than header-plus-rows. The old inline code special-cased the header only because it happened to have one; Task 11's sections have no header row, and a caller shouldn't have to synthesise a fake one to use this.
  - `formatRow(displayCells: string[], plainCells: string[], widths: number[]): string`
- `src/format.ts` re-exports everything previously exported from it, so no import site outside `src/format/` changes.

- [ ] **Step 1: Write the failing test for the extracted helpers**

Create `test/format-table.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { padCell, columnWidths, formatRow } from '../src/format/table.js';

describe('columnWidths', () => {
  it('takes the widest cell per column', () => {
    expect(
      columnWidths([['MODEL', 'Q'], ['gemma3:12b', 'Q4_K_M'], ['a', 'b']])
    ).toEqual([10, 6]);
  });

  it('handles a single row', () => {
    expect(columnWidths([['MODEL', 'QUANT']])).toEqual([5, 5]);
  });

  it('returns no widths for no rows', () => {
    expect(columnWidths([])).toEqual([]);
  });
});

describe('padCell', () => {
  it('pads to the target width', () => {
    expect(padCell('abc', 'abc', 5)).toBe('abc  ');
  });

  it('pads against the plain width, not the display width', () => {
    // A colorized cell carries invisible escape codes; padding against its own
    // length would over-pad and throw the column out of alignment.
    const display = '[32mok[0m';
    expect(padCell(display, 'ok', 4)).toBe(`${display}  `);
  });

  it('never returns a negative pad', () => {
    expect(padCell('toolong', 'toolong', 2)).toBe('toolong');
  });
});

describe('formatRow', () => {
  it('joins padded cells with two spaces', () => {
    expect(formatRow(['a', 'b'], ['a', 'b'], [3, 1])).toBe('a    b');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run test/format-table.test.ts`
Expected: FAIL — cannot resolve `../src/format/table.js`.

- [ ] **Step 3: Create `src/format/table.ts`**

```ts
/** Table layout primitives shared by the check renderer. Column widths are
 * computed from plain (uncolored) text and cells are padded against that plain
 * width — ANSI escape codes have no display width, so padding against a
 * colorized cell's own `.length` pads too far and breaks alignment. */

export function columnWidths(plainRows: string[][]): number[] {
  if (plainRows.length === 0) return [];
  const columns = Math.max(...plainRows.map((row) => row.length));
  return Array.from({ length: columns }, (_, i) =>
    Math.max(...plainRows.map((row) => (row[i] ?? '').length))
  );
}

export function padCell(display: string, plain: string, width: number): string {
  return display + ' '.repeat(Math.max(0, width - plain.length));
}

export function formatRow(
  displayCells: string[],
  plainCells: string[],
  widths: number[]
): string {
  return displayCells.map((c, i) => padCell(c, plainCells[i], widths[i])).join('  ');
}
```

The `plainRows.length === 0` guard matters: `Math.max()` with no arguments is `-Infinity`, so an empty table would otherwise produce garbage widths rather than no widths.

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/format-table.test.ts`
Expected: PASS

- [ ] **Step 5: Move the renderers into their own modules**

Create `src/format/bench.ts` containing `formatBenchResult`, `formatPullProgress`, the `NOT_REPORTED` constant, and the `FormatOptions` interface, moved verbatim from `src/format.ts`. Fix the relative import depth (`../colors.js`, `../bench.js`, `../backends/types.js`).

Create `src/format/check.ts` containing `formatCheckTable` and `formatCheckJson`, moved verbatim except that the local `widths` / `padCell` / `formatRow` definitions are deleted and replaced by an import:

```ts
import { columnWidths, formatRow } from './table.js';
```

with the two call sites becoming `columnWidths([header, ...plainRows])` and `formatRow(cells, plain, widths)` — including the header row in the input produces the same widths the old inline code computed, so this stays a behaviour-preserving move. Re-export `FormatOptions` from `./bench.js` so both modules share one definition.

- [ ] **Step 6: Turn `src/format.ts` into a barrel**

```ts
/** Barrel kept so import sites outside src/format/ are unaffected by the split. */
export { formatCheckTable, formatCheckJson } from './format/check.js';
export { formatBenchResult, formatPullProgress } from './format/bench.js';
export type { FormatOptions } from './format/bench.js';
```

- [ ] **Step 7: Prove it is a pure refactor**

Run: `npm test`
Expected: **ALL PASS with no snapshot changes.** If any guardrail snapshot differs, the move was not verbatim — fix it rather than refreshing the snapshot. That is the entire point of doing this as its own task.

- [ ] **Step 8: Typecheck both configs**

Run: `npm run typecheck && npm run build`

- [ ] **Step 9: Commit**

```bash
git add src/format.ts src/format/ test/format-table.test.ts
git commit -m "refactor: split format.ts into table/check/bench modules

format.ts was 196 lines with formatCheckTable taking 108, and the output
redesign grows it substantially. table.ts holds the ANSI-aware padding
primitives, which are subtle enough to deserve their own tests. format.ts
stays as a barrel so no import site outside src/format/ changes.

Pure refactor: guardrail snapshots unchanged."
```

---

## Task 11: `render-sections`

The visible change. Replace the single table with a header line, two ranked capped sections grouped by fit, and explicit recommendations. Cloud models stop being rendered.

**Files:**
- Modify: `src/format/check.ts`
- Test: `test/format.test.ts`, `test/output-guardrail.test.ts`

**Interfaces:**
- Consumes: `CheckResult.recommendations`, `CheckRow.fit`, `CheckRow.alsoTagged`, `columnWidths`/`formatRow` from `./table.js`
- Produces: `formatCheckTable(result, opts)` with a new `opts.expand?: 'local' | 'remote' | 'all'`; `SECTION_CAP = 5`; `groupLabel(group: FitGroup, result: CheckResult): string`

- [ ] **Step 1: Write the failing tests for the new structure**

Add to `test/format.test.ts`. Extend the existing `sampleResult` with the fields Tasks 8–9 added (`fit`, `recommendations`) if not already present.

```ts
import { SECTION_CAP } from '../src/format/check.js';

describe('formatCheckTable sections', () => {
  it('leads with a one-line header carrying both headroom figures', () => {
    const out = formatCheckTable(sampleResult, { color: false });
    const first = out.split('\n')[0];
    expect(first).toContain('24.0G total');
    expect(first).toContain('16.0G safe budget');
    expect(first).toMatch(/free now/);
  });

  it('never renders cloud models', () => {
    const out = formatCheckTable(
      { ...sampleResult, cloudModels: ['glm-5.2:cloud', 'gemma4:cloud'] },
      { color: false }
    );
    expect(out).not.toContain('glm-5.2:cloud');
    expect(out).not.toContain('Cloud models');
  });

  it('renders a group header per fit group present, not a verdict column', () => {
    const out = formatCheckTable(sampleResult, { color: false });
    expect(out).not.toContain('BASELINE');
    expect(out).not.toContain('CURRENT');
    // sampleResult's row is comfortable/will-thrash → pressured
    expect(out).toMatch(/tight right now/);
  });

  it('caps a section and reports what was withheld', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      ...sampleResult.rows[0],
      name: `local-${i}`,
      footprintGb: 8 - i,
      fit: 'comfortable' as const,
      baselineVerdict: 'comfortable' as const,
      currentVerdict: 'comfortable' as const,
    }));
    const out = formatCheckTable({ ...sampleResult, rows: many }, { color: false });
    expect(out).toContain(`+${9 - SECTION_CAP} more`);
    expect(out).toContain('--local');
    expect(out).toContain('local-0');
    expect(out).not.toContain('local-8');
  });

  it('emits no overflow line at exactly the cap', () => {
    const exactly = Array.from({ length: SECTION_CAP }, (_, i) => ({
      ...sampleResult.rows[0],
      name: `local-${i}`,
      fit: 'comfortable' as const,
      baselineVerdict: 'comfortable' as const,
      currentVerdict: 'comfortable' as const,
    }));
    const out = formatCheckTable({ ...sampleResult, rows: exactly }, { color: false });
    expect(out).not.toContain('more');
  });

  it('uncaps the section named by expand', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      ...sampleResult.rows[0],
      name: `local-${i}`,
      fit: 'comfortable' as const,
      baselineVerdict: 'comfortable' as const,
      currentVerdict: 'comfortable' as const,
    }));
    const out = formatCheckTable({ ...sampleResult, rows: many }, {
      color: false,
      expand: 'local',
    });
    expect(out).toContain('local-8');
    expect(out).not.toContain('more');
  });

  it('shows collapsed tags inline', () => {
    const out = formatCheckTable(
      {
        ...sampleResult,
        rows: [{ ...sampleResult.rows[0], alsoTagged: ['gemma3:latest'] }],
      },
      { color: false }
    );
    expect(out).toContain('gemma3:latest');
  });

  it('renders both recommendation lines when both sides qualify', () => {
    const out = formatCheckTable(
      {
        ...sampleResult,
        recommendations: {
          runNow: 'gemma3:12b',
          runNowBigger: 'gemma3:27b',
          worthPulling: 'ornith-ai/Ornith-1.0-9B-GGUF',
        },
      },
      { color: false }
    );
    expect(out).toContain('Run now');
    expect(out).toContain('gemma3:27b');
    expect(out).toContain('Worth pulling');
    expect(out).toContain('ornith-ai/Ornith-1.0-9B-GGUF');
  });

  it('omits a recommendation line whose side is empty', () => {
    const out = formatCheckTable(
      {
        ...sampleResult,
        recommendations: { runNow: 'gemma3:12b', runNowBigger: null, worthPulling: null },
      },
      { color: false }
    );
    expect(out).toContain('Run now');
    expect(out).not.toContain('Worth pulling');
  });

  it('says so plainly when a side is empty', () => {
    const out = formatCheckTable(
      {
        ...sampleResult,
        rows: [],
        recommendations: { runNow: null, runNowBigger: null, worthPulling: null },
      },
      { color: false }
    );
    expect(out).toContain('No models pulled yet');
    expect(out).toContain('No remote candidates found');
  });

  it('still pins --backend in the bench hint', () => {
    const out = formatCheckTable(
      { ...sampleResult, recommendations: { runNow: 'gemma3:12b', runNowBigger: null, worthPulling: null } },
      { color: false, backendId: 'ollama' }
    );
    expect(out).toContain('llamafit bench gemma3:12b --backend ollama');
  });
});
```

- [ ] **Step 2: Run and confirm they fail for the right reason**

Run: `npx vitest run test/format.test.ts -t "formatCheckTable sections"`
Expected: FAIL on structure (header text absent, `BASELINE` still present, no `SECTION_CAP` export) — not on import errors beyond `SECTION_CAP`.

- [ ] **Step 3: Add `expand` to `FormatOptions`**

In `src/format/bench.ts` (which owns the shared `FormatOptions`), add:

```ts
  /** Which section to render uncapped. Undefined caps both. */
  expand?: 'local' | 'remote' | 'all';
```

- [ ] **Step 4: Replace `formatCheckTable` wholesale**

In `src/format/check.ts`, delete the existing `formatCheckTable` body and put this in its place. `formatCheckJson` stays exactly as it is.

```ts
import type { CheckResult, CheckRow, FitGroup } from '../check.js';
import { label, dim } from '../colors.js';
import { columnWidths, formatRow } from './table.js';
import type { FormatOptions } from './bench.js';

/** Both sections get the same cap, so the local inventory gets no more room
 * than the remote list. */
export const SECTION_CAP = 5;

/** Best news first: the answer to "what should I run" leads, caveats follow. */
const GROUP_ORDER: readonly FitGroup[] = [
  'comfortable',
  'pressured',
  'tight',
  'over-budget',
  'will-thrash',
  'unclassified',
];

function gb(n: number): string {
  return `${n.toFixed(1)}G`;
}

/** 4489302 → "4.5M", 62682 → "63k". Download counts are a rough signal; full
 * precision would imply more than they carry. */
function compactCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function groupLabel(group: FitGroup, result: CheckResult): string {
  const b = gb(result.baselineHeadroomGb);
  const c = gb(result.currentHeadroomGb);
  switch (group) {
    case 'comfortable':
      return 'comfortable';
    case 'pressured':
      return `tight right now · only ${c} free, other apps are holding memory`;
    case 'tight':
      return `tight · close to the ${b} safe budget`;
    case 'over-budget':
      return `over the ${b} safe budget · fits right now, ${c} free`;
    case 'will-thrash':
      return "won't fit";
    case 'unclassified':
      return "unclassified · backend didn't report a size";
  }
}

/** Nulls last — a row with no footprint can't be ranked, and trailing it keeps
 * the "biggest first" reading of everything above it intact. */
function bySizeDesc(a: CheckRow, b: CheckRow): number {
  if (a.footprintGb === null) return b.footprintGb === null ? 0 : 1;
  if (b.footprintGb === null) return -1;
  return b.footprintGb - a.footprintGb;
}

/** Flattens to display order: group order first, size descending within each.
 * Capping then slices this list, so the cap is defined over the section rather
 * than per group — five rows means five rows, whatever mix of groups. */
function orderRows(rows: CheckRow[]): CheckRow[] {
  return GROUP_ORDER.flatMap((g) => rows.filter((r) => r.fit === g).sort(bySizeDesc));
}

function cells(r: CheckRow, withDownloads: boolean): string[] {
  const tags = r.alsoTagged?.length ? ` (${r.alsoTagged.join(', ')})` : '';
  const measured = r.estimateSource === 'measured';
  const raw = r.footprintGb !== null ? `${r.footprintGb.toFixed(1)}G` : '?';
  const out = [
    `${r.name}${tags}`,
    measured || r.footprintGb === null ? raw : `~${raw}`,
    r.quantizationLevel === null ? '?' : r.quantizationLevel + (r.quantKnown ? '' : '?'),
  ];
  if (withDownloads) {
    out.push(r.signals?.downloads != null ? `${compactCount(r.signals.downloads)} dl` : '');
  }
  return out;
}

function renderSection(
  title: string,
  rows: CheckRow[],
  result: CheckResult,
  o: {
    color: boolean;
    expanded: boolean;
    flag: string;
    emptyMessage: string;
    withDownloads: boolean;
    suffix?: string;
  }
): string[] {
  if (rows.length === 0) {
    return [label(`${title} (0)`, o.color), `  ${dim(o.emptyMessage, o.color)}`];
  }

  const ordered = orderRows(rows);
  const shown = o.expanded ? ordered : ordered.slice(0, SECTION_CAP);
  const hidden = ordered.length - shown.length;

  const count = hidden > 0 ? `${shown.length} of ${ordered.length}` : String(ordered.length);
  const suffix = o.suffix !== undefined ? `, ${o.suffix}` : '';
  const lines = [label(`${title} (${count}${suffix})`, o.color)];

  // Widths span the whole section so columns line up across group boundaries.
  const widths = columnWidths(shown.map((r) => cells(r, o.withDownloads)));

  for (const group of GROUP_ORDER) {
    const inGroup = shown.filter((r) => r.fit === group);
    if (inGroup.length === 0) continue;
    lines.push(`  ${dim(groupLabel(group, result), o.color)}`);
    for (const r of inGroup) {
      const c = cells(r, o.withDownloads);
      lines.push(`    ${formatRow(c, c, widths)}`.trimEnd());
    }
  }

  if (hidden > 0) {
    const sizes = ordered
      .slice(shown.length)
      .map((r) => r.footprintGb)
      .filter((f): f is number => f !== null);
    const range =
      sizes.length > 0
        ? `, ${gb(Math.min(...sizes))}–${gb(Math.max(...sizes))}`
        : '';
    lines.push(`    ${dim(`+${hidden} more${range}`, o.color)}${'  '}${dim(o.flag, o.color)}`);
  }

  return lines;
}

function renderRecommendations(result: CheckResult, color: boolean): string[] {
  const { runNow, runNowBigger, worthPulling } = result.recommendations;
  const find = (name: string): CheckRow | undefined =>
    result.rows.find((r) => r.name === name);
  const lines: string[] = [];

  if (runNow !== null) {
    const row = find(runNow);
    const size = row?.footprintGb != null ? ` · ${gb(row.footprintGb)}` : '';
    let text = `${runNow}${size} · safe bet`;
    if (runNowBigger !== null) {
      const big = find(runNowBigger);
      const bigSize = big?.footprintGb != null ? ` (${gb(big.footprintGb)})` : '';
      text += `. ${runNowBigger}${bigSize} is bigger and fits at this moment, but needs most of your free memory`;
    }
    lines.push(`${label('Run now', color)}        ${text}`);
  }

  if (worthPulling !== null) {
    const row = find(worthPulling);
    const parts = [worthPulling];
    if (row?.footprintGb != null) parts.push(gb(row.footprintGb));
    if (row?.quantizationLevel) parts.push(row.quantizationLevel);
    if (row?.signals?.downloads != null) {
      parts.push(`${compactCount(row.signals.downloads)} downloads`);
    }
    lines.push(`${label('Worth pulling', color)}  ${parts.join(' · ')}`);
  }

  return lines;
}

export function formatCheckTable(result: CheckResult, opts: FormatOptions = {}): string {
  const color = opts.color ?? false;
  const expand = opts.expand;
  const local = result.rows.filter((r) => r.source === 'local');
  const remote = result.rows.filter((r) => r.source === 'remote');

  // The header comes first because every verdict below is relative to these two
  // figures. Reserve is derived rather than hardcoded, and deliberately unnamed
  // by platform so a Linux probe needs no wording change here.
  const reserveGb = result.system.totalGb - result.baselineHeadroomGb;
  const lines: string[] = [
    `${gb(result.system.totalGb)} total  ·  ${gb(result.baselineHeadroomGb)} safe budget ` +
      `(−${gb(reserveGb)} reserve)  ·  ${gb(result.currentHeadroomGb)} free now ` +
      `(−${gb(result.system.wiredGb)} wired)`,
  ];

  const recs = renderRecommendations(result, color);
  if (recs.length > 0) lines.push('', ...recs);

  lines.push(
    '',
    ...renderSection('PULLED', local, result, {
      color,
      expanded: expand === 'local' || expand === 'all',
      flag: '--local',
      emptyMessage: 'No models pulled yet.',
      withDownloads: false,
    })
  );

  const sourceIds = result.remoteSources.filter((s) => s.ok).map((s) => s.id);
  lines.push(
    '',
    ...renderSection('PULLABLE', remote, result, {
      color,
      expanded: expand === 'remote' || expand === 'all',
      flag: '--remote',
      emptyMessage: 'No remote candidates found.',
      withDownloads: true,
      suffix: sourceIds.length > 0 ? `${sourceIds.join(' + ')}, by downloads` : undefined,
    })
  );

  // Legend, unchanged in spirit: only the lines that apply to rows on screen.
  const legend: string[] = [];
  if (result.rows.some((r) => r.estimateSource === 'estimated' && r.footprintGb !== null)) {
    legend.push('~ = estimated from parameter count and quantization (model not currently loaded)');
  }
  if (result.rows.some((r) => !r.quantKnown && r.quantizationLevel !== null)) {
    legend.push('? after QUANT = quantization not reported; assumed for the estimate');
  }
  if (result.rows.some((r) => r.parameterSizeB === null)) {
    legend.push(
      "? = backend couldn't report this model's size (llama-server only exposes GGUF metadata for models loaded at least once)"
    );
  }
  if (legend.length > 0) lines.push('', ...legend.map((l) => dim(l, color)));

  const failed = result.remoteSources.filter((s) => !s.ok);
  if (failed.length > 0) {
    lines.push(
      '',
      ...failed.map((s) => dim(`${s.id} failed: ${'error' in s ? s.error : 'unknown'}`, color))
    );
  }

  if (result.remoteGuidance != null) {
    lines.push(
      '',
      dim(
        'Remote candidates are unvetted — see remoteGuidance in --json for how to judge sources.',
        color
      )
    );
  }

  if (result.recommendations.runNow !== null) {
    const backendFlag = opts.backendId ? ` --backend ${opts.backendId}` : '';
    lines.push(
      '',
      dim(
        `Next: llamafit bench ${result.recommendations.runNow}${backendFlag} for real numbers on this machine.`,
        color
      )
    );
  }

  return lines.join('\n');
}
```

Deleted along the way: the `Remote model links:` block, the `Cloud models` block, the two trailing headroom lines (now the header), and the old `MODEL/SOURCE/PARAMS(B)/QUANT/FOOTPRINT(GB)/BASELINE/CURRENT` header row.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/format.test.ts`
Expected: PASS

- [ ] **Step 6: Refresh the guardrail snapshots and read them**

Run: `npx vitest run test/output-guardrail.test.ts -u`

Then **open `test/fixtures/guardrail-check-table.txt` and read it end to end.** This is the deliverable; a snapshot refreshed without being read proves nothing. Confirm: one header line, recommendations, two sections with group headers, no cloud block, no remote links block, no `BASELINE`/`CURRENT` columns.

- [ ] **Step 7: Full suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 8: Typecheck both configs**

Run: `npm run typecheck && npm run build`

- [ ] **Step 9: Commit**

```bash
git add src/format/check.ts test/format.test.ts test/fixtures/
git commit -m "feat: render check as ranked capped sections grouped by fit

Header line first (every verdict below is relative to it), explicit
recommendations, then PULLED and PULLABLE sections grouped by fit group with
a shared 5-row cap. Drops the remote links block (a real quant on the row
left it with only the URL), the two verdict columns (now group headers), and
the cloud models block (they run elsewhere, so they have no fit question)."
```

---

## Task 12: `cli-flags`

Wire `--local` / `--remote` / `--all` to the `expand` option so the `+N more` lines are actionable.

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `FormatOptions.expand` (Task 11)
- Produces: `CheckCommandOptions` gains `local?: boolean`, `remote?: boolean`, `all?: boolean`

- [ ] **Step 1: Write the failing test**

Add to `test/cli.test.ts`, following the existing harness in that file for capturing stdout:

```ts
it('--local uncaps the local section', async () => {
  const out: string[] = [];
  await runCheckCommand(
    { color: false, local: true },
    makeDeps({ stdout: (l) => out.push(l) })
  );
  expect(out.join('\n')).not.toMatch(/\+\d+ more, /);
});

it('--all uncaps both sections', async () => {
  const out: string[] = [];
  await runCheckCommand(
    { color: false, all: true },
    makeDeps({ stdout: (l) => out.push(l) })
  );
  expect(out.join('\n')).not.toContain('more');
});

it('rejects --local together with --remote', async () => {
  const err: string[] = [];
  let code: number | undefined;
  await runCheckCommand(
    { color: false, local: true, remote: true },
    makeDeps({ stderr: (l) => err.push(l), setExitCode: (c) => { code = c; } })
  );
  expect(err.join('\n')).toContain('--all');
  expect(code).toBe(1);
});
```

Reuse whatever dependency-construction helper `test/cli.test.ts` already defines instead of `makeDeps` if it is named differently.

- [ ] **Step 2: Run and confirm they fail for the right reason**

Run: `npx vitest run test/cli.test.ts -t uncaps`
Expected: FAIL — the options are ignored, `+N more` still present.

- [ ] **Step 3: Implement**

In `src/cli.ts`, add to `CheckCommandOptions`:

```ts
  local?: boolean;
  remote?: boolean;
  all?: boolean;
```

In `checkCommand`, before rendering:

```ts
  // Mutually exclusive by design: --local and --remote each mean "expand only
  // this one", so asking for both is asking for --all. Say that rather than
  // silently picking one.
  if (opts.local && opts.remote) {
    deps.stderr(
      error(`${label('Error:', color)} use --all to expand both sections`, color)
    );
    deps.setExitCode(1);
    return;
  }
  const expand = opts.all
    ? 'all'
    : opts.local
      ? 'local'
      : opts.remote
        ? 'remote'
        : undefined;
```

Pass `expand` through to `formatCheckTable(result, { color, backendId: backend.id, expand })`.

Register the flags on the `check` command and forward them:

```ts
    .option('--local', 'show the full local inventory, uncapped')
    .option('--remote', 'show the full remote candidate list, uncapped')
    .option('--all', 'show both sections uncapped')
```

Place the mutual-exclusion check **before** `resolve()` so a flag conflict fails fast without probing backends.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS

- [ ] **Step 5: Full suite and both typechecks**

Run: `npm test && npm run typecheck && npm run build`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: add --local/--remote/--all to expand capped sections

The +N more lines name a flag; this makes those flags real. --local with
--remote is rejected rather than silently resolved, since asking for both is
asking for --all."
```

---

## Task 13: `docs-and-live-verify`

Unit tests do not close this out. Per `CLAUDE.md`, the seam between pieces is where the bugs live — the `aba46a6` bug was exactly a copy-pasted hint resolving to the wrong backend.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

In the `## Usage` flag list, add `--local` / `--remote` / `--all`. In `## Reading the check table`, replace the two-verdict explanation with the fit-group model and the header line. Note that cloud models are listed in `--json` only. Keep the `### About "current headroom"` section as-is — it is still accurate and still load-bearing.

- [ ] **Step 2: Run the real thing**

Run: `npm run dev -- check`

Confirm, reading the actual output:
- One header line at the top with both headroom figures.
- No gap block, no diagnostics file written into the repo.
- No cloud models, no remote links block, no `BASELINE`/`CURRENT` columns.
- Remote candidates carry real quants (no `?`) and are ordered by downloads.
- The `yuxinlu1/gemma-4-12B-agentic` model appears **once**, in the local section, not also as a candidate.
- Total output is roughly 20 lines, not 80.

- [ ] **Step 3: Verify the expand flags against reality**

Run: `npm run dev -- check --local`, `npm run dev -- check --remote`, `npm run dev -- check --all`
Expected: the named section loses its `+N more` line and shows every row.

Run: `npm run dev -- check --local --remote`
Expected: `Error: use --all to expand both sections`, exit 1.

- [ ] **Step 4: Verify the `--query` path still uses the scraper**

Run: `npm run dev -- check --query gemma`
Expected: the sources footer names both `ollama.com search "gemma"` and `huggingface search "gemma"`.

- [ ] **Step 5: Run the printed `Next:` line verbatim**

Copy the `Next: llamafit bench …` line from Step 2's output and run it, substituting `npm run dev --` for `llamafit`. It must succeed against the backend it names. **This is the step that catches the class of bug `aba46a6` fixed** — do not skip it or approximate the command.

- [ ] **Step 6: Confirm `--json` is complete and uncapped**

Run: `npm run dev -- check --json | python3 -c "import json,sys; d=json.load(sys.stdin); print('rows:', len(d['rows'])); print('cloud:', len(d['cloudModels'])); print('recs:', d['recommendations']); print('fit keys:', sorted({r['fit'] for r in d['rows']}))"`

Expected: more rows than the capped text output showed, `cloudModels` still populated, `recommendations` present, and every row carrying a `fit` value.

- [ ] **Step 7: Full suite and both typechecks one final time**

Run: `npm test && npm run typecheck && npm run build`

- [ ] **Step 8: Commit**

```bash
git add README.md
git commit -m "docs: README covers the new check output and expand flags

Verified live against real ollama: 20 lines instead of 80, no gap block, real
quants on remote rows, the already-pulled candidate deduped, and the printed
Next: line run verbatim end to end."
```

- [ ] **Step 9: Close the taskwarrior item that partially landed**

```bash
task 23a848dd annotate "macOS-reserve wording and cloud-models label resolved by the check output redesign (2026-08-09 spec); modelPageUrl ollama-link item still open"
```

Do **not** mark it done — the `modelPageUrl` portion is untouched.

---

## Self-Review

**Spec coverage** — every spec section maps to a task:

| Spec item | Task |
| --- | --- |
| `drop-mlx-default` | 7 |
| `unknown-quant-sentinel` | 1 |
| `quant-from-tag` | 2 |
| `quant-from-available` | 4 |
| `rank-by-downloads` | 5 |
| `dedup-remote-against-local` | 6 |
| `collapse-local-by-digest` | 3 |
| `drop-non-chat` | 6 |
| Verdict grouping | 8 |
| Recommendations | 9 |
| Output format / caps / cloud removal | 11 |
| Flags | 12 |
| JSON contract | 8, 9 (additive), verified 13 |
| Module split | 10 |
| Error handling / diagnostics litter | 1 (gap stops firing), 13 (verified) |
| Testing | every task |

**Ordering constraints, all satisfied:** Task 3 (`digest-collapse`) after Task 2 (`quant-from-tag`), because the representative-tag rule reads the resolved quant. Task 6 (`remote-filter`) after Task 5 (`remote-rank`), since `recommendations` in Task 9 relies on remote rows arriving pre-sorted. Task 10 (`format-split`) before Task 11 (`render-sections`), so the rewrite happens in a clean module and the split itself is provably behaviour-preserving. Tasks 8–9 before 11, which consumes both.

**Type consistency check:** `FitGroup` and `fitGroup()` are defined in Task 8 and consumed in 9 and 11. `Recommendations` (with all three fields `runNow` / `runNowBigger` / `worthPulling`) is defined in Task 9 and consumed in 11 and 12. `columnWidths` / `padCell` / `formatRow` are defined in Task 10 and consumed in 11. `normalizeQuant` (Task 1) and `quantFromTag` (Task 2) are consumed in Task 3. `splitModelTag` is defined in Task 2 and consumed by both `quantFromTag` (Task 2) and `untagged` (Task 6) — one tag rule, one place, rather than two near-identical parsers.

**Required-field trap, twice.** Task 8 adds `fit` to `CheckRow` and Task 9 adds `recommendations` to `CheckResult`, both required. Vitest transpiles without typechecking, so `npm test` stays green while `npm run typecheck` fails — which is exactly why the Global Constraints insist on running both. Each task has an explicit step to fix the hand-built literals (9 in `test/format.test.ts`, 1 in `test/check.test.ts`), and Task 8's says to derive each `fit` from that literal's own verdicts rather than blanket-filling `'comfortable'`: `sampleResult` is `comfortable`/`will-thrash` → `'pressured'`, which a Task 11 test asserts.

**Snapshot churn is intentional and sequenced.** Tasks 1–9 each refresh `guardrail-*` and each step says what the diff must show, so a wrong change cannot hide behind a blanket `-u`. Task 10 is the exception and must produce **zero** snapshot change — that is what proves the split was a pure refactor.
