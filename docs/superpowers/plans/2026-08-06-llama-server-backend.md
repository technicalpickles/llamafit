# llama-server Backend Adapter (Router Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `Backend` for llama.cpp's `llama-server` in router mode — `detect()`, `localModels()`, `generate()`, `unload()` only — closing taskwarrior `fc0885b9`.

**Architecture:** Mirrors `src/backends/ollama/`: a `client.ts` with wire types + fetch helpers, an `index.ts` with pure mapping functions plus the `Backend` object, registered in `src/backends/registry.ts`. All fixtures are real captures from a live router instance (already taken, in `.parkinglot/llama-server-captures/`). Spec: `docs/superpowers/specs/2026-08-06-llama-server-backend-design.md`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest, no runtime deps — `fetch` is global.

## Global Constraints

- Router mode only. Classic single-instance mode is a non-goal; no code accommodates it.
- Do NOT implement `loadedModels()`, `remoteCandidates()`, or `pull()`. Omit the keys entirely (do not export `loadedModels: undefined` — the conformance suite catches that).
- Base URL: `LLAMA_SERVER_BASE_URL` env var, default `http://localhost:8080`, with the same scheme-prefixing logic as `OLLAMA_HOST` in `src/backends/ollama/client.ts`.
- Fixtures are copied **verbatim** from `.parkinglot/llama-server-captures/*.json` — never hand-edited (docs/adapters.md "real captured data" rule).
- Tests make no network calls: stub `globalThis.fetch` in `beforeEach`, restore in `afterEach`, exactly like `test/ollama-backend.test.ts`.
- `generate()` resolves `null` on timeout — never throws on abort (Backend interface contract).
- `detect()` never rejects — network errors resolve to `{detected: false, ..., evidence: {error}}`.
- Every commit: `npm test` and `npm run typecheck` both pass.
- Import style: relative imports end in `.js` (ESM), types imported with `import type`.

---

### fixtures-and-client

**Files:**
- Create: `test/fixtures/llama-server-*.json` (10 files, copied from `.parkinglot/llama-server-captures/`)
- Create: `src/backends/llama-server/client.ts`
- Test: `test/llama-server-client.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces (later tasks import these from `client.js`):
  - `LLAMA_SERVER_BASE_URL: string`
  - `interface LlamaServerModelMeta { n_params: number; size: number; ftype: string; ... }`
  - `interface LlamaServerModel { id: string; status: { value: string }; meta?: LlamaServerModelMeta; ... }`
  - `interface LlamaServerModelsResponse { data: LlamaServerModel[]; object: string }`
  - `interface LlamaServerCompletionResponse { content: string; model: string; timings: LlamaServerCompletionTimings }`
  - `interface LlamaServerPropsResponse { build_info?: string; role?: string }`
  - `fetchModels(): Promise<LlamaServerModelsResponse>`
  - `fetchProps(): Promise<LlamaServerPropsResponse>`
  - `completion(model: string, prompt: string, timeoutMs?: number): Promise<LlamaServerCompletionResponse | null>`
  - `unloadModel(model: string): Promise<void>`

- [ ] **Step 1: Copy fixtures verbatim**

```bash
for f in .parkinglot/llama-server-captures/*.json; do
  cp "$f" "test/fixtures/llama-server-$(basename "$f")"
done
ls test/fixtures/llama-server-*.json
```

Expected: 10 files — `llama-server-completion-success.json`, `llama-server-health.json`, `llama-server-models-after-unload.json`, `llama-server-models-load-error.json`, `llama-server-models-load-success.json`, `llama-server-models-loaded.json`, `llama-server-models-unload-success.json`, `llama-server-models-unloaded.json`, `llama-server-props-model-loaded.json`, `llama-server-props-router-no-model.json`. (`load-success` and `props-model-loaded` have no test consumer yet — they're kept as captured API documentation for the pull()/props fast-follows.)

- [ ] **Step 2 (optional, best-effort): capture the unverified unload-error shape**

The design flags one unverified assumption: `/models/unload` against an *unknown* model id is assumed to return the same error shape as `/models/load` (`{"error":{"message":"File Not Found","type":"not_found_error","code":404}}`). If the local router instance is still running, verify:

```bash
curl -s -m 2 http://localhost:8080/models/unload -d '{"model":"does-not-exist"}' || echo "SERVER NOT RUNNING — skip, keep assumption"
```

If it responds: save the body verbatim as `test/fixtures/llama-server-models-unload-error.json` and use it (instead of the load-error fixture) in Step 4's unload-error test. If the server isn't running, skip — the load-error fixture stands in, and the design doc already discloses the assumption.

- [ ] **Step 3: Write the failing client test**

Create `test/llama-server-client.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  fetchModels,
  unloadModel,
  completion,
  type LlamaServerModelsResponse,
} from '../src/backends/llama-server/client.js';

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8'));
}

function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

describe('fetchModels', () => {
  it('parses the /models response', async () => {
    const fixture = loadFixture<LlamaServerModelsResponse>('llama-server-models-loaded.json');
    const models = await withFetch(
      (async () => new Response(JSON.stringify(fixture), { status: 200 })) as typeof fetch,
      () => fetchModels()
    );
    expect(models.data[0].id).toBe('Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M');
    expect(models.data[0].meta?.n_params).toBe(630167424);
  });

  it('gives a clear message when llama-server is unreachable', async () => {
    await expect(
      withFetch(
        (() => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:8080');
        }) as typeof fetch,
        () => fetchModels()
      )
    ).rejects.toThrow(/is 'llama-server' running/);
  });
});

describe('unloadModel', () => {
  it('resolves on {"success": true}', async () => {
    await expect(
      withFetch(
        (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof fetch,
        () => unloadModel('Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M')
      )
    ).resolves.toBeUndefined();
  });

  it('throws with the server error message on an unknown model', async () => {
    // Captured from /models/load against an unknown id; /models/unload is
    // assumed to share the shape (flagged as unverified in the design doc).
    const errorBody = loadFixture<object>('llama-server-models-load-error.json');
    await expect(
      withFetch(
        (async () => new Response(JSON.stringify(errorBody), { status: 404 })) as typeof fetch,
        () => unloadModel('does-not-exist')
      )
    ).rejects.toThrow(/File Not Found/);
  });
});

describe('completion', () => {
  it('resolves null on timeout instead of throwing', async () => {
    const abortingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted', 'AbortError'))
        );
      })) as typeof fetch;
    await expect(withFetch(abortingFetch, () => completion('m', 'p', 10))).resolves.toBeNull();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run test/llama-server-client.test.ts`
Expected: FAIL — cannot resolve `../src/backends/llama-server/client.js`.

- [ ] **Step 5: Implement `src/backends/llama-server/client.ts`**

```ts
// LLAMA_SERVER_BASE_URL accepts either `host:port` or a full URL (same contract
// as OLLAMA_HOST), so only add a scheme when there isn't one already.
export const LLAMA_SERVER_BASE_URL = process.env.LLAMA_SERVER_BASE_URL
  ? process.env.LLAMA_SERVER_BASE_URL.startsWith('http')
    ? process.env.LLAMA_SERVER_BASE_URL
    : `http://${process.env.LLAMA_SERVER_BASE_URL}`
  : 'http://localhost:8080';

/** GGUF metadata on a /models entry. Present only after the model has been
 * loaded at least once this server lifetime; disappears again after unload. */
export interface LlamaServerModelMeta {
  vocab_type: number;
  n_vocab: number;
  n_ctx: number;
  n_ctx_train: number;
  n_embd: number;
  n_params: number;
  size: number;
  ftype: string;
}

export interface LlamaServerModelStatus {
  value: string; // "unloaded" | "loading" | "loaded" | "sleeping" | "downloading"
  args?: string[];
  preset?: string;
}

export interface LlamaServerModel {
  id: string;
  object: string;
  owned_by: string;
  created: number;
  status: LlamaServerModelStatus;
  source?: string;
  can_remove?: boolean;
  meta?: LlamaServerModelMeta;
}

export interface LlamaServerModelsResponse {
  data: LlamaServerModel[];
  object: string;
}

export interface LlamaServerCompletionTimings {
  cache_n: number;
  prompt_n: number;
  prompt_ms: number;
  prompt_per_second: number;
  predicted_n: number;
  predicted_ms: number;
  predicted_per_second: number;
}

export interface LlamaServerCompletionResponse {
  content: string;
  model: string;
  stop: boolean;
  timings: LlamaServerCompletionTimings;
}

export interface LlamaServerPropsResponse {
  build_info?: string;
  role?: string;
  model_path?: string;
}

interface LlamaServerErrorBody {
  error?: { message?: string; type?: string; code?: number };
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as LlamaServerErrorBody;
    return body.error?.message ? ` (${body.error.message})` : '';
  } catch {
    return '';
  }
}

async function llamaServerRequest(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${LLAMA_SERVER_BASE_URL}${path}`, init);
  } catch (err) {
    throw new Error(
      `Could not reach llama-server at ${LLAMA_SERVER_BASE_URL} — is 'llama-server' running? (${(err as Error).message})`
    );
  }
  if (!res.ok) {
    throw new Error(`llama-server returned ${res.status} for ${path}${await errorDetail(res)}`);
  }
  return res;
}

async function llamaServerFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await llamaServerRequest(path, init);
  return res.json() as Promise<T>;
}

export async function fetchModels(): Promise<LlamaServerModelsResponse> {
  return llamaServerFetch<LlamaServerModelsResponse>('/models');
}

export async function fetchProps(): Promise<LlamaServerPropsResponse> {
  return llamaServerFetch<LlamaServerPropsResponse>('/props');
}

/** Returns null if the request times out (a meaningful result, not an error).
 * Router mode auto-loads the model on first use; that latency is part of the
 * request, so timeoutMs must cover a cold load. */
export async function completion(
  model: string,
  prompt: string,
  timeoutMs = 90_000
): Promise<LlamaServerCompletionResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${LLAMA_SERVER_BASE_URL}/completion`, {
      method: 'POST',
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`llama-server returned ${res.status} for /completion${await errorDetail(res)}`);
    }
    return (await res.json()) as LlamaServerCompletionResponse;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return null;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function unloadModel(model: string): Promise<void> {
  await llamaServerRequest('/models/unload', {
    method: 'POST',
    body: JSON.stringify({ model }),
  });
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/llama-server-client.test.ts`
Expected: PASS (5 tests). Then `npm run typecheck` — clean.

- [ ] **Step 7: Commit**

```bash
git add test/fixtures/llama-server-*.json src/backends/llama-server/client.ts test/llama-server-client.test.ts
git commit -m "feat: llama-server wire client and captured API fixtures"
```

---

### ftype-normalizer

**Files:**
- Create: `src/backends/llama-server/index.ts` (normalizer only; grows in later tasks)
- Test: `test/llama-server-backend.test.ts` (created here; grows in later tasks)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `normalizeFtype(ftype: string): string` exported from `index.js`.

**Background (why a table, not a parsing rule):** llama-server's `meta.ftype` is the human string from `llama_ftype_name()` in llama.cpp's `src/llama-model-loader.cpp` (verified against master, 2026-08-06). A suffix rule ("` - Medium`" → `_M`) gets two entries wrong: `LLAMA_FTYPE_MOSTLY_Q2_K` renders as `"Q2_K - Medium"` but its canonical id is `Q2_K` (which is what `data/quants.json` has — no `Q2_K_M` exists), and `LLAMA_FTYPE_MOSTLY_IQ3_M` renders as `"IQ3_S mix - 3.66 bpw"`. So: explicit exact-string map, keyed after stripping the optional `"(guessed) "` prefix (llama.cpp prepends that when the ftype was guessed from tensor types). Unknown strings pass through verbatim — `lookupQuant` in `src/data.ts` then flags them as an `unknown-quant` gap, which is the designed feedback loop, so the normalizer must NOT invent a fallback.

- [ ] **Step 1: Write the failing test**

Create `test/llama-server-backend.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeFtype } from '../src/backends/llama-server/index.js';

describe('normalizeFtype', () => {
  // Each case is a real string from llama_ftype_name() in llama.cpp's
  // src/llama-model-loader.cpp, mapped to the canonical LLAMA_FTYPE enum id.
  it.each([
    ['all F32', 'F32'],
    ['F16', 'F16'],
    ['BF16', 'BF16'],
    ['Q8_0', 'Q8_0'],
    ['Q4_0', 'Q4_0'],
    ['MXFP4 MoE', 'MXFP4'],
    ['NVFP4', 'NVFP4'],
    ['Q2_K - Medium', 'Q2_K'], // enum is LLAMA_FTYPE_MOSTLY_Q2_K — no _M suffix
    ['Q2_K - Small', 'Q2_K_S'],
    ['Q3_K - Small', 'Q3_K_S'],
    ['Q3_K - Medium', 'Q3_K_M'],
    ['Q3_K - Large', 'Q3_K_L'],
    ['Q4_K - Small', 'Q4_K_S'],
    ['Q4_K - Medium', 'Q4_K_M'],
    ['Q5_K - Small', 'Q5_K_S'],
    ['Q5_K - Medium', 'Q5_K_M'],
    ['Q6_K', 'Q6_K'],
    ['TQ1_0 - 1.69 bpw ternary', 'TQ1_0'],
    ['TQ2_0 - 2.06 bpw ternary', 'TQ2_0'],
    ['IQ2_XXS - 2.0625 bpw', 'IQ2_XXS'],
    ['IQ2_XS - 2.3125 bpw', 'IQ2_XS'],
    ['IQ2_S - 2.5 bpw', 'IQ2_S'],
    ['IQ2_M - 2.7 bpw', 'IQ2_M'],
    ['IQ3_XXS - 3.0625 bpw', 'IQ3_XXS'],
    ['IQ3_XS - 3.3 bpw', 'IQ3_XS'],
    ['IQ3_S - 3.4375 bpw', 'IQ3_S'],
    ['IQ3_S mix - 3.66 bpw', 'IQ3_M'], // enum is LLAMA_FTYPE_MOSTLY_IQ3_M
    ['IQ1_S - 1.5625 bpw', 'IQ1_S'],
    ['IQ1_M - 1.75 bpw', 'IQ1_M'],
    ['IQ4_NL - 4.5 bpw', 'IQ4_NL'],
    ['IQ4_XS - 4.25 bpw', 'IQ4_XS'],
    ['Q4_1', 'Q4_1'],
    ['Q5_0', 'Q5_0'],
    ['Q5_1', 'Q5_1'],
  ])('normalizes %s to %s', (ftype, expected) => {
    expect(normalizeFtype(ftype)).toBe(expected);
  });

  it('strips the "(guessed) " prefix before mapping', () => {
    expect(normalizeFtype('(guessed) Q4_K - Medium')).toBe('Q4_K_M');
  });

  it('passes unknown strings through verbatim for the unknown-quant gap flow', () => {
    expect(normalizeFtype('Q9_Z - Fancy')).toBe('Q9_Z - Fancy');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/llama-server-backend.test.ts`
Expected: FAIL — cannot resolve `../src/backends/llama-server/index.js`.

- [ ] **Step 3: Implement `normalizeFtype` in `src/backends/llama-server/index.ts`**

```ts
/** llama-server reports quantization as the human string from llama.cpp's
 * llama_ftype_name() (src/llama-model-loader.cpp). This maps each known string
 * to the canonical id form data/quants.json uses. Exact-string map rather than
 * a " - Medium"→"_M" parsing rule because the rendering isn't mechanical:
 * "Q2_K - Medium" is enum LLAMA_FTYPE_MOSTLY_Q2_K (no suffix) and
 * "IQ3_S mix - 3.66 bpw" is enum LLAMA_FTYPE_MOSTLY_IQ3_M. */
const FTYPE_TO_QUANT: Record<string, string> = {
  'all F32': 'F32',
  F16: 'F16',
  BF16: 'BF16',
  Q1_0: 'Q1_0',
  Q2_0: 'Q2_0',
  Q4_0: 'Q4_0',
  Q4_1: 'Q4_1',
  Q5_0: 'Q5_0',
  Q5_1: 'Q5_1',
  Q8_0: 'Q8_0',
  'MXFP4 MoE': 'MXFP4',
  NVFP4: 'NVFP4',
  'Q2_K - Medium': 'Q2_K',
  'Q2_K - Small': 'Q2_K_S',
  'Q3_K - Small': 'Q3_K_S',
  'Q3_K - Medium': 'Q3_K_M',
  'Q3_K - Large': 'Q3_K_L',
  'Q4_K - Small': 'Q4_K_S',
  'Q4_K - Medium': 'Q4_K_M',
  'Q5_K - Small': 'Q5_K_S',
  'Q5_K - Medium': 'Q5_K_M',
  Q6_K: 'Q6_K',
  'TQ1_0 - 1.69 bpw ternary': 'TQ1_0',
  'TQ2_0 - 2.06 bpw ternary': 'TQ2_0',
  'IQ2_XXS - 2.0625 bpw': 'IQ2_XXS',
  'IQ2_XS - 2.3125 bpw': 'IQ2_XS',
  'IQ2_S - 2.5 bpw': 'IQ2_S',
  'IQ2_M - 2.7 bpw': 'IQ2_M',
  'IQ3_XXS - 3.0625 bpw': 'IQ3_XXS',
  'IQ3_XS - 3.3 bpw': 'IQ3_XS',
  'IQ3_S - 3.4375 bpw': 'IQ3_S',
  'IQ3_S mix - 3.66 bpw': 'IQ3_M',
  'IQ1_S - 1.5625 bpw': 'IQ1_S',
  'IQ1_M - 1.75 bpw': 'IQ1_M',
  'IQ4_NL - 4.5 bpw': 'IQ4_NL',
  'IQ4_XS - 4.25 bpw': 'IQ4_XS',
};

const GUESSED_PREFIX = '(guessed) ';

/** Unknown strings pass through verbatim so lookupQuant (src/data.ts) flags
 * them as an unknown-quant gap instead of silently mis-normalizing. */
export function normalizeFtype(ftype: string): string {
  const stripped = ftype.startsWith(GUESSED_PREFIX) ? ftype.slice(GUESSED_PREFIX.length) : ftype;
  return FTYPE_TO_QUANT[stripped] ?? stripped;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/llama-server-backend.test.ts`
Expected: PASS (33 table cases plus the prefix and pass-through tests). Then `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/backends/llama-server/index.ts test/llama-server-backend.test.ts
git commit -m "feat: normalize llama.cpp ftype strings to canonical quant ids"
```

---

### mapping-functions

**Files:**
- Modify: `src/backends/llama-server/index.ts` (add the two mapping functions)
- Test: `test/llama-server-backend.test.ts` (extend)

**Interfaces:**
- Consumes: `normalizeFtype` (same file); `LlamaServerModelsResponse`, `LlamaServerCompletionResponse` from `client.js`; `LocalModels`, `ModelInfo`, `GenerateResult` from `src/types.ts`.
- Produces (exported from `index.js`):
  - `mapModelsToLocalModels(res: LlamaServerModelsResponse): LocalModels`
  - `mapCompletionToGenerate(res: LlamaServerCompletionResponse): GenerateResult`

- [ ] **Step 1: Write the failing tests**

Add to `test/llama-server-backend.test.ts` (add `readFileSync` import and a `loadFixture` helper matching `test/ollama-backend.test.ts`'s):

```ts
import { readFileSync } from 'node:fs';
import {
  normalizeFtype,
  mapModelsToLocalModels,
  mapCompletionToGenerate,
} from '../src/backends/llama-server/index.js';
import type {
  LlamaServerModelsResponse,
  LlamaServerCompletionResponse,
} from '../src/backends/llama-server/client.js';

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8'));
}

describe('mapModelsToLocalModels', () => {
  it('maps a loaded model with meta to a fully-populated ModelInfo', () => {
    const fixture = loadFixture<LlamaServerModelsResponse>('llama-server-models-loaded.json');
    const { models, skipped } = mapModelsToLocalModels(fixture);
    expect(skipped).toEqual([]);
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      name: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M',
      source: 'local',
      url: null,
      parameterSizeB: 630167424 / 1e9,
      quantizationLevel: 'Q4_K_M',
      diskSizeBytes: 485452288,
    });
  });

  it('reports null size/quant for a never-loaded model (no meta)', () => {
    const fixture = loadFixture<LlamaServerModelsResponse>('llama-server-models-unloaded.json');
    const { models } = mapModelsToLocalModels(fixture);
    expect(models[0].parameterSizeB).toBeNull();
    expect(models[0].quantizationLevel).toBeNull();
    expect(models[0].diskSizeBytes).toBeNull();
  });

  it('reports null again after unload — meta does not persist', () => {
    const fixture = loadFixture<LlamaServerModelsResponse>('llama-server-models-after-unload.json');
    const { models } = mapModelsToLocalModels(fixture);
    expect(models[0].parameterSizeB).toBeNull();
    expect(models[0].quantizationLevel).toBeNull();
    expect(models[0].diskSizeBytes).toBeNull();
  });
});

describe('mapCompletionToGenerate', () => {
  it('maps the timings block from a captured completion', () => {
    const fixture = loadFixture<LlamaServerCompletionResponse>('llama-server-completion-success.json');
    const result = mapCompletionToGenerate(fixture);
    expect(result.evalCount).toBe(16);
    expect(result.evalDurationSeconds).toBeCloseTo(0.071907, 6);
    expect(result.totalDurationSeconds).toBeCloseTo(0.089385, 6);
    expect(result.loadDurationSeconds).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/llama-server-backend.test.ts`
Expected: FAIL — `mapModelsToLocalModels` / `mapCompletionToGenerate` not exported.

- [ ] **Step 3: Implement the mapping functions in `src/backends/llama-server/index.ts`**

Add imports at the top:

```ts
import type { GenerateResult, LocalModels, ModelInfo } from '../../types.js';
import type { LlamaServerCompletionResponse, LlamaServerModelsResponse } from './client.js';
```

Add the functions:

```ts
/** Every model the router knows about is 'local' — an unloaded-but-known model
 * is still installed, just not resident. Size/quant fields come from `meta`,
 * which the API includes only for models loaded at least once this server
 * lifetime; without it they're null — a real, disclosed gap (the router
 * genuinely can't know an unloaded model's footprint without loading it). */
export function mapModelsToLocalModels(res: LlamaServerModelsResponse): LocalModels {
  const models: ModelInfo[] = res.data.map((model) => ({
    name: model.id,
    source: 'local',
    url: null,
    parameterSizeB: model.meta ? model.meta.n_params / 1e9 : null,
    quantizationLevel: model.meta ? normalizeFtype(model.meta.ftype) : null,
    diskSizeBytes: model.meta ? model.meta.size : null,
  }));
  return { models, skipped: [] };
}

export function mapCompletionToGenerate(res: LlamaServerCompletionResponse): GenerateResult {
  const { prompt_ms, predicted_ms, predicted_n } = res.timings;
  return {
    evalCount: predicted_n,
    evalDurationSeconds: predicted_ms / 1000,
    // Router-mode auto-load latency is absorbed into overall request latency,
    // not broken out anywhere in the response.
    loadDurationSeconds: null,
    totalDurationSeconds: (prompt_ms + predicted_ms) / 1000,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/llama-server-backend.test.ts`
Expected: PASS. Then `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/backends/llama-server/index.ts test/llama-server-backend.test.ts
git commit -m "feat: map llama-server /models and /completion to llamafit types"
```

---

### backend-object-and-registry

**Files:**
- Modify: `src/backends/llama-server/index.ts` (add `detect`, `localModels`, `generateResult`, export `llamaServerBackend`)
- Modify: `src/backends/registry.ts` (register)
- Test: `test/llama-server-backend.test.ts` (extend: fetch stub, conformance, behavior tests)
- Test: `test/backend-registry.test.ts` (extend: expect `llama-server` listed)

**Interfaces:**
- Consumes: `fetchModels`, `fetchProps`, `completion`, `unloadModel`, `LLAMA_SERVER_BASE_URL` from `client.js`; mapping functions from this file; `Backend` from `../types.js`; `Detection` from `../../types.js`.
- Produces: `export const llamaServerBackend: Backend` with `id: 'llama-server'`, `displayName: 'llama-server'`, and ONLY these members: `detect`, `localModels`, `generate`, `unload`. No `loadedModels`, `remoteCandidates`, or `pull` keys at all.

- [ ] **Step 1: Write the failing tests**

In `test/llama-server-backend.test.ts`, add imports (`beforeEach`, `afterEach` from vitest; `describeBackendConformance` from `./conformance/backend.js`; `llamaServerBackend` from the index module), the fetch stub, and the suites. **Route order matters: `/models/unload` must be matched before `/models`.**

```ts
const health = loadFixture<object>('llama-server-health.json');
const props = loadFixture<object>('llama-server-props-router-no-model.json');
const modelsLoaded = loadFixture<LlamaServerModelsResponse>('llama-server-models-loaded.json');
const completionSuccess = loadFixture<LlamaServerCompletionResponse>(
  'llama-server-completion-success.json'
);
const unloadSuccess = loadFixture<object>('llama-server-models-unload-success.json');

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/health')) {
      return new Response(JSON.stringify(health), { status: 200 });
    }
    if (url.includes('/props')) {
      return new Response(JSON.stringify(props), { status: 200 });
    }
    if (url.includes('/models/unload')) {
      return new Response(JSON.stringify(unloadSuccess), { status: 200 });
    }
    if (url.includes('/models')) {
      return new Response(JSON.stringify(modelsLoaded), { status: 200 });
    }
    if (url.includes('/completion')) {
      return new Response(JSON.stringify(completionSuccess), { status: 200 });
    }
    throw new Error(`Unhandled fetch in test stub: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describeBackendConformance('llama-server', async () => llamaServerBackend);

describe('llamaServerBackend', () => {
  it('detect() reports detected with build_info as version', async () => {
    const detection = await llamaServerBackend.detect();
    expect(detection.detected).toBe(true);
    expect(detection.version).toBe('b10280-61881b1f7');
    expect(detection.evidence).toHaveProperty('baseUrl');
  });

  it('detect() reports unreachable without throwing', async () => {
    globalThis.fetch = (() => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8080');
    }) as typeof fetch;
    const detection = await llamaServerBackend.detect();
    expect(detection.detected).toBe(false);
    expect(detection.evidence).toHaveProperty('error');
  });

  it('detect() still detects when /props fails — version is best-effort', async () => {
    const healthOnlyFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/props')) {
        return new Response('unavailable', { status: 500 });
      }
      return healthOnlyFetch(input);
    }) as typeof fetch;
    const detection = await llamaServerBackend.detect();
    expect(detection.detected).toBe(true);
    expect(detection.version).toBeNull();
  });

  it('detect() reports a non-200 /health as not detected', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 503, message: 'Loading model' } }), {
        status: 503,
      })) as typeof fetch;
    const detection = await llamaServerBackend.detect();
    expect(detection.detected).toBe(false);
  });

  it('localModels() maps through the fixture', async () => {
    const { models } = await llamaServerBackend.localModels();
    expect(models[0].name).toBe('Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M');
    expect(models[0].quantizationLevel).toBe('Q4_K_M');
  });

  it('generate() maps the completion timings', async () => {
    const result = await llamaServerBackend.generate('Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M', 'hi');
    expect(result?.evalCount).toBe(16);
    expect(result?.loadDurationSeconds).toBeNull();
  });

  it('does not declare loadedModels, remoteCandidates, or pull', () => {
    expect('loadedModels' in llamaServerBackend).toBe(false);
    expect('remoteCandidates' in llamaServerBackend).toBe(false);
    expect('pull' in llamaServerBackend).toBe(false);
    expect(typeof llamaServerBackend.unload).toBe('function');
  });
});
```

In `test/backend-registry.test.ts`, extend the existing `lists ollama` test (or add a sibling):

```ts
it('lists llama-server', () => {
  expect(allBackends().map((b) => b.id)).toContain('llama-server');
  expect(findBackend('llama-server')?.id).toBe('llama-server');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/llama-server-backend.test.ts test/backend-registry.test.ts`
Expected: FAIL — `llamaServerBackend` not exported; registry doesn't list `llama-server`.

- [ ] **Step 3: Implement the backend object and register it**

In `src/backends/llama-server/index.ts`, add imports:

```ts
import type { Backend } from '../types.js';
import type { Detection } from '../../types.js';
import {
  LLAMA_SERVER_BASE_URL,
  completion,
  fetchModels,
  fetchProps,
  unloadModel,
} from './client.js';
```

Add the backend:

```ts
async function detect(): Promise<Detection> {
  try {
    const res = await fetch(`${LLAMA_SERVER_BASE_URL}/health`);
    if (!res.ok) {
      return {
        detected: false,
        version: null,
        evidence: { baseUrl: LLAMA_SERVER_BASE_URL, error: `server returned ${res.status}` },
      };
    }
    // Bare GET /props (no ?model=) works in router mode; version is a
    // nice-to-have, not a gate — /health alone decides detection.
    let version: string | null = null;
    try {
      version = (await fetchProps()).build_info ?? null;
    } catch {
      version = null;
    }
    return { detected: true, version, evidence: { baseUrl: LLAMA_SERVER_BASE_URL } };
  } catch (err) {
    return {
      detected: false,
      version: null,
      evidence: { baseUrl: LLAMA_SERVER_BASE_URL, error: (err as Error).message },
    };
  }
}

async function localModels(): Promise<LocalModels> {
  return mapModelsToLocalModels(await fetchModels());
}

async function generateResult(
  model: string,
  prompt: string,
  timeoutMs?: number
): Promise<GenerateResult | null> {
  const response = await completion(model, prompt, timeoutMs);
  if (response === null) return null;
  return mapCompletionToGenerate(response);
}

/** Router mode only. loadedModels() is deliberately absent: no llama-server
 * endpoint reports real per-model VRAM, and faking it from file size would
 * poison bench.ts's calibration provenance (see docs/adapters.md).
 * remoteCandidates() and pull() are tracked fast-follows. */
export const llamaServerBackend: Backend = {
  id: 'llama-server',
  displayName: 'llama-server',
  detect,
  localModels,
  generate: generateResult,
  unload: unloadModel,
};
```

In `src/backends/registry.ts`:

```ts
import { llamaServerBackend } from './llama-server/index.js';
```

```ts
const BACKENDS: Backend[] = [ollamaBackend, llamaServerBackend];
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, including `Backend conformance: llama-server` (confirm that describe block actually ran in the output — docs/adapters.md checklist requires it). Then `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/backends/llama-server/index.ts src/backends/registry.ts test/llama-server-backend.test.ts test/backend-registry.test.ts
git commit -m "feat: llama-server backend (router mode) — detect, localModels, generate, unload"
```

---

### adapters-doc-note

**Files:**
- Modify: `docs/adapters.md` (add a short subsection at the end of section 3, after "### Registering")

**Interfaces:**
- Consumes: the landed `src/backends/llama-server/` from previous tasks (references it).
- Produces: documentation only.

- [ ] **Step 1: Add the note to `docs/adapters.md`**

Insert after section 3's "### Registering" block (before "## 4. Quantization table"):

```markdown
### Second implementation: `src/backends/llama-server/`

llama.cpp's `llama-server` (router mode only — classic single-instance mode
is out of scope) is the example of a deliberately degraded backend: it
implements `detect()`, `localModels()`, `generate()`, and `unload()`, and
omits the rest. Two of its behaviors are worth knowing if you're adapting
another llama.cpp-family server:

- `GET /models` includes GGUF metadata (`meta`: `n_params`, `size`, `ftype`)
  only for models that have been loaded at least once this server lifetime,
  and it disappears again after unload. `localModels()` therefore reports
  `parameterSizeB`/`quantizationLevel`/`diskSizeBytes` as `null` for
  never-loaded models — a real, disclosed gap: the router genuinely cannot
  know an unloaded model's footprint without loading it.
- `loadedModels()` is omitted rather than faked. No llama-server endpoint
  reports real per-model VRAM, and deriving a number from on-disk file size
  would mislabel check rows as `estimateSource: 'measured'` and poison
  `bench`-driven calibration provenance. Same principle as probes: prefer
  under-reporting than fabricating.
```

- [ ] **Step 2: Verify and commit**

Run: `npm test && npm run typecheck`
Expected: both pass (docs-only change; this is the final pre-completion gate).

```bash
git add docs/adapters.md
git commit -m "docs: note llama-server's meta-only-when-loaded and loadedModels omission in adapters.md"
```

- [ ] **Step 3: Close out taskwarrior**

File the two fast-follows and complete the main task (UUIDs stable, integer IDs are not):

```bash
task add project:llamafit "llama-server remoteCandidates(): HF Hub model API (search + per-repo expand[]=gguf for n_params) — see docs/superpowers/specs/2026-08-06-llama-server-backend-design.md fast-follows"
task add project:llamafit "llama-server pull(): POST /models then poll GET /models (or consume /models/sse) until status leaves downloading; handle failed:true — see design doc fast-follows"
task fc0885b9 done
```

---

## Execution notes (not tasks)

- Work happens on `main` in the primary checkout, matching this repo's existing all-on-main history (no PR flow in evidence; solo project).
- `.parkinglot/llama-server-captures/` stays untracked — the copies under `test/fixtures/` become the canonical committed captures. After the plan completes, `.parkinglot/llama-server-backend.md` can be archived/removed as part of unpark cleanup.
- The design doc's one unverified assumption (unload-vs-load error shape) is handled in fixtures-and-client Step 2 — best-effort, skip if the local router isn't running.
