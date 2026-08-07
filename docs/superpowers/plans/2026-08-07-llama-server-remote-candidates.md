# llama-server remoteCandidates() Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the llama-server backend a `remoteCandidates()` backed by the Hugging Face Hub API — one request, trust signals + a qualification rubric instead of an allowlist, headroom-derived size cap, per-candidate quant lists.

**Architecture:** A shared HF discovery client (`src/hf/discovery.ts`) builds one `GET /api/models` request with six `expand[]`s and maps hits to candidates. The llama-server adapter maps candidates to `ModelInfo`; `check.ts` derives a parameter cap from baseline headroom (inverting the footprint formula), passes it through a new `RemoteCandidateOptions` arg, and emits a `remoteGuidance` rubric alongside per-row signals.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest, native `fetch`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-07-llama-server-remote-candidates-design.md` — read it first; its "API facts verified live" section is ground truth for the HF API.

## Global Constraints

- Task headers are kebab-case slugs; commits reference the slug, e.g. `feat: parse quants from sibling filenames (hf-quant-parser)`.
- Fixtures are real captured data, never hand-rolled (`docs/adapters.md` rule).
- `num_parameters` uses **raw integer** values (`max:16000000000`), never decimal `B` suffixes (unverified).
- Sort is `trendingScore` (`trending` returns HTTP 400).
- `expand[]` replaces HF's default field set — all six expands are required.
- Ollama backend behavior and output must stay byte-identical except the one additive `remoteGuidance: null` JSON field.
- Prefer under-reporting to fabricating: unparseable quant filenames are skipped, hits without `gguf.total` get `parameterSizeB: null`.
- Run all tests with `npx vitest run` (single file: `npx vitest run test/<file>.test.ts`).

---

### Task: hf-fixture-capture

**Files:**
- Create: `test/fixtures/hf-models-search.json`

**Interfaces:**
- Produces: the fixture every discovery test consumes. Real HF response, full production query shape.

- [ ] **Step 1: Capture the live response**

`-g` (globoff) is required — curl otherwise eats the `[]` in `expand[]`. The sandbox blocks huggingface.co; run with sandbox disabled if the first attempt fails with a network error.

```bash
cd <repo-root>
curl -gsS "https://huggingface.co/api/models?filter=gguf&pipeline_tag=text-generation&num_parameters=max:16000000000&sort=trendingScore&limit=10&expand[]=gguf&expand[]=siblings&expand[]=downloads&expand[]=likes&expand[]=lastModified&expand[]=trendingScore" -o test/fixtures/hf-models-search.json
```

- [ ] **Step 2: Sanity-check the capture**

```bash
node -e "const d=require('./test/fixtures/hf-models-search.json'); console.log(d.length, d[0].id, d[0].gguf?.total, d[0].siblings?.length, d[0].downloads)"
```

Expected: `10 <some/repo-id> <big integer or undefined> <integer> <integer>`. If the output is an error object instead of an array, the query shape regressed — stop and re-check against the spec's verified URL.

- [ ] **Step 3: Commit**

```bash
git add test/fixtures/hf-models-search.json
git commit -m "test: capture real HF models search response (hf-fixture-capture)"
```

---

### Task: hf-url-builder

**Files:**
- Create: `src/hf/discovery.ts`
- Create: `test/hf-discovery.test.ts`

**Interfaces:**
- Produces: `buildModelsUrl(query: string, opts?: HfDiscoveryOptions): string` and `interface HfDiscoveryOptions { maxParameterSizeB?: number; limit?: number }` (limit defaults to 10).

- [ ] **Step 1: Write the failing tests**

```ts
// test/hf-discovery.test.ts
import { describe, it, expect } from 'vitest';
import { buildModelsUrl } from '../src/hf/discovery.js';

describe('buildModelsUrl', () => {
  it('builds the full query with search, cap, and all six expands', () => {
    const url = buildModelsUrl('qwen', { maxParameterSizeB: 16 });
    expect(url).toContain('https://huggingface.co/api/models?');
    expect(url).toContain('search=qwen');
    expect(url).toContain('filter=gguf');
    expect(url).toContain('pipeline_tag=text-generation');
    // Raw integer param count — decimal "B" suffixes were never live-verified.
    expect(url).toContain('num_parameters=max%3A16000000000');
    expect(url).toContain('sort=trendingScore');
    expect(url).toContain('limit=10');
    for (const e of ['gguf', 'siblings', 'downloads', 'likes', 'lastModified', 'trendingScore']) {
      expect(url).toContain(`expand%5B%5D=${e}`);
    }
  });

  it('omits search when query is empty', () => {
    expect(buildModelsUrl('')).not.toContain('search=');
  });

  it('omits num_parameters when no cap is given', () => {
    expect(buildModelsUrl('qwen')).not.toContain('num_parameters');
  });

  it('floors fractional caps to whole params', () => {
    expect(buildModelsUrl('', { maxParameterSizeB: 11.6 })).toContain(
      'num_parameters=max%3A11600000000'
    );
  });

  it('honors a custom limit', () => {
    expect(buildModelsUrl('', { limit: 25 })).toContain('limit=25');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/hf-discovery.test.ts`
Expected: FAIL — cannot find module `../src/hf/discovery.js`.

- [ ] **Step 3: Implement**

```ts
// src/hf/discovery.ts
/** Shared Hugging Face Hub discovery client. llama-server consumes it today;
 * the ollama backend is a tracked fast-follow (as a second source alongside
 * its ollama.com scrape). Query shapes here were live-verified — see the
 * "API facts verified live" section of
 * docs/superpowers/specs/2026-08-07-llama-server-remote-candidates-design.md. */

export const HF_BASE_URL = 'https://huggingface.co';

export interface HfDiscoveryOptions {
  maxParameterSizeB?: number;
  limit?: number;
}

export function buildModelsUrl(query: string, opts: HfDiscoveryOptions = {}): string {
  const params = new URLSearchParams();
  if (query.length > 0) params.set('search', query);
  params.set('filter', 'gguf');
  params.set('pipeline_tag', 'text-generation');
  if (opts.maxParameterSizeB !== undefined) {
    // Raw integer form only — num_parameters=max:16000000000. Decimal "B"
    // suffixes were never live-verified against the API.
    params.set('num_parameters', `max:${Math.floor(opts.maxParameterSizeB * 1e9)}`);
  }
  // trendingScore, not the web UI's "trending" (that spelling returns HTTP 400).
  params.set('sort', 'trendingScore');
  params.set('limit', String(opts.limit ?? 10));
  // expand[] REPLACES the default field set, so everything needed downstream
  // must be requested explicitly.
  for (const field of ['gguf', 'siblings', 'downloads', 'likes', 'lastModified', 'trendingScore']) {
    params.append('expand[]', field);
  }
  return `${HF_BASE_URL}/api/models?${params.toString()}`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/hf-discovery.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hf/discovery.ts test/hf-discovery.test.ts
git commit -m "feat: HF models URL builder with verified query shape (hf-url-builder)"
```

---

### Task: hf-quant-parser

**Files:**
- Modify: `src/hf/discovery.ts` (append)
- Modify: `test/hf-discovery.test.ts` (append)

**Interfaces:**
- Produces: `parseQuantsFromSiblings(filenames: string[]): string[]` — uppercase quant ids, repo order, deduped, shards collapsed, mmproj files skipped, unparseable names skipped.

- [ ] **Step 1: Write the failing tests**

```ts
import { parseQuantsFromSiblings } from '../src/hf/discovery.js';

describe('parseQuantsFromSiblings', () => {
  it('parses standard K-quants and dedupes shards', () => {
    expect(
      parseQuantsFromSiblings([
        'Qwen3.5-9B-Q4_K_M.gguf',
        'Qwen3.5-9B-Q8_0-00001-of-00002.gguf',
        'Qwen3.5-9B-Q8_0-00002-of-00002.gguf',
      ])
    ).toEqual(['Q4_K_M', 'Q8_0']);
  });

  it('parses IQ, float, and unsloth UD- variants', () => {
    expect(
      parseQuantsFromSiblings([
        'model-IQ4_XS.gguf',
        'model.BF16.gguf',
        'model-F16.gguf',
        'model-UD-Q4_K_XL.gguf',
      ])
    ).toEqual(['IQ4_XS', 'BF16', 'F16', 'UD-Q4_K_XL']);
  });

  it('normalizes case to uppercase', () => {
    expect(parseQuantsFromSiblings(['model-q4_k_m.gguf'])).toEqual(['Q4_K_M']);
  });

  it('skips mmproj projector files (their F16 is not a model quant)', () => {
    expect(parseQuantsFromSiblings(['mmproj-F16.gguf', 'model-Q4_K_M.gguf'])).toEqual(['Q4_K_M']);
  });

  it('skips non-gguf and unparseable filenames rather than guessing', () => {
    expect(parseQuantsFromSiblings(['README.md', 'config.json', 'model.gguf'])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/hf-discovery.test.ts`
Expected: FAIL — `parseQuantsFromSiblings` is not exported.

- [ ] **Step 3: Implement**

```ts
// append to src/hf/discovery.ts

/** Quant token at the end of a .gguf filename, optionally sharded
 * (-00001-of-00002). Covers Q/IQ/TQ families, floats, MXFP4, and unsloth's
 * UD- dynamic quants. Unparseable names are skipped, never guessed. */
const QUANT_RE = /[-._]((?:UD-)?(?:I?Q|TQ)\d[A-Z0-9_]*|F16|F32|BF16|MXFP4)(?:-\d{5}-of-\d{5})?\.gguf$/i;

export function parseQuantsFromSiblings(filenames: string[]): string[] {
  const quants: string[] = [];
  for (const name of filenames) {
    // mmproj files are multimodal projectors riding along in the repo; their
    // F16/BF16 token describes the projector, not the model.
    if (name.startsWith('mmproj')) continue;
    const match = QUANT_RE.exec(name);
    if (!match) continue;
    const quant = match[1].toUpperCase();
    if (!quants.includes(quant)) quants.push(quant);
  }
  return quants;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/hf-discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hf/discovery.ts test/hf-discovery.test.ts
git commit -m "feat: parse quants from sibling filenames (hf-quant-parser)"
```

---

### Task: hf-hit-mapping

**Files:**
- Modify: `src/hf/discovery.ts` (append)
- Modify: `test/hf-discovery.test.ts` (append)

**Interfaces:**
- Produces:

```ts
export interface HfSignals {
  downloads: number | null;
  likes: number | null;
  trendingScore: number | null;
  lastModified: string | null;
}
export interface HfModelHit {
  id: string;
  gguf?: { total?: number } | null;
  siblings?: { rfilename: string }[] | null;
  downloads?: number;
  likes?: number;
  trendingScore?: number;
  lastModified?: string;
}
export interface HfCandidate {
  repoId: string;          // "unsloth/Qwen3.5-9B-GGUF"
  author: string;          // "unsloth"
  url: string;             // "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF"
  parameterSizeB: number | null;  // gguf.total / 1e9; null when absent
  availableQuants: string[];
  signals: HfSignals;
}
export function mapHitToCandidate(hit: HfModelHit): HfCandidate
```

- [ ] **Step 1: Write the failing tests** (fixture-driven, per the "real captured data" rule — mirror `test/scrape.test.ts`'s loadFixture pattern)

```ts
import { readFileSync } from 'node:fs';
import { mapHitToCandidate, type HfModelHit } from '../src/hf/discovery.js';

function loadHits(): HfModelHit[] {
  return JSON.parse(
    readFileSync(new URL('./fixtures/hf-models-search.json', import.meta.url), 'utf-8')
  ) as HfModelHit[];
}

describe('mapHitToCandidate', () => {
  const hits = loadHits();
  const candidates = hits.map(mapHitToCandidate);

  it('maps every fixture hit', () => {
    expect(candidates.length).toBe(hits.length);
    for (const c of candidates) {
      expect(c.repoId).toMatch(/^[^/]+\/[^/]+$/);
      expect(c.author).toBe(c.repoId.split('/')[0]);
      expect(c.url).toBe(`https://huggingface.co/${c.repoId}`);
    }
  });

  it('derives parameterSizeB from gguf.total in billions', () => {
    const withGguf = hits.find((h) => h.gguf?.total);
    expect(withGguf).toBeDefined();
    const c = mapHitToCandidate(withGguf!);
    expect(c.parameterSizeB).toBeCloseTo(withGguf!.gguf!.total! / 1e9, 6);
  });

  it('maps a hit without gguf metadata to null params (dropped later, not guessed)', () => {
    const c = mapHitToCandidate({ id: 'someone/mystery-GGUF' });
    expect(c.parameterSizeB).toBeNull();
    expect(c.availableQuants).toEqual([]);
    expect(c.signals).toEqual({
      downloads: null,
      likes: null,
      trendingScore: null,
      lastModified: null,
    });
  });

  it('carries signals through from the fixture', () => {
    const withDownloads = hits.find((h) => typeof h.downloads === 'number')!;
    const c = mapHitToCandidate(withDownloads);
    expect(c.signals.downloads).toBe(withDownloads.downloads);
  });

  it('extracts quants from fixture siblings', () => {
    const withSiblings = hits.find((h) => (h.siblings ?? []).some((s) => /q\d/i.test(s.rfilename)));
    expect(withSiblings).toBeDefined();
    expect(mapHitToCandidate(withSiblings!).availableQuants.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/hf-discovery.test.ts`
Expected: FAIL — `mapHitToCandidate` is not exported.

- [ ] **Step 3: Implement**

```ts
// append to src/hf/discovery.ts

export interface HfSignals {
  downloads: number | null;
  likes: number | null;
  trendingScore: number | null;
  lastModified: string | null;
}

export interface HfModelHit {
  id: string;
  gguf?: { total?: number } | null;
  siblings?: { rfilename: string }[] | null;
  downloads?: number;
  likes?: number;
  trendingScore?: number;
  lastModified?: string;
}

export interface HfCandidate {
  repoId: string;
  author: string;
  url: string;
  parameterSizeB: number | null;
  availableQuants: string[];
  signals: HfSignals;
}

export function mapHitToCandidate(hit: HfModelHit): HfCandidate {
  const total = hit.gguf?.total;
  return {
    repoId: hit.id,
    author: hit.id.split('/')[0],
    url: `${HF_BASE_URL}/${hit.id}`,
    // For MoE repos gguf.total is total params, not active — accepted
    // approximation, consistent with localModels() reporting meta.n_params.
    parameterSizeB: typeof total === 'number' ? total / 1e9 : null,
    availableQuants: parseQuantsFromSiblings((hit.siblings ?? []).map((s) => s.rfilename)),
    signals: {
      downloads: hit.downloads ?? null,
      likes: hit.likes ?? null,
      trendingScore: hit.trendingScore ?? null,
      lastModified: hit.lastModified ?? null,
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/hf-discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hf/discovery.ts test/hf-discovery.test.ts
git commit -m "feat: map HF hits to candidates with signals and quants (hf-hit-mapping)"
```

---

### Task: hf-fetch

**Files:**
- Modify: `src/hf/discovery.ts` (append)
- Modify: `test/hf-discovery.test.ts` (append)

**Interfaces:**
- Consumes: `buildModelsUrl`, `mapHitToCandidate`.
- Produces: `searchGgufModels(query: string, opts?: HfDiscoveryOptions): Promise<HfCandidate[]>` — throws `Error` with status-aware message on non-200 (429 named explicitly); network errors propagate. `check.ts` already converts throws into a `scrape-failed` gap.

- [ ] **Step 1: Write the failing tests** (stub global fetch — same technique as the existing client tests; check `test/ollama-client.test.ts` for the house pattern and mirror it)

```ts
import { vi, afterEach } from 'vitest';
import { searchGgufModels } from '../src/hf/discovery.js';

describe('searchGgufModels', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the built URL and maps hits', async () => {
    const hits = loadHits();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(hits), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const candidates = await searchGgufModels('qwen', { maxParameterSizeB: 16 });
    expect(candidates.length).toBe(hits.length);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('search=qwen');
    expect(calledUrl).toContain('num_parameters=max%3A16000000000');
  });

  it('names the rate limit on 429', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
    await expect(searchGgufModels('')).rejects.toThrow(/rate limit/i);
  });

  it('throws a status-aware error on other non-200s', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
    await expect(searchGgufModels('')).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/hf-discovery.test.ts`
Expected: FAIL — `searchGgufModels` is not exported.

- [ ] **Step 3: Implement**

```ts
// append to src/hf/discovery.ts

export async function searchGgufModels(
  query: string,
  opts: HfDiscoveryOptions = {}
): Promise<HfCandidate[]> {
  const url = buildModelsUrl(query, opts);
  const res = await fetch(url);
  if (res.status === 429) {
    throw new Error(
      'Hugging Face API rate limit hit (anonymous: 500 requests per 5 minutes) — wait and retry'
    );
  }
  if (!res.ok) {
    throw new Error(`Hugging Face API returned ${res.status} for ${url}`);
  }
  const hits = (await res.json()) as HfModelHit[];
  return hits.map(mapHitToCandidate);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/hf-discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hf/discovery.ts test/hf-discovery.test.ts
git commit -m "feat: HF search fetch with status-aware errors (hf-fetch)"
```

---

### Task: adapter-wiring

**Files:**
- Modify: `src/types.ts` (ModelInfo additions + new RemoteSignals)
- Modify: `src/backends/types.ts` (RemoteCandidateOptions, remoteCandidates signature)
- Modify: `src/backends/llama-server/index.ts`
- Modify: `test/llama-server-backend.test.ts` (append)
- Check: `docs/adapters.md` — if it documents the `remoteCandidates` signature, update it to the two-arg form.

**Interfaces:**
- Consumes: `searchGgufModels`, `HfCandidate` from `src/hf/discovery.js`.
- Produces:

```ts
// src/types.ts
export interface RemoteSignals {
  downloads: number | null;
  likes: number | null;
  trendingScore: number | null;
  lastModified: string | null;
}
// ModelInfo gains (all optional; local rows and ollama leave them unset):
//   author?: string | null;
//   availableQuants?: string[];
//   signals?: RemoteSignals | null;

// src/backends/types.ts
export interface RemoteCandidateOptions { maxParameterSizeB?: number }
// Backend.remoteCandidates becomes:
//   remoteCandidates?(query?: string, opts?: RemoteCandidateOptions): Promise<ModelInfo[]>;
```

- The llama-server backend exports `mapCandidatesToModelInfo(candidates: HfCandidate[]): ModelInfo[]` and registers `remoteCandidates`.
- Note: ollama's `async function remoteCandidates(query = '')` needs **no change** — a narrower function is assignable to the two-arg optional signature; it simply ignores `opts`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to test/llama-server-backend.test.ts
import { mapCandidatesToModelInfo } from '../src/backends/llama-server/index.js';
import type { HfCandidate } from '../src/hf/discovery.js';

describe('mapCandidatesToModelInfo', () => {
  const candidate: HfCandidate = {
    repoId: 'unsloth/Qwen3.5-9B-GGUF',
    author: 'unsloth',
    url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF',
    parameterSizeB: 8.95,
    availableQuants: ['Q4_K_M', 'Q8_0'],
    signals: { downloads: 986097, likes: 120, trendingScore: 13, lastModified: '2026-08-01T00:00:00.000Z' },
  };

  it('maps a candidate to a remote ModelInfo', () => {
    const [info] = mapCandidatesToModelInfo([candidate]);
    expect(info).toEqual({
      name: 'unsloth/Qwen3.5-9B-GGUF',
      source: 'remote',
      url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF',
      parameterSizeB: 8.95,
      // Repos ship many quants; no single quant describes the repo. The
      // estimator's fallback covers the estimate, availableQuants covers pulling.
      quantizationLevel: null,
      diskSizeBytes: null,
      author: 'unsloth',
      availableQuants: ['Q4_K_M', 'Q8_0'],
      signals: candidate.signals,
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/llama-server-backend.test.ts`
Expected: FAIL — `mapCandidatesToModelInfo` is not exported.

- [ ] **Step 3: Implement the type changes**

In `src/types.ts`, add after `ModelInfo`:

```ts
export interface RemoteSignals {
  downloads: number | null;
  likes: number | null;
  trendingScore: number | null;
  lastModified: string | null;
}
```

and extend `ModelInfo` with:

```ts
  // Remote-discovery metadata. Optional: local rows and backends without
  // signal support leave them unset, which also keeps their JSON output
  // byte-identical (JSON.stringify omits absent keys).
  author?: string | null;
  availableQuants?: string[];
  signals?: RemoteSignals | null;
```

In `src/backends/types.ts`, add above `Backend`:

```ts
export interface RemoteCandidateOptions {
  /** Server-side size filter — candidates above this are never fetched. */
  maxParameterSizeB?: number;
}
```

and change the `remoteCandidates` line to:

```ts
  remoteCandidates?(query?: string, opts?: RemoteCandidateOptions): Promise<ModelInfo[]>;
```

- [ ] **Step 4: Implement the adapter**

In `src/backends/llama-server/index.ts`:

```ts
import { searchGgufModels, type HfCandidate } from '../../hf/discovery.js';
import type { RemoteCandidateOptions } from '../types.js';

export function mapCandidatesToModelInfo(candidates: HfCandidate[]): ModelInfo[] {
  return candidates.map((c) => ({
    name: c.repoId,
    source: 'remote',
    url: c.url,
    parameterSizeB: c.parameterSizeB,
    quantizationLevel: null,
    diskSizeBytes: null,
    author: c.author,
    availableQuants: c.availableQuants,
    signals: c.signals,
  }));
}

async function remoteCandidates(query = '', opts: RemoteCandidateOptions = {}): Promise<ModelInfo[]> {
  return mapCandidatesToModelInfo(
    await searchGgufModels(query, { maxParameterSizeB: opts.maxParameterSizeB })
  );
}
```

Register `remoteCandidates` in the `llamaServerBackend` object and delete the stale `remoteCandidates() is a tracked fast-follow.` sentence from the doc comment above it.

- [ ] **Step 5: Run to verify pass, plus the whole suite for type fallout**

Run: `npx vitest run test/llama-server-backend.test.ts` then `npx vitest run`
Expected: PASS everywhere — in particular `ollama-backend.test.ts` untouched and green (signature widening is backward-compatible).

- [ ] **Step 6: Update docs/adapters.md if it names remoteCandidates**

```bash
grep -n "remoteCandidates" docs/adapters.md
```

If it shows the one-arg signature, update it to `remoteCandidates?(query?: string, opts?: RemoteCandidateOptions)` with a one-line note that `opts.maxParameterSizeB` is a server-side size filter backends may ignore.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/backends/types.ts src/backends/llama-server/index.ts test/llama-server-backend.test.ts docs/adapters.md
git commit -m "feat: wire HF discovery into llama-server remoteCandidates (adapter-wiring)"
```

---

### Task: cap-derivation

**Files:**
- Modify: `src/estimators/formula.ts` (append)
- Modify: `test/formula-estimator.test.ts` (append)

**Interfaces:**
- Consumes: `loadQuantTable`, `lookupQuant`, `loadCalibration` from `src/data.js` (already imported in formula.ts).
- Produces: `maxCandidateParamsB(headroomGb: number): number` — the largest parameter count (in billions) whose estimated footprint at the fallback quant fits the given headroom. Exact inverse of the estimator's formula.

- [ ] **Step 1: Write the failing test**

```ts
// append to test/formula-estimator.test.ts
import { maxCandidateParamsB, formulaEstimator } from '../src/estimators/formula.js';

describe('maxCandidateParamsB', () => {
  it('round-trips through the estimate formula at the fallback quant', () => {
    const headroomGb = 24;
    const capB = maxCandidateParamsB(headroomGb);
    // A model exactly at the cap, with no quant reported (falls back to the
    // same table entry the cap derivation used), lands exactly on headroom.
    const estimate = formulaEstimator.estimate(
      { parameterSizeB: capB, quantizationLevel: null },
      { baselineHeadroomGb: headroomGb, currentHeadroomGb: headroomGb }
    );
    expect(estimate.footprintGb).toBeCloseTo(headroomGb, 6);
  });

  it('scales linearly with headroom', () => {
    expect(maxCandidateParamsB(32)).toBeCloseTo(maxCandidateParamsB(16) * 2, 6);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/formula-estimator.test.ts`
Expected: FAIL — `maxCandidateParamsB` is not exported.

- [ ] **Step 3: Implement**

```ts
// append to src/estimators/formula.ts

/** Inverse of the estimate formula at the fallback quant: the largest
 * parameter count (billions) whose estimated footprint fits headroomGb.
 * Used by check.ts to size-cap remote discovery server-side. */
export function maxCandidateParamsB(headroomGb: number): number {
  const fallback = lookupQuant(loadQuantTable(), '');
  return headroomGb / (fallback.bytesPerParam * loadCalibration().overheadMultiplier);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/formula-estimator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/estimators/formula.ts test/formula-estimator.test.ts
git commit -m "feat: derive candidate size cap by inverting the footprint formula (cap-derivation)"
```

---

### Task: check-flow

**Files:**
- Create: `src/hf/guidance.ts`
- Modify: `src/check.ts`
- Modify: `test/check.test.ts` (append)
- Modify: `test/fixtures/guardrail-check.json` (one additive key)

**Interfaces:**
- Consumes: `maxCandidateParamsB` from `src/estimators/formula.js`; `RemoteSignals` from `src/types.js`; `REMOTE_GUIDANCE` from `src/hf/guidance.js`.
- Produces: `CheckRow` gains `author?: string | null`, `availableQuants?: string[]`, `signals?: RemoteSignals | null`. `CheckResult` gains `remoteGuidance: string | null` (always present, `null` when no remote row carries signals). `runCheck` passes `{ maxParameterSizeB }` derived from baseline headroom to `backend.remoteCandidates`.

- [ ] **Step 1: Write the rubric constant**

```ts
// src/hf/guidance.ts
/** Emitted as CheckResult.remoteGuidance whenever remote candidates carry
 * trust signals. The named orgs are examples illustrating the criteria, NOT
 * an allowlist — deliberate decision, see the spec's "no allowlist" bullet. */
export const REMOTE_GUIDANCE = `Remote candidates come from the Hugging Face Hub (trending, size-capped to this machine's headroom) and are NOT vetted. Qualify the source before pulling:
- Trustworthy: official model-vendor orgs (Qwen, meta-llama, google, microsoft, LiquidAI) and quant houses with a history across many model families (examples: ggml-org, bartowski, unsloth, lmstudio-community). A verified-org badge on the repo page is a good sign.
- Distrust: single-model orgs; names stuffed with "uncensored"/"abliterated"/merge word salad; download counts wildly out of proportion to likes and account age — download counts are botted in practice, never trust them alone.
Each candidate lists availableQuants; pull as <owner>/<repo>:<QUANT>.`;
```

- [ ] **Step 2: Write the failing tests**

Follow the existing stub-backend pattern in `test/check.test.ts` (it builds `CheckDeps` with fake backend/probe/estimator — reuse its helpers rather than inventing new ones). Add:

```ts
// append to test/check.test.ts
import { REMOTE_GUIDANCE } from '../src/hf/guidance.js';
import { maxCandidateParamsB } from '../src/estimators/formula.js';

describe('remote candidate signals and guidance', () => {
  it('passes a headroom-derived cap to remoteCandidates', async () => {
    const seen: unknown[] = [];
    // Build deps exactly as the surrounding tests do, with a backend whose
    // remoteCandidates records its arguments:
    //   remoteCandidates: async (query, opts) => { seen.push([query, opts]); return []; }
    const result = await runCheck('', deps);
    const [, opts] = seen[0] as [string, { maxParameterSizeB?: number }];
    expect(opts.maxParameterSizeB).toBeCloseTo(maxCandidateParamsB(result.baselineHeadroomGb), 6);
  });

  it('copies author, quants, and signals onto remote rows and sets guidance', async () => {
    // Backend returns one remote ModelInfo carrying:
    //   author: 'unsloth', availableQuants: ['Q4_K_M'],
    //   signals: { downloads: 1, likes: 2, trendingScore: 3, lastModified: 'x' },
    //   parameterSizeB: 9 (so it survives the null-params filter)
    const result = await runCheck('', deps);
    const remote = result.rows.find((r) => r.source === 'remote')!;
    expect(remote.author).toBe('unsloth');
    expect(remote.availableQuants).toEqual(['Q4_K_M']);
    expect(remote.signals?.downloads).toBe(1);
    expect(result.remoteGuidance).toBe(REMOTE_GUIDANCE);
  });

  it('leaves guidance null for signal-less backends (ollama-shaped)', async () => {
    // Backend returns a remote ModelInfo WITHOUT author/availableQuants/signals
    const result = await runCheck('', deps);
    expect(result.remoteGuidance).toBeNull();
    const remote = result.rows.find((r) => r.source === 'remote')!;
    expect(remote.signals).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/check.test.ts`
Expected: FAIL — `remoteGuidance` missing from CheckResult, opts never passed.

- [ ] **Step 4: Implement in src/check.ts**

- Add to `CheckRow`: `author?: string | null; availableQuants?: string[]; signals?: RemoteSignals | null;` (import `RemoteSignals` from `./types.js`).
- Add to `CheckResult`: `remoteGuidance: string | null;`
- Import `maxCandidateParamsB` from `./estimators/formula.js` and `REMOTE_GUIDANCE` from `./hf/guidance.js`.
- Change the fetch call (headroom is already computed above it):

```ts
remoteCandidates =
  (await backend.remoteCandidates?.(query, {
    // Baseline headroom, not current: discovery shows what the machine can
    // run, not what this moment's memory pressure allows.
    maxParameterSizeB: maxCandidateParamsB(baselineHeadroomGb),
  })) ?? [];
```

- In the `remoteRows` map, spread the metadata through (only set keys the candidate actually has, so signal-less backends serialize identically to today):

```ts
return {
  name: c.name,
  source: 'remote',
  url: c.url,
  parameterSizeB: c.parameterSizeB,
  quantizationLevel: estimate.quantUsedForEstimate,
  footprintGb: estimate.footprintGb,
  estimateSource: 'estimated',
  quantKnown: estimate.quantKnown,
  baselineVerdict: estimate.baselineVerdict,
  currentVerdict: estimate.currentVerdict,
  ...(c.author !== undefined ? { author: c.author } : {}),
  ...(c.availableQuants !== undefined ? { availableQuants: c.availableQuants } : {}),
  ...(c.signals !== undefined ? { signals: c.signals } : {}),
};
```

- In the return object add:

```ts
remoteGuidance: remoteCandidates.some((c) => c.signals != null) ? REMOTE_GUIDANCE : null,
```

- [ ] **Step 5: Update the JSON guardrail fixture**

`formatCheckJson` serializes the whole `CheckResult`, so the new always-present field appears in `check --json` output. Add `"remoteGuidance": null` as the **last** key of `test/fixtures/guardrail-check.json` (key order follows the return-object insertion order). This is the one deliberate, additive output change the spec allows.

- [ ] **Step 6: Run to verify pass, plus the full suite**

Run: `npx vitest run`
Expected: PASS — including `output-guardrail.test.ts` with the updated fixture and byte-identical table output.

- [ ] **Step 7: Commit**

```bash
git add src/hf/guidance.ts src/check.ts test/check.test.ts test/fixtures/guardrail-check.json
git commit -m "feat: headroom-capped discovery with signals and guidance in check (check-flow)"
```

---

### Task: query-default

The CLI's `-q, --query` option hard-defaults to `'mlx'` with help text "remote search query on ollama.com" — an ollama-ism. Searching HF for "mlx" (Apple's non-GGUF format) would return garbage for llama-server. The default must become per-backend: `'mlx'` for ollama (preserving today's behavior exactly), `''` (bare trending) for everything else.

**Files:**
- Modify: `src/cli.ts` (option definition ~line 471, `CheckCommandOptions` ~line 308, the per-backend loop ~line 338)
- Modify: `test/cli.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `CheckCommandOptions.query` becomes `query?: string`; `runCheck` receives `opts.query ?? (backend.id === 'ollama' ? 'mlx' : '')`.

- [ ] **Step 1: Write the failing test**

Use the existing harness (`fixtureBackend`/`createCliDeps` from `test/helpers/fixture-backend.js`, and note `CHECK_OPTS` at line ~79 pins `query: 'mlx'` explicitly — leave it; it still typechecks against `query?: string`). Append:

```ts
// append to test/cli.test.ts
describe('per-backend query default', () => {
  it('defaults to mlx for ollama and empty for other backends when --query is not given', async () => {
    const seen: Array<[string, string | undefined]> = [];
    // Two fixture backends in deps, ids 'ollama' and 'llama-server', each with
    //   remoteCandidates: async (q) => { seen.push([<id>, q]); return []; }
    // following the fixtureBackend helper's construction pattern.
    await runCheckCommand({ color: false }, deps);
    expect(seen).toContainEqual(['ollama', 'mlx']);
    expect(seen).toContainEqual(['llama-server', '']);
  });

  it('an explicit --query overrides both', async () => {
    await runCheckCommand({ query: 'qwen', color: false }, deps);
    expect(seen.map(([, q]) => q)).toEqual(['qwen', 'qwen']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — `query: 'mlx'` reaches every backend (and the missing-`query` call may not typecheck until Step 3).

- [ ] **Step 3: Implement**

In `src/cli.ts`:

- Option definition: drop the default and de-ollama the help text:

```ts
.option('-q, --query <query>', 'remote model search query (backend default when omitted)')
```

- `CheckCommandOptions`: `query?: string;`
- In the per-backend loop, replace `opts.query` with:

```ts
// 'mlx' is the historical ollama.com search default; HF-backed backends get
// bare trending. An explicit --query overrides both.
const query = opts.query ?? (backend.id === 'ollama' ? 'mlx' : '');
```

and pass `query` to `runCheck`.

- [ ] **Step 4: Run to verify pass, plus the full suite**

Run: `npx vitest run`
Expected: PASS — existing cli tests keep passing because `CHECK_OPTS` still passes `query: 'mlx'` explicitly.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "fix: per-backend remote query default, mlx is ollama-only (query-default)"
```

---

### Task: table-output

**Files:**
- Modify: `src/format.ts` (formatCheckTable only)
- Modify: `test/format.test.ts` (append)

**Interfaces:**
- Consumes: `CheckRow.availableQuants`, `CheckResult.remoteGuidance` from check-flow.
- Produces: remote-link lines gain a compact quant list (first 4, then `+N more`); a dim footer appears when `remoteGuidance` is set. No new table columns.

- [ ] **Step 1: Write the failing tests**

Follow the existing fixture-building helpers in `test/format.test.ts` (it constructs `CheckResult` objects inline — reuse that shape, remembering `remoteGuidance` is now required on `CheckResult`).

```ts
// append to test/format.test.ts
describe('remote candidate rendering', () => {
  it('appends a truncated quant list to remote link lines', () => {
    // CheckResult with one remote row: availableQuants:
    //   ['Q4_K_M', 'Q5_K_M', 'Q8_0', 'F16', 'BF16', 'IQ4_XS'], url set
    const out = formatCheckTable(result);
    expect(out).toContain('quants: Q4_K_M, Q5_K_M, Q8_0, F16, +2 more');
  });

  it('omits the quant note when a remote row has none', () => {
    // remote row with availableQuants undefined (ollama-shaped)
    const out = formatCheckTable(result);
    expect(out).not.toContain('quants:');
  });

  it('prints a guidance footer only when remoteGuidance is set', () => {
    // once with remoteGuidance: REMOTE_GUIDANCE, once with null
    expect(formatCheckTable(withGuidance)).toContain('see remoteGuidance in --json');
    expect(formatCheckTable(withoutGuidance)).not.toContain('remoteGuidance');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/format.test.ts`
Expected: FAIL on all three.

- [ ] **Step 3: Implement in formatCheckTable**

In the existing `remoteLinks` loop, append the quant list to each line:

```ts
for (const r of remoteLinks) {
  const quants = r.availableQuants ?? [];
  const shown = quants.slice(0, 4).join(', ');
  const extra = quants.length > 4 ? `, +${quants.length - 4} more` : '';
  const quantNote = quants.length > 0 ? ` (quants: ${shown}${extra})` : '';
  lines.push(`  ${r.name} → ${dim(r.url as string, color)}${quantNote}`);
}
```

After that block, add:

```ts
if (result.remoteGuidance !== null) {
  lines.push(
    '',
    dim('Remote candidates are unvetted — see remoteGuidance in --json for how to judge sources.', color)
  );
}
```

- [ ] **Step 4: Run to verify pass, plus guardrails**

Run: `npx vitest run test/format.test.ts` then `npx vitest run`
Expected: PASS. `guardrail-check-table.txt` must NOT need changes — its fixture is ollama-shaped (no quants, null guidance), and if it fails, the no-op path is leaking output; fix the code, not the fixture.

- [ ] **Step 5: Commit**

```bash
git add src/format.ts test/format.test.ts
git commit -m "feat: show candidate quants and guidance pointer in check table (table-output)"
```

---

### Task: live-verification

**Files:**
- Possibly refresh: `test/fixtures/hf-models-search.json`

No code changes expected — this validates the shipped behavior against the real HF API and the real router, per the repo's live-verification-before-merge pattern (docs lie; the pull() work proved it).

- [ ] **Step 1: Build and run check against the live router**

The test router from the previous session may still be on :8080 (Qwen 0.5B cached); otherwise start one: `llama-server` (no flags, router mode).

```bash
npx tsx src/cli.ts check --backend llama-server
npx tsx src/cli.ts check --backend llama-server --json | tail -40
npx tsx src/cli.ts check --backend llama-server --query qwen
```

Verify by hand:
- remote rows appear with real params, author, quants, and signals
- every remote row's `parameterSizeB` ≤ the machine's cap (server-side filter worked)
- `remoteGuidance` is present in JSON; table shows the quant lists + footer
- no `scrape-failed` gap fired

- [ ] **Step 2: Confirm the six-expand composition is still live-accurate**

```bash
curl -gsS "https://huggingface.co/api/models?filter=gguf&pipeline_tag=text-generation&num_parameters=max:16000000000&sort=trendingScore&limit=3&expand[]=gguf&expand[]=siblings&expand[]=downloads&expand[]=likes&expand[]=lastModified&expand[]=trendingScore" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);console.log(a.map(h=>[h.id,h.gguf?.total,h.siblings?.length,h.downloads,h.trendingScore,h.lastModified].join(' | ')).join('\n'))})"
```

Expected: three rows, each with id, gguf.total, sibling count, downloads, trendingScore, lastModified all populated. If the shape drifted from the fixture, recapture the fixture (hf-fixture-capture Step 1), rerun the full suite, and fix any real breakage before proceeding.

- [ ] **Step 3: Run the full suite one final time**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 4: Commit anything the verification changed, then close out**

```bash
git add -A && git diff --cached --quiet || git commit -m "test: refresh HF fixture from live verification (live-verification)"
task 4212cb92 done
```

Merge/push per the repo pattern (merge to main locally, push right away — see `superpowers:finishing-a-development-branch`).
