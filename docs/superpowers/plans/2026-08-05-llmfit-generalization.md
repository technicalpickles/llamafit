# llmfit Generalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carve ollama-scope into llmfit: three adapter interfaces (Backend, SystemProbe, Estimator), a data layer for quants/calibration/thresholds, a gap→diagnostics-bundle→agent-prompt failure flow, and the rename + npm publish prep.

**Architecture:** In-tree adapters behind TypeScript interfaces; existing macOS+Ollama code becomes the reference implementation of each interface with behavior unchanged (guarded by an output snapshot test written first). Cheaply-varying values move to `data/*.json`. Every "can't handle this" callsite records a typed Gap; the CLI turns gaps into a diagnostics bundle plus two exits (paste-to-agent prompt, pre-filled GitHub issue URL).

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node >= 20, vitest, commander, cheerio. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-05-llmfit-generalization-design.md` — read it before starting any task.

## Global Constraints

- Node >= 20; ESM with explicit `.js` suffixes on relative imports (existing convention).
- No new runtime dependencies; no runtime plugin loading.
- **Output guardrail:** `check` and `bench` rendered output for the existing macOS+Ollama fixtures must be byte-identical before and after the carve-out. The `output-guardrail` task's snapshot files must never be regenerated in later tasks (updating the *test wiring* when signatures change is fine; the stored snapshot text is not).
- Data files validate at load: malformed `data/*.json` throws with a message naming the file and problem.
- Verdict thresholds and quant values are copied verbatim from the current code: tight at >70%, thrash at >95%, fallback quant `Q4_K_M` (0.5625 bytes/param), overhead multiplier 1.25, darwin baseline reserve 8 GB.
- Run `npm test` and `npm run typecheck` before every commit.
- Tests never touch the network or real `top`/`sysctl` — fixtures only (existing convention, see `test/fixtures/`).

---

### Task: output-guardrail

Freeze today's rendered output before touching anything.

**Files:**
- Test: `test/output-guardrail.test.ts`
- Create: `test/fixtures/guardrail-check-table.txt`, `test/fixtures/guardrail-check.json`, `test/fixtures/guardrail-bench.txt` (written by the snapshot mechanism on first run)

**Interfaces:**
- Consumes: `runCheck(query, deps)` from `src/check.ts` with its current `CheckDeps`; `formatCheckTable`, `formatCheckJson`, `formatBenchResult` from `src/format.ts`; fixture JSON in `test/fixtures/`.
- Produces: three vitest file snapshots later tasks must keep green.

- [ ] **Step 1: Write the snapshot test**

Model the deps wiring on the existing `test/check.test.ts` (read it first; reuse its fixture-loading helpers if it has them). The test pins a deterministic `SystemMemoryState` rather than reading the live machine:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/check.js';
import { formatCheckTable, formatCheckJson, formatBenchResult } from '../src/format.js';
import type { BenchResult } from '../src/bench.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const SYSTEM = {
  totalGb: 24, usedGb: 12.5, wiredGb: 3.2, compressorGb: 1.1, unusedGb: 0.4,
  swapTotalGb: 2, swapUsedGb: 0.5, swapFreeGb: 1.5,
};

const deps = {
  fetchTags: async () => fixture('api-tags.json'),
  fetchPs: async () => fixture('api-ps-loaded.json'),
  readSystemMemory: () => SYSTEM,
  scrapeSearch: async () => {
    const { parseSearchResults } = await import('../src/scrape.js');
    return parseSearchResults(
      readFileSync(new URL('./fixtures/ollama-search-mlx.html', import.meta.url), 'utf8')
    );
  },
};

const BENCH: BenchResult = {
  model: 'gemma3:12b', status: 'completed', sizeVramGb: 8.6,
  evalTokensPerSecond: 23.4, loadDurationSeconds: 4.2, totalDurationSeconds: 18.9,
  memoryBefore: SYSTEM, memoryAfter: { ...SYSTEM, usedGb: 20.1, wiredGb: 3.4, swapUsedGb: 0.9 },
};

describe('output guardrail (must stay byte-identical through the carve-out)', () => {
  it('check table', async () => {
    const result = await runCheck('mlx', deps);
    await expect(formatCheckTable(result, { color: false })).toMatchFileSnapshot(
      './fixtures/guardrail-check-table.txt'
    );
  });
  it('check json', async () => {
    const result = await runCheck('mlx', deps);
    await expect(formatCheckJson(result)).toMatchFileSnapshot('./fixtures/guardrail-check.json');
  });
  it('bench output', () => {
    return expect(formatBenchResult(BENCH, { color: false })).toMatchFileSnapshot(
      './fixtures/guardrail-bench.txt'
    );
  });
});
```

If `runCheck`'s deps types don't match this sketch exactly, follow the real signatures in `src/check.ts` — the point is deterministic inputs, not this exact wiring.

- [ ] **Step 2: Run it to write the snapshots, then run again to verify green**

Run: `npx vitest run test/output-guardrail.test.ts` (twice)
Expected: first run writes the three snapshot files; second run passes with 3 tests green.

- [ ] **Step 3: Inspect the snapshot files**

Open the three `test/fixtures/guardrail-*` files and confirm they contain a real table / real JSON / real bench report, not empty strings.

- [ ] **Step 4: Commit**

```bash
git add test/output-guardrail.test.ts test/fixtures/guardrail-*
git commit -m "test: freeze check/bench output before the llmfit carve-out"
```

---

### Task: data-layer

Move quants, calibration, and thresholds into validated JSON.

**Files:**
- Create: `data/quants.json`, `data/calibration.json`, `data/thresholds.json`, `src/data.ts`
- Test: `test/data.test.ts`

**Interfaces:**
- Produces (from `src/data.ts`, consumed by `estimator-carveout` and `check-refactor`):
  - `loadQuantTable(): QuantTable` where `QuantTable = { entries: QuantEntry[]; fallback: string }`, `QuantEntry = { id: string; bytesPerParam: number; aliases: string[] }`
  - `lookupQuant(table: QuantTable, raw: string): { id: string; bytesPerParam: number; known: boolean }` — trims/uppercases, matches id or alias; unknown/empty returns the fallback entry with `known: false`
  - `loadCalibration(): Calibration` where `Calibration = { overheadMultiplier: number; provenance: Provenance[]; backends: Record<string, { overheadMultiplier: number }> }`, `Provenance = { backend: string; model: string; predictedWeightsGb: number; measuredVramGb: number }`
  - `loadThresholds(): Thresholds` where `Thresholds = { tightRatio: number; thrashRatio: number; baselineReserveGb: Record<string, number> }`
  - Each loader reads once via `readFileSync(new URL('../data/<file>.json', import.meta.url))`, validates, caches in a module-level variable, and throws `Error("data/<file>.json: <problem>")` on malformed content.

- [ ] **Step 1: Write the data files**

`data/quants.json` — values copied verbatim from `src/estimate.ts:1-17`:

```json
{
  "fallback": "Q4_K_M",
  "entries": [
    { "id": "F32", "bytesPerParam": 4.0, "aliases": ["FP32"] },
    { "id": "F16", "bytesPerParam": 2.0, "aliases": ["BF16", "FP16"] },
    { "id": "Q8_0", "bytesPerParam": 1.0, "aliases": ["FP8"] },
    { "id": "Q6_K", "bytesPerParam": 0.75, "aliases": [] },
    { "id": "Q5_K_M", "bytesPerParam": 0.69, "aliases": [] },
    { "id": "Q4_K_M", "bytesPerParam": 0.5625, "aliases": [] },
    { "id": "Q4_0", "bytesPerParam": 0.5, "aliases": ["MXFP4", "NVFP4"] },
    { "id": "Q3_K_M", "bytesPerParam": 0.44, "aliases": [] },
    { "id": "Q2_K", "bytesPerParam": 0.35, "aliases": [] }
  ]
}
```

`data/calibration.json` — provenance copied from the original spec's measurement table:

```json
{
  "overheadMultiplier": 1.25,
  "provenance": [
    { "backend": "ollama", "model": "llama3.2:3b", "predictedWeightsGb": 1.8, "measuredVramGb": 2.3 },
    { "backend": "ollama", "model": "gemma3:12b", "predictedWeightsGb": 6.75, "measuredVramGb": 8.6 },
    { "backend": "ollama", "model": "gemma-4-12b-mlx:4bit", "predictedWeightsGb": 6.69, "measuredVramGb": 7.8 }
  ],
  "backends": {}
}
```

`data/thresholds.json`:

```json
{
  "tightRatio": 0.7,
  "thrashRatio": 0.95,
  "baselineReserveGb": { "darwin": 8 }
}
```

- [ ] **Step 2: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { loadQuantTable, lookupQuant, loadCalibration, loadThresholds } from '../src/data.js';

describe('data layer', () => {
  it('quant table parses and preserves current values', () => {
    const table = loadQuantTable();
    expect(lookupQuant(table, 'Q4_K_M')).toEqual({ id: 'Q4_K_M', bytesPerParam: 0.5625, known: true });
    expect(lookupQuant(table, 'bf16')).toEqual({ id: 'F16', bytesPerParam: 2.0, known: true });
  });
  it('unknown or empty quant falls back, flagged unknown', () => {
    const table = loadQuantTable();
    expect(lookupQuant(table, 'UD-Q4_K_XL')).toEqual({ id: 'Q4_K_M', bytesPerParam: 0.5625, known: false });
    expect(lookupQuant(table, '')).toEqual({ id: 'Q4_K_M', bytesPerParam: 0.5625, known: false });
  });
  it('quant ids and aliases are unique across the table', () => {
    const table = loadQuantTable();
    const names = table.entries.flatMap((e) => [e.id, ...e.aliases]);
    expect(new Set(names).size).toBe(names.length);
  });
  it('calibration has the 1.25 default and provenance for it', () => {
    const cal = loadCalibration();
    expect(cal.overheadMultiplier).toBe(1.25);
    expect(cal.provenance.length).toBeGreaterThanOrEqual(3);
  });
  it('thresholds carry current verdict ratios and darwin reserve', () => {
    expect(loadThresholds()).toEqual({
      tightRatio: 0.7,
      thrashRatio: 0.95,
      baselineReserveGb: { darwin: 8 },
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/data.test.ts`
Expected: FAIL — cannot resolve `../src/data.js`.

- [ ] **Step 4: Implement `src/data.ts`**

```ts
import { readFileSync } from 'node:fs';

export interface QuantEntry { id: string; bytesPerParam: number; aliases: string[] }
export interface QuantTable { entries: QuantEntry[]; fallback: string }
export interface Provenance { backend: string; model: string; predictedWeightsGb: number; measuredVramGb: number }
export interface Calibration {
  overheadMultiplier: number;
  provenance: Provenance[];
  backends: Record<string, { overheadMultiplier: number }>;
}
export interface Thresholds {
  tightRatio: number;
  thrashRatio: number;
  baselineReserveGb: Record<string, number>;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(new URL(`../data/${file}`, import.meta.url), 'utf8'));
}

function fail(file: string, problem: string): never {
  throw new Error(`data/${file}: ${problem}`);
}

let quantTable: QuantTable | null = null;
export function loadQuantTable(): QuantTable {
  if (quantTable) return quantTable;
  const raw = readJson('quants.json') as QuantTable;
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) fail('quants.json', 'entries must be a non-empty array');
  const seen = new Set<string>();
  for (const e of raw.entries) {
    if (typeof e.id !== 'string' || typeof e.bytesPerParam !== 'number' || e.bytesPerParam <= 0 || !Array.isArray(e.aliases)) {
      fail('quants.json', `malformed entry: ${JSON.stringify(e)}`);
    }
    for (const name of [e.id, ...e.aliases]) {
      if (seen.has(name)) fail('quants.json', `duplicate quant name: ${name}`);
      seen.add(name);
    }
  }
  if (!raw.entries.some((e) => e.id === raw.fallback)) fail('quants.json', `fallback ${raw.fallback} has no entry`);
  quantTable = raw;
  return raw;
}

export function lookupQuant(table: QuantTable, rawQuant: string): { id: string; bytesPerParam: number; known: boolean } {
  const key = rawQuant.trim().toUpperCase();
  const entry =
    key.length > 0
      ? table.entries.find((e) => e.id === key || e.aliases.includes(key))
      : undefined;
  if (entry) return { id: entry.id, bytesPerParam: entry.bytesPerParam, known: true };
  const fallback = table.entries.find((e) => e.id === table.fallback)!;
  return { id: fallback.id, bytesPerParam: fallback.bytesPerParam, known: false };
}

let calibration: Calibration | null = null;
export function loadCalibration(): Calibration {
  if (calibration) return calibration;
  const raw = readJson('calibration.json') as Calibration;
  if (typeof raw.overheadMultiplier !== 'number' || raw.overheadMultiplier < 1) {
    fail('calibration.json', 'overheadMultiplier must be a number >= 1');
  }
  if (!Array.isArray(raw.provenance) || raw.provenance.length === 0) {
    fail('calibration.json', 'provenance must be a non-empty array (every multiplier needs evidence)');
  }
  calibration = raw;
  return raw;
}

let thresholds: Thresholds | null = null;
export function loadThresholds(): Thresholds {
  if (thresholds) return thresholds;
  const raw = readJson('thresholds.json') as Thresholds;
  if (!(raw.tightRatio > 0 && raw.tightRatio < raw.thrashRatio && raw.thrashRatio <= 1)) {
    fail('thresholds.json', 'need 0 < tightRatio < thrashRatio <= 1');
  }
  if (typeof raw.baselineReserveGb !== 'object' || raw.baselineReserveGb === null) {
    fail('thresholds.json', 'baselineReserveGb must be an object keyed by platform');
  }
  thresholds = raw;
  return raw;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/data.test.ts` — expected: PASS.
Also run: `npm run typecheck` — expected: clean.

- [ ] **Step 6: Commit**

```bash
git add data/ src/data.ts test/data.test.ts
git commit -m "feat: add validated data layer for quants, calibration, thresholds"
```

---

### Task: gap-collector

Typed gaps that every unsupported-thing callsite reports into.

**Files:**
- Create: `src/gaps.ts`
- Test: `test/gaps.test.ts`

**Interfaces:**
- Produces (consumed by `probe-carveout`, `check-refactor`, `cli-wiring`, `diagnostics-bundle`, `contribution-prompts`):
  - `type GapKind = 'unsupported-platform' | 'no-backend-detected' | 'unknown-quant' | 'backend-response-unexpected' | 'scrape-failed'`
  - `interface Gap { kind: GapKind; summary: string; evidence: Record<string, unknown> }`
  - `class GapCollector { add(gap: Gap): void; list(): Gap[] }` — `add` dedupes on `kind + summary` so twelve rows with the same unknown quant yield one gap.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { GapCollector } from '../src/gaps.js';

describe('GapCollector', () => {
  it('collects gaps in order', () => {
    const gaps = new GapCollector();
    gaps.add({ kind: 'scrape-failed', summary: 'ollama.com returned 500', evidence: { status: 500 } });
    gaps.add({ kind: 'unknown-quant', summary: 'unknown quantization "UD-Q4_K_XL"', evidence: { quant: 'UD-Q4_K_XL' } });
    expect(gaps.list().map((g) => g.kind)).toEqual(['scrape-failed', 'unknown-quant']);
  });
  it('dedupes identical kind+summary', () => {
    const gaps = new GapCollector();
    const gap = { kind: 'unknown-quant' as const, summary: 'unknown quantization "UD-Q4_K_XL"', evidence: { model: 'a' } };
    gaps.add(gap);
    gaps.add({ ...gap, evidence: { model: 'b' } });
    expect(gaps.list()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify fail, implement, run to verify pass**

```ts
export type GapKind =
  | 'unsupported-platform'
  | 'no-backend-detected'
  | 'unknown-quant'
  | 'backend-response-unexpected'
  | 'scrape-failed';

export interface Gap {
  kind: GapKind;
  summary: string;
  evidence: Record<string, unknown>;
}

export class GapCollector {
  private gaps: Gap[] = [];

  add(gap: Gap): void {
    if (this.gaps.some((g) => g.kind === gap.kind && g.summary === gap.summary)) return;
    this.gaps.push(gap);
  }

  list(): Gap[] {
    return [...this.gaps];
  }
}
```

Run: `npx vitest run test/gaps.test.ts` — expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/gaps.ts test/gaps.test.ts
git commit -m "feat: add typed gap collector for unsupported-thing reporting"
```

---

### Task: estimator-carveout

`src/estimate.ts` becomes an `Estimator` implementation reading the data layer.

**Files:**
- Create: `src/estimators/types.ts`, `src/estimators/formula.ts`
- Delete: `src/estimate.ts`
- Modify: `src/check.ts` (imports only, full refactor comes later), `test/estimate.test.ts` → rename to `test/formula-estimator.test.ts`

**Interfaces:**
- Produces (`src/estimators/types.ts`):
  - `type Verdict = 'comfortable' | 'tight' | 'will-thrash'` (moved from `src/estimate.ts:53`)
  - `interface EstimateInput { parameterSizeB: number | null; quantizationLevel: string | null }`
  - `interface HeadroomContext { baselineHeadroomGb: number; currentHeadroomGb: number }`
  - `interface Estimate { footprintGb: number | null; quantKnown: boolean; quantUsedForEstimate: string | null; baselineVerdict: Verdict | 'unknown'; currentVerdict: Verdict | 'unknown' }`
  - `interface Estimator { id: string; estimate(model: EstimateInput, headroom: HeadroomContext): Estimate }`
- Produces (`src/estimators/formula.ts`):
  - `formulaEstimator: Estimator` with `id: 'formula-v1'` — `params × bytesPerParam(quant) × overheadMultiplier`, verdicts from thresholds ratios; `parameterSizeB: null` → `footprintGb: null`, verdicts `'unknown'`.
  - `classifyVerdict(footprintGb: number, headroomGb: number): Verdict` — same logic as `src/estimate.ts:55-59` but ratios from `loadThresholds()`. Exported because `check-refactor` still classifies *measured* footprints directly.
- Consumes: `loadQuantTable`, `lookupQuant`, `loadCalibration`, `loadThresholds` from `src/data.ts`.

- [ ] **Step 1: Write failing tests**

Port the golden cases from the existing `test/estimate.test.ts` (read it first; keep every case, re-expressed against the estimator):

```ts
import { describe, expect, it } from 'vitest';
import { formulaEstimator, classifyVerdict } from '../src/estimators/formula.js';

const headroom = { baselineHeadroomGb: 16, currentHeadroomGb: 20.8 };

describe('formulaEstimator', () => {
  it('matches the calibrated golden cases', () => {
    // llama3.2:3b Q4_K_M: 3.2B × 0.5625 × 1.25 = 2.25GB (measured 2.3GB)
    const e = formulaEstimator.estimate({ parameterSizeB: 3.2, quantizationLevel: 'Q4_K_M' }, headroom);
    expect(e.footprintGb).toBeCloseTo(2.25, 2);
    expect(e.quantKnown).toBe(true);
    expect(e.quantUsedForEstimate).toBe('Q4_K_M');
    expect(e.baselineVerdict).toBe('comfortable');
  });
  it('falls back on unknown quant and flags it', () => {
    const e = formulaEstimator.estimate({ parameterSizeB: 12, quantizationLevel: 'UD-Q4_K_XL' }, headroom);
    expect(e.quantKnown).toBe(false);
    expect(e.quantUsedForEstimate).toBe('Q4_K_M');
    expect(e.footprintGb).toBeCloseTo(12 * 0.5625 * 1.25, 2);
  });
  it('returns unknown verdicts when parameter size is unparseable', () => {
    const e = formulaEstimator.estimate({ parameterSizeB: null, quantizationLevel: 'Q4_K_M' }, headroom);
    expect(e).toEqual({
      footprintGb: null, quantKnown: false, quantUsedForEstimate: null,
      baselineVerdict: 'unknown', currentVerdict: 'unknown',
    });
  });
});

describe('classifyVerdict (thresholds from data)', () => {
  it('keeps the 70/95 boundaries', () => {
    expect(classifyVerdict(11.2, 16)).toBe('comfortable'); // exactly 70%
    expect(classifyVerdict(11.3, 16)).toBe('tight');
    expect(classifyVerdict(15.2, 16)).toBe('will-thrash'); // exactly 95% → tight; 15.21 thrash
  });
});
```

(Adjust the boundary assertions to the exact behavior in `src/estimate.ts:55-59`: `> 0.95` thrash, `> 0.7` tight — exact-boundary values stay in the lower class. Verify against the real ported test cases.)

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/formula-estimator.test.ts` — expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/estimators/types.ts`: the interface block above, verbatim.

`src/estimators/formula.ts`:

```ts
import { loadQuantTable, lookupQuant, loadCalibration, loadThresholds } from '../data.js';
import type { Estimator, Estimate, EstimateInput, HeadroomContext, Verdict } from './types.js';

export function classifyVerdict(footprintGb: number, headroomGb: number): Verdict {
  const { tightRatio, thrashRatio } = loadThresholds();
  if (footprintGb > headroomGb * thrashRatio) return 'will-thrash';
  if (footprintGb > headroomGb * tightRatio) return 'tight';
  return 'comfortable';
}

export const formulaEstimator: Estimator = {
  id: 'formula-v1',
  estimate(model: EstimateInput, headroom: HeadroomContext): Estimate {
    if (model.parameterSizeB === null) {
      return {
        footprintGb: null, quantKnown: false, quantUsedForEstimate: null,
        baselineVerdict: 'unknown', currentVerdict: 'unknown',
      };
    }
    const quant = lookupQuant(loadQuantTable(), model.quantizationLevel ?? '');
    const footprintGb = model.parameterSizeB * quant.bytesPerParam * loadCalibration().overheadMultiplier;
    return {
      footprintGb,
      quantKnown: quant.known,
      quantUsedForEstimate: quant.known ? (model.quantizationLevel as string) : quant.id,
      baselineVerdict: classifyVerdict(footprintGb, headroom.baselineHeadroomGb),
      currentVerdict: classifyVerdict(footprintGb, headroom.currentHeadroomGb),
    };
  },
};
```

Then update `src/check.ts` minimally so the build stays green *without* changing behavior: replace its `estimate.js` imports with equivalents. `estimateFootprint`/`classifyVerdict`/`Verdict` → import `classifyVerdict`, `Verdict` from `./estimators/formula.js` / `./estimators/types.js`; replace `estimateFootprint(paramB, quant)` callsites with `formulaEstimator.estimate(...)` result fields (`footprintGb`, `quantKnown`, `quantUsedForEstimate`); replace `MACOS_BASELINE_RESERVE_GB` with `loadThresholds().baselineReserveGb['darwin']`. Delete `src/estimate.ts` and the old `test/estimate.test.ts`.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: everything green **including the three output-guardrail snapshots**. If a guardrail snapshot fails, the carve-out changed behavior — fix the code, never the snapshot.

- [ ] **Step 5: Commit**

```bash
git add -A src/ test/ data/
git commit -m "refactor: carve estimator into Estimator interface backed by data layer"
```

---

### Task: probe-carveout

`src/system-memory.ts` becomes the darwin `SystemProbe`; unknown platforms produce a gap.

**Files:**
- Create: `src/probes/types.ts`, `src/probes/darwin.ts`, `src/probes/registry.ts`, `test/conformance/probe.ts`
- Delete: `src/system-memory.ts`
- Modify: `src/check.ts`, `src/bench.ts`, `src/cli.ts` (import updates only), `test/system-memory.test.ts` → rename to `test/darwin-probe.test.ts`

**Interfaces:**
- Produces (`src/probes/types.ts`):
  - `interface SystemMemoryState` — moved verbatim from `src/system-memory.ts:3-12` (same fields: `totalGb, usedGb, wiredGb, compressorGb, unusedGb, swapTotalGb, swapUsedGb, swapFreeGb`)
  - `interface SystemProbe { platform: string; read(): Promise<SystemMemoryState>; describe(): Promise<Record<string, string>> }` — `describe()` returns the raw command outputs keyed by command name, for diagnostics bundles.
- Produces (`src/probes/darwin.ts`):
  - `createDarwinProbe(exec?: (cmd: string, args: string[]) => string): SystemProbe` — `exec` defaults to an `execFileSync` wrapper; injectable for tests. Keeps the exported parse functions `parseTopOutput`, `parseSwapUsage`, `parseHwMemsize` unchanged.
- Produces (`src/probes/registry.ts`):
  - `selectProbe(platform: string): SystemProbe | null` — returns the darwin probe for `'darwin'`, else `null` (caller records the `unsupported-platform` gap; the registry stays pure).
- Produces (`test/conformance/probe.ts`, mirroring the backend conformance suite):
  - `describeProbeConformance(label: string, setup: () => Promise<SystemProbe>): void` — a vitest `describe` block asserting: `platform` is a non-empty string; `read()` resolves to a `SystemMemoryState` whose eight fields are all finite numbers ≥ 0 with `totalGb > 0`; `describe()` resolves to a `Record<string, string>` with at least one entry and never rejects (command failures become `FAILED: ...` values, not exceptions). The darwin test below runs it; future probes (`linux-probe` phase) run this same suite.

- [ ] **Step 1: Write failing tests**

Rename `test/system-memory.test.ts` to `test/darwin-probe.test.ts`, update its imports to `../src/probes/darwin.js` (parse-function tests carry over unchanged), and add:

```ts
import { createDarwinProbe } from '../src/probes/darwin.js';
import { selectProbe } from '../src/probes/registry.js';
import { readFileSync } from 'node:fs';

const fixtureText = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const fakeExec = (cmd: string, args: string[]): string => {
  if (cmd === 'top') return fixtureText('top-output.txt');
  if (cmd === 'sysctl' && args[0] === 'vm.swapusage') return fixtureText('swapusage-output.txt');
  if (cmd === 'sysctl' && args[0] === '-n') return fixtureText('hw-memsize.txt');
  throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
};

describeProbeConformance('darwin', async () => createDarwinProbe(fakeExec));

describe('darwin probe', () => {
  it('read() assembles SystemMemoryState from the three commands', async () => {
    const state = await createDarwinProbe(fakeExec).read();
    expect(state.totalGb).toBeGreaterThan(0);
    expect(state.wiredGb).toBeGreaterThan(0);
    expect(state.swapTotalGb).toBeGreaterThanOrEqual(0);
  });
  it('describe() returns the raw outputs for diagnostics', async () => {
    const evidence = await createDarwinProbe(fakeExec).describe();
    expect(Object.keys(evidence).sort()).toEqual(['sysctl -n hw.memsize', 'sysctl vm.swapusage', 'top -l 1 -s 0']);
    expect(evidence['top -l 1 -s 0']).toContain('PhysMem');
  });
});

describe('probe registry', () => {
  it('selects darwin', () => expect(selectProbe('darwin')?.platform).toBe('darwin'));
  it('returns null for unsupported platforms', () => expect(selectProbe('freebsd')).toBeNull());
});
```

- [ ] **Step 2: Run to verify fail, then implement**

`src/probes/darwin.ts` — move the whole of `src/system-memory.ts` here, re-shaping only the entry point:

```ts
import { execFileSync } from 'node:child_process';
import type { SystemProbe, SystemMemoryState } from './types.js';
// ... parseTopOutput, parseSwapUsage, parseHwMemsize moved verbatim ...

type Exec = (cmd: string, args: string[]) => string;
const realExec: Exec = (cmd, args) => execFileSync(cmd, args).toString();

export function createDarwinProbe(exec: Exec = realExec): SystemProbe {
  const commands = {
    'top -l 1 -s 0': () => exec('top', ['-l', '1', '-s', '0']),
    'sysctl vm.swapusage': () => exec('sysctl', ['vm.swapusage']),
    'sysctl -n hw.memsize': () => exec('sysctl', ['-n', 'hw.memsize']),
  };
  return {
    platform: 'darwin',
    async read(): Promise<SystemMemoryState> {
      const topText = commands['top -l 1 -s 0']();
      const swapText = commands['sysctl vm.swapusage']();
      const memText = commands['sysctl -n hw.memsize']();
      const { usedGb, wiredGb, compressorGb, unusedGb } = parseTopOutput(topText);
      const { swapTotalGb, swapUsedGb, swapFreeGb } = parseSwapUsage(swapText);
      return { totalGb: parseHwMemsize(memText), usedGb, wiredGb, compressorGb, unusedGb, swapTotalGb, swapUsedGb, swapFreeGb };
    },
    async describe(): Promise<Record<string, string>> {
      const out: Record<string, string> = {};
      for (const [name, run] of Object.entries(commands)) {
        try { out[name] = run(); } catch (err) { out[name] = `FAILED: ${(err as Error).message}`; }
      }
      return out;
    },
  };
}
```

`src/probes/registry.ts`:

```ts
import { createDarwinProbe } from './darwin.js';
import type { SystemProbe } from './types.js';

export function selectProbe(platform: string): SystemProbe | null {
  if (platform === 'darwin') return createDarwinProbe();
  return null;
}
```

Update `src/check.ts` / `src/bench.ts` / `src/cli.ts`: `SystemMemoryState` now imports from `./probes/types.js`; the `readSystemMemory` dep type becomes `() => Promise<SystemMemoryState> | SystemMemoryState` **only if needed transiently** — prefer switching the deps to `read: () => Promise<SystemMemoryState>` now and awaiting it, since `check-refactor`/`bench-refactor` land on the probe anyway. cli.ts wires `readSystemMemory: () => selectProbe(process.platform)!.read()` for now (the null case is handled properly in `cli-wiring`).

- [ ] **Step 3: Run the full suite**

Run: `npm test && npm run typecheck` — expected: green, guardrail snapshots untouched.

- [ ] **Step 4: Commit**

```bash
git add -A src/ test/
git commit -m "refactor: carve system-memory into SystemProbe with darwin implementation"
```

---

### Task: ollama-backend

Define the `Backend` interface and wrap the existing Ollama client + scraper as its first implementation, with a reusable conformance suite.

**Files:**
- Create: `src/types.ts`, `src/backends/types.ts`, `src/backends/ollama/index.ts`
- Move: `src/ollama-client.ts` → `src/backends/ollama/client.ts`, `src/scrape.ts` → `src/backends/ollama/scrape.ts` (contents unchanged except the move)
- Create: `test/conformance/backend.ts`
- Test: `test/ollama-backend.test.ts`; update import paths in `test/ollama-client.test.ts` and `test/scrape.test.ts`

**Interfaces:**
- Produces (`src/types.ts`):
  ```ts
  export interface ModelInfo {
    name: string;
    source: 'local' | 'remote';
    url: string | null;
    parameterSizeB: number | null;
    quantizationLevel: string | null;
    diskSizeBytes: number | null;
  }
  export interface SkippedModel { name: string; reason: string }
  export interface LocalModels { models: ModelInfo[]; skipped: SkippedModel[] }
  export interface LoadedModel { name: string; sizeVramGb: number; quantizationLevel: string | null }
  export interface GenerateResult {
    evalCount: number | null;
    evalDurationSeconds: number | null;
    loadDurationSeconds: number | null;
    totalDurationSeconds: number | null;
  }
  export interface Detection { detected: boolean; version: string | null; evidence: Record<string, unknown> }
  ```
- Produces (`src/backends/types.ts`):
  ```ts
  import type { Detection, LocalModels, ModelInfo, LoadedModel, GenerateResult } from '../types.js';
  export interface Backend {
    id: string;
    displayName: string;
    detect(): Promise<Detection>;
    localModels(): Promise<LocalModels>;
    /** Resolves null on timeout — a meaningful result, not an error. */
    generate(model: string, prompt: string, timeoutMs?: number): Promise<GenerateResult | null>;
    // Optional capabilities — absent method = backend can't do it; callers degrade and say so.
    remoteCandidates?(query?: string): Promise<ModelInfo[]>;
    loadedModels?(): Promise<LoadedModel[]>;
    pull?(model: string): Promise<void>;
    unload?(model: string): Promise<void>;
  }
  ```
- Produces (`src/backends/ollama/index.ts`): `ollamaBackend: Backend` with `id: 'ollama'`, `displayName: 'Ollama'`, all optional capabilities implemented. Mapping rules:
  - `detect()`: GET `/api/version` → `{ detected: true, version, evidence: { baseUrl } }`; connection failure → `{ detected: false, version: null, evidence: { baseUrl, error: message } }`. Never throws.
  - `localModels()`: `fetchTags()`; cloud models (`isCloudModel`) go to `skipped` with `reason: 'cloud model (runs remotely, not sized against this machine)'`; the rest map to `ModelInfo` with `parameterSizeB: parseParameterSize(details.parameter_size)`, `quantizationLevel: details.quantization_level || null`, `diskSizeBytes: size`, `url: null`, `source: 'local'`.
  - `remoteCandidates(query)`: `scrapeSearch(query)` mapped to `ModelInfo` (`source: 'remote'`, `quantizationLevel: null`, `diskSizeBytes: null`).
  - `loadedModels()`: `fetchPs()` → `{ name, sizeVramGb: size_vram / 1e9, quantizationLevel: details.quantization_level || null }`.
  - `generate()`: existing `generate()`; a non-null response maps durations ns→seconds (`eval_count ?? null`, `eval_duration / 1e9`, etc. — null when the field is undefined). **`evalDurationSeconds` is the raw duration; tokens/sec stays computed in bench.**
  - `pull` / `unload`: existing `pullModel` / `unloadModel`.
- Produces (`test/conformance/backend.ts`): `describeBackendConformance(label: string, setup: () => Promise<Backend>): void` — a vitest `describe` block asserting: non-empty `id`/`displayName`; `detect()` resolves to a `Detection` shape and never rejects; `localModels()` rows have `source: 'local'` and string names; every declared optional capability is a function. Future backends (`llama-server-backend` phase etc.) run this same suite.

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/backends/ollama
git mv src/ollama-client.ts src/backends/ollama/client.ts
git mv src/scrape.ts src/backends/ollama/scrape.ts
```

Fix the now-broken imports in `src/check.ts`, `src/bench.ts`, `src/cli.ts`, `test/ollama-client.test.ts`, `test/scrape.test.ts` (path change only). Run `npm test` — green before proceeding.

- [ ] **Step 2: Write failing tests**

`test/ollama-backend.test.ts` stubs `globalThis.fetch` with the existing fixtures (`api-tags.json`, `api-ps-loaded.json`) the same way `test/ollama-client.test.ts` does (read it and copy its stubbing approach), then:

```ts
import { describeBackendConformance } from './conformance/backend.js';
import { ollamaBackend } from '../src/backends/ollama/index.js';

describeBackendConformance('ollama', async () => ollamaBackend);

describe('ollamaBackend mapping', () => {
  it('localModels maps tags and skips cloud models', async () => {
    const { models, skipped } = await ollamaBackend.localModels();
    expect(models.every((m) => m.source === 'local')).toBe(true);
    expect(models[0]).toHaveProperty('parameterSizeB');
    // api-tags.json contains at least one remote_host model — it must land in skipped
    expect(skipped.length).toBeGreaterThan(0);
  });
  it('loadedModels converts size_vram to GB', async () => {
    const loaded = await ollamaBackend.loadedModels!();
    expect(loaded[0].sizeVramGb).toBeGreaterThan(0);
    expect(loaded[0].sizeVramGb).toBeLessThan(100); // GB, not bytes
  });
  it('detect() reports unreachable without throwing', async () => {
    // stub fetch to reject
    const detection = await ollamaBackend.detect();
    expect(detection.detected).toBe(false);
    expect(detection.evidence).toHaveProperty('error');
  });
});
```

(If `api-tags.json` has no cloud model, add one to the fixture — a model entry with `remote_host` set — and confirm existing tests still pass.)

- [ ] **Step 3: Run to verify fail, implement `index.ts` and the conformance suite, run to verify pass**

Run: `npx vitest run test/ollama-backend.test.ts` then implement per the mapping rules above, then re-run.
Expected: PASS. Also `npm test && npm run typecheck` — full suite green.

- [ ] **Step 4: Commit**

```bash
git add -A src/ test/
git commit -m "feat: define Backend interface; wrap Ollama client as first implementation"
```

---

### Task: backend-registry

One place that knows every backend and which are present.

**Files:**
- Create: `src/backends/registry.ts`
- Test: `test/backend-registry.test.ts`

**Interfaces:**
- Produces (consumed by `cli-wiring`):
  - `allBackends(): Backend[]` — static list, currently `[ollamaBackend]`.
  - `findBackend(id: string): Backend | null`
  - `detectBackends(backends?: Backend[]): Promise<Array<{ backend: Backend; detection: Detection }>>` — runs `detect()` on each (parallel, `Promise.all`), returns only detected ones. Empty array = the `no-backend-detected` gap (recorded by the caller, not here).

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { allBackends, findBackend, detectBackends } from '../src/backends/registry.js';
import type { Backend } from '../src/backends/types.js';

const fakeBackend = (id: string, detected: boolean): Backend => ({
  id, displayName: id,
  detect: async () => ({ detected, version: null, evidence: {} }),
  localModels: async () => ({ models: [], skipped: [] }),
  generate: async () => null,
});

describe('backend registry', () => {
  it('lists ollama', () => {
    expect(allBackends().map((b) => b.id)).toContain('ollama');
    expect(findBackend('ollama')?.id).toBe('ollama');
    expect(findBackend('nope')).toBeNull();
  });
  it('detectBackends keeps only detected ones', async () => {
    const hits = await detectBackends([fakeBackend('a', true), fakeBackend('b', false)]);
    expect(hits.map((h) => h.backend.id)).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run to verify fail, implement, run to verify pass**

```ts
import { ollamaBackend } from './ollama/index.js';
import type { Backend } from './types.js';
import type { Detection } from '../types.js';

const BACKENDS: Backend[] = [ollamaBackend];

export function allBackends(): Backend[] {
  return [...BACKENDS];
}

export function findBackend(id: string): Backend | null {
  return BACKENDS.find((b) => b.id === id) ?? null;
}

export async function detectBackends(
  backends: Backend[] = BACKENDS
): Promise<Array<{ backend: Backend; detection: Detection }>> {
  const results = await Promise.all(backends.map(async (backend) => ({ backend, detection: await backend.detect() })));
  return results.filter((r) => r.detection.detected);
}
```

Run: `npx vitest run test/backend-registry.test.ts` — expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/backends/registry.ts test/backend-registry.test.ts
git commit -m "feat: add backend registry with detection"
```

---

### Task: check-refactor

`runCheck` consumes Backend + SystemProbe + Estimator + GapCollector. Output stays byte-identical.

**Files:**
- Modify: `src/check.ts`, `test/check.test.ts`, `test/output-guardrail.test.ts` (deps wiring only — snapshots untouched)

**Interfaces:**
- Produces (new `runCheck` signature, consumed by `cli-wiring`):
  ```ts
  export interface CheckDeps {
    backend: Backend;
    probe: SystemProbe;
    estimator: Estimator;
    gaps: GapCollector;
  }
  export async function runCheck(query: string, deps: CheckDeps): Promise<CheckResult>
  ```
- `CheckRow` and `CheckResult` keep their exact current shapes (`src/check.ts:14-37`) so `src/format.ts` needs no changes — gaps live in the caller-owned `GapCollector`, **not** on `CheckResult`, precisely so `formatCheckJson` output is unchanged.
- Behavior mapping from current code:
  - `fetchTags`+`isCloudModel` filtering → `backend.localModels()`; `cloudModels` = `skipped.map((s) => s.name)`.
  - `fetchPs` → `backend.loadedModels?.()` (Ollama has it; if absent, no measured rows).
  - `readSystemMemory()` → `await probe.read()`.
  - `MACOS_BASELINE_RESERVE_GB` → `loadThresholds().baselineReserveGb[probe.platform] ?? 8`.
  - `estimateFootprint` → `estimator.estimate({ parameterSizeB, quantizationLevel }, { baselineHeadroomGb, currentHeadroomGb })`; measured rows still use `classifyVerdict` directly on the measured GB.
  - Scrape → `backend.remoteCandidates?.(query)`; failure still sets `scrapeWarning` (same message text) **and** records a `scrape-failed` gap.
  - New gap: after building a local row where `quantizationLevel` is non-null/non-empty but the estimate came back `quantKnown: false`, record `{ kind: 'unknown-quant', summary: 'unknown quantization "<raw>"', evidence: { model, quantizationLevel } }`. (Remote rows estimate with `quantizationLevel: null` — no gap, same as today's `''` behavior.)

- [ ] **Step 1: Update `test/check.test.ts` and the guardrail test wiring**

Wrap the existing fixture deps in a fixture `Backend`/`SystemProbe` (a small helper both test files share, e.g. exported from `test/helpers/fixture-backend.ts`):

```ts
import type { Backend } from '../../src/backends/types.js';
import type { SystemProbe, SystemMemoryState } from '../../src/probes/types.js';

export function fixtureBackend(overrides: Partial<Backend> = {}): Backend { /* wraps api-tags.json, api-ps-loaded.json, ollama-search-mlx.html through the same mapping helpers the real ollamaBackend uses (import and reuse its mapping functions — do not duplicate the mapping) */ }
export function fixtureProbe(state: SystemMemoryState): SystemProbe {
  return { platform: 'darwin', read: async () => state, describe: async () => ({}) };
}
```

To make the mapping reusable, export the pure mapping functions from `src/backends/ollama/index.ts` (`mapTagsToLocalModels(tags)`, `mapPsToLoaded(ps)`, `mapCandidates(candidates)`) and build both `ollamaBackend` and `fixtureBackend` from them.

Add new assertions to `test/check.test.ts`:

```ts
it('records an unknown-quant gap once per unknown string', async () => { /* fixture tags with quantization_level UD-Q4_K_XL on two models → gaps.list() has one unknown-quant gap */ });
it('records a scrape-failed gap and still returns local rows', async () => { /* remoteCandidates rejects → scrapeWarning set, gap recorded, rows non-empty */ });
it('produces no measured rows when the backend lacks loadedModels', async () => { /* fixtureBackend({ loadedModels: undefined }) → every row estimateSource === 'estimated' */ });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run test/check.test.ts` — expected: FAIL (new deps shape + gap assertions).

- [ ] **Step 3: Refactor `src/check.ts` per the mapping table**

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: green. The three guardrail snapshot files must be unmodified (`git status` shows no changes under `test/fixtures/guardrail-*`).

- [ ] **Step 5: Commit**

```bash
git add -A src/ test/
git commit -m "refactor: runCheck consumes Backend/SystemProbe/Estimator with gap reporting"
```

---

### Task: bench-refactor

`runBench` consumes Backend capabilities and degrades when they're absent.

**Files:**
- Modify: `src/bench.ts`, `src/cli.ts` (bench wiring + spinner wrapper), `src/format.ts` (print notes when non-empty), `test/bench.test.ts`, `test/output-guardrail.test.ts` (add `notes: []` to its `BENCH` fixture object — required by the widened `BenchResult` type; the stored snapshot must not change)

**Interfaces:**
- Produces (consumed by `cli-wiring`):
  ```ts
  export interface BenchDeps { backend: Backend; probe: SystemProbe }
  export interface BenchResult {
    model: string;
    status: 'completed' | 'timed-out';
    sizeVramGb: number | null;
    evalTokensPerSecond: number | null;
    loadDurationSeconds: number | null;
    totalDurationSeconds: number | null;
    memoryBefore: SystemMemoryState;
    memoryAfter: SystemMemoryState;
    /** Degradation messages, e.g. missing loadedModels/unload capability. Empty for Ollama. */
    notes: string[];
  }
  export async function runBench(model: string, deps: BenchDeps): Promise<BenchResult>
  ```
- Degradation rules (each adds a note):
  - No `pull` and model not in `localModels()`: throw `Error("<backend> can't pull models — pull '<model>' yourself, then re-run")` (fail fast, not a note).
  - No `loadedModels`: `sizeVramGb: null`, note `"<displayName> can't report per-model VRAM; footprint shown is the system-memory delta only"`.
  - No `unload`: note `"<displayName> can't unload models — '<model>' is still loaded"`, and skip the unload step (the try/finally from `src/bench.ts:73-80` only wraps unload when the capability exists).
  - tokens/sec math moves here: `evalTokensPerSecond = evalCount && evalDurationSeconds ? evalCount / evalDurationSeconds : null` from `GenerateResult`.
- `src/cli.ts`'s `benchDepsWithProgress` becomes `withProgress(backend: Backend, color: boolean): Backend` — same spinner behavior (`src/cli.ts:43-88`), wrapping `pull`/`generate`/`unload` when present, passing others through.
- `src/format.ts`'s `formatBenchResult` prints `notes` lines (via `warn`) only when non-empty — so Ollama output is unchanged.

- [ ] **Step 1: Update `test/bench.test.ts`**

Port existing cases to the new deps shape using `fixtureBackend`/`fixtureProbe` from `test/helpers/fixture-backend.ts`, and add:

```ts
it('degrades without loadedModels: null vram plus a note', async () => { /* fixtureBackend({ loadedModels: undefined }) → result.sizeVramGb === null, result.notes has one VRAM note */ });
it('fails fast when model absent and backend cannot pull', async () => { /* fixtureBackend({ pull: undefined }) + model not in fixtures → rejects with "can't pull" */ });
it('still unloads when generate throws', async () => { /* generate rejects → unload spy was called (preserves src/bench.ts:63-80 exception safety) */ });
it('reports timed-out when generate resolves null', async () => { /* preserves current timeout semantics */ });
```

- [ ] **Step 2: Run to verify fail, refactor `src/bench.ts` and `src/cli.ts`, run to verify pass**

Run: `npx vitest run test/bench.test.ts`, refactor, re-run.
Then: `npm test && npm run typecheck` — guardrail bench snapshot must be untouched (an empty `notes` array must add zero output lines).

- [ ] **Step 3: Commit**

```bash
git add -A src/ test/
git commit -m "refactor: runBench consumes Backend capabilities with declared degradation"
```

---

### Task: diagnostics-bundle

One bundle format for every gap.

**Files:**
- Create: `src/diagnostics.ts`
- Test: `test/diagnostics.test.ts`

**Interfaces:**
- Produces (consumed by `cli-wiring` and `contribution-prompts`):
  ```ts
  export interface DiagnosticsInput {
    version: string;                                  // from package.json
    platform: { platform: string; release: string; arch: string };
    gaps: Gap[];
    probeEvidence: Record<string, string> | null;     // SystemProbe.describe(), null if no probe
  }
  export interface WriteOptions { dir?: string; now?: Date }   // both default: cwd, new Date()
  export function buildBundle(input: DiagnosticsInput): string  // scrubbed JSON text
  export function writeDiagnosticsBundle(input: DiagnosticsInput, opts?: WriteOptions): string  // returns absolute path
  ```
- Filename: `llmfit-diagnostics-<YYYYMMDD-HHmmss>.json` (from `opts.now`, local time).
- Scrubbing: in the serialized JSON text, replace every occurrence of `os.homedir()` with `~` and of `os.hostname()` with `<host>`.

- [ ] **Step 1: Write failing tests**

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir, homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBundle, writeDiagnosticsBundle } from '../src/diagnostics.js';

const input = {
  version: '0.1.0',
  platform: { platform: 'freebsd', release: '14.0', arch: 'arm64' },
  gaps: [{ kind: 'unsupported-platform' as const, summary: 'no SystemProbe for freebsd', evidence: { platform: 'freebsd' } }],
  probeEvidence: { 'some-command': `output mentioning ${homedir()} and ${hostname()}` },
};

describe('diagnostics bundle', () => {
  it('serializes version, platform, gaps, and evidence', () => {
    const bundle = JSON.parse(buildBundle(input));
    expect(bundle.version).toBe('0.1.0');
    expect(bundle.gaps).toHaveLength(1);
    expect(bundle.probeEvidence['some-command']).toContain('output mentioning');
  });
  it('scrubs home directory and hostname', () => {
    const text = buildBundle(input);
    expect(text).not.toContain(homedir());
    if (hostname().length > 0) expect(text).not.toContain(hostname());
    expect(text).toContain('~');
  });
  it('writes a timestamped file and returns its path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llmfit-test-'));
    const path = writeDiagnosticsBundle(input, { dir, now: new Date('2026-08-05T14:30:00') });
    expect(path).toBe(join(dir, 'llmfit-diagnostics-20260805-143000.json'));
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe('0.1.0');
  });
});
```

- [ ] **Step 2: Run to verify fail, implement, run to verify pass**

```ts
import { writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import type { Gap } from './gaps.js';

export interface DiagnosticsInput {
  version: string;
  platform: { platform: string; release: string; arch: string };
  gaps: Gap[];
  probeEvidence: Record<string, string> | null;
}
export interface WriteOptions { dir?: string; now?: Date }

export function buildBundle(input: DiagnosticsInput): string {
  let text = JSON.stringify(input, null, 2);
  text = text.split(homedir()).join('~');
  const host = hostname();
  if (host.length > 0) text = text.split(host).join('<host>');
  return text;
}

function timestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function writeDiagnosticsBundle(input: DiagnosticsInput, opts: WriteOptions = {}): string {
  const path = resolve(join(opts.dir ?? process.cwd(), `llmfit-diagnostics-${timestamp(opts.now ?? new Date())}.json`));
  writeFileSync(path, buildBundle(input));
  return path;
}
```

Run: `npx vitest run test/diagnostics.test.ts` — expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/diagnostics.ts test/diagnostics.test.ts
git commit -m "feat: add scrubbed diagnostics bundle writer"
```

---

### Task: contribution-prompts

The two exits: paste-to-agent prompt and pre-filled issue URL, templated per gap kind.

**Files:**
- Create: `src/prompts.ts`
- Test: `test/prompts.test.ts`

**Interfaces:**
- Produces (consumed by `cli-wiring`):
  ```ts
  export interface PromptContext { bundlePath: string; repoUrl: string }
  export function repoUrl(): string          // package.json "repository" (string or {url}), stripped of "git+"/".git"
  export function agentPromptFor(gap: Gap, ctx: PromptContext): string
  export function issueUrlFor(gap: Gap, ctx: { repoUrl: string }): string
  ```
- `agentPromptFor` templates, one per `GapKind` (exact text below is the deliverable — golden-tested):
  - `unsupported-platform`:
    ```
    Clone <repoUrl> and add support for my platform.
    My machine produced this diagnostics bundle: <bundlePath> — it contains the raw
    command outputs (or failures) from the memory probe attempt.
    Implement the SystemProbe interface for this platform. Reference implementation:
    src/probes/darwin.ts. Interface contract and fixture conventions: docs/adapters.md.
    Add fixtures from the bundle's raw outputs, register the probe in
    src/probes/registry.ts, run the conformance tests, and open a PR.
    ```
  - `unknown-quant`:
    ```
    Clone <repoUrl>. My models use a quantization llmfit doesn't know: see the
    unknown-quant gap in <bundlePath>.
    Add an entry or alias for it to data/quants.json with a bytes-per-param value,
    citing a source for the value in the PR body. See docs/adapters.md ("Quantization
    table") for the format, then run the tests and open a PR.
    ```
  - `no-backend-detected`:
    ```
    Clone <repoUrl>. llmfit found no supported inference backend on my machine: see
    the no-backend-detected gap in <bundlePath> for what it probed.
    If I'm running a backend it should know (check the bundle evidence), implement the
    Backend interface for it. Reference implementation: src/backends/ollama/. Contract
    and fixture conventions: docs/adapters.md. Register it in src/backends/registry.ts,
    run the conformance tests, and open a PR.
    ```
  - `backend-response-unexpected` and `scrape-failed` share one template:
    ```
    Clone <repoUrl>. llmfit hit a response it couldn't handle: see the <kind> gap in
    <bundlePath> for the raw response.
    Fix the parsing (or add graceful handling) where the gap's evidence points, add a
    fixture reproducing my response, run the tests, and open a PR.
    ```
- `issueUrlFor`: `<repoUrl>/issues/new?title=<urlencoded "[gap] <summary>">&body=<urlencoded body>` where body = gap kind, summary, and `evidence` as a fenced JSON block, truncated to 4000 characters of body before encoding (GitHub URL limits).

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { agentPromptFor, issueUrlFor, repoUrl } from '../src/prompts.js';

const gap = { kind: 'unsupported-platform' as const, summary: 'no SystemProbe for freebsd', evidence: { platform: 'freebsd' } };
const ctx = { bundlePath: '/tmp/llmfit-diagnostics-20260805-143000.json', repoUrl: 'https://github.com/technicalpickles/llmfit' };

describe('contribution prompts', () => {
  it('repoUrl comes from package.json and is a clean https URL', () => {
    expect(repoUrl()).toMatch(/^https:\/\/github\.com\//);
    expect(repoUrl()).not.toMatch(/\.git$|^git\+/);
  });
  it('unsupported-platform prompt names the interface, reference impl, and bundle', () => {
    const prompt = agentPromptFor(gap, ctx);
    expect(prompt).toContain('SystemProbe');
    expect(prompt).toContain('src/probes/darwin.ts');
    expect(prompt).toContain(ctx.bundlePath);
    expect(prompt).toContain('docs/adapters.md');
  });
  it('unknown-quant prompt points at data/quants.json', () => {
    const prompt = agentPromptFor({ ...gap, kind: 'unknown-quant' }, ctx);
    expect(prompt).toContain('data/quants.json');
  });
  it('issue URL encodes title and evidence', () => {
    const url = issueUrlFor(gap, { repoUrl: ctx.repoUrl });
    expect(url).toContain('https://github.com/technicalpickles/llmfit/issues/new?');
    expect(url).toContain(encodeURIComponent('[unsupported-platform] no SystemProbe for freebsd'));
    expect(decodeURIComponent(url)).toContain('"platform": "freebsd"');
  });
  it('issue body is truncated for huge evidence', () => {
    const big = { ...gap, evidence: { blob: 'x'.repeat(20000) } };
    expect(issueUrlFor(big, { repoUrl: ctx.repoUrl }).length).toBeLessThan(9000);
  });
});
```

- [ ] **Step 2: Run to verify fail, implement, run to verify pass**

Implement with a `Record<GapKind, (gap, ctx) => string>` template map (the two shared kinds referencing one function); `repoUrl()` reads `package.json` via `readFileSync(new URL('../package.json', import.meta.url))`, accepts `repository` as string or `{ url }`, strips leading `git+` and trailing `.git`. **Note:** this task requires `package.json` to have a `repository` field — add `"repository": { "type": "git", "url": "https://github.com/technicalpickles/llmfit" }` now (the rename task finishes the rest of package.json).

Run: `npx vitest run test/prompts.test.ts` — expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/prompts.ts test/prompts.test.ts package.json
git commit -m "feat: add per-gap agent prompts and pre-filled issue URLs"
```

---

### Task: cli-wiring

The CLI turns gaps into the bundle + both exits; adds `--backend` and `--diagnose`.

**Files:**
- Modify: `src/cli.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: everything above — `detectBackends`/`findBackend`, `selectProbe`, `formulaEstimator`, `GapCollector`, `writeDiagnosticsBundle`, `agentPromptFor`/`issueUrlFor`/`repoUrl`, new `runCheck`/`runBench` signatures, `withProgress`.
- Produces (CLI behavior):
  - `check [--json] [-q query] [--no-color] [--backend <id>] [--diagnose]`
  - `bench <model> [--no-color] [--backend <id>]`
  - Wiring per command:
    1. Resolve probe: `selectProbe(process.platform)`. `null` → record `unsupported-platform` gap with `evidence: { platform: process.platform, release: os.release(), arch: os.arch() }` → go to gap exit (below) and exit 1 (check can't classify anything without memory numbers).
    2. Resolve backend(s): `--backend <id>` → `findBackend` (unknown id → plain error listing known ids, exit 1; not a gap). Otherwise `detectBackends()`. Zero detected → record `no-backend-detected` gap with `evidence: { probed: allBackends().map(b => b.id) }` → gap exit, exit 1.
    3. `check`: run `runCheck` per detected backend, printing `formatCheckTable`. With exactly one backend, output is exactly today's. With several, print a `label('<displayName>', color)` heading line + blank line before each table (only in the multi-backend case, preserving the guardrail). `--json` with multiple backends emits `{ "<id>": <CheckResult>, ... }`; with one backend it stays today's bare `CheckResult` JSON.
    4. Gap exit (also runs after a successful check that recorded gaps, and unconditionally with `--diagnose`): write the bundle (`probeEvidence` from `probe?.describe() ?? null`), then print to **stderr**: a `warn` line `Hit <n> thing(s) llmfit doesn't support yet — diagnostics written to <path>`, then for each gap: blank line, `label('To add support with an AI agent, paste this prompt:')`, the agent prompt, `label('Or file it:')`, the issue URL. Uses `repoUrl()` for both.
  - `bench` degradation notes print via `formatBenchResult` (done in `bench-refactor`).

- [ ] **Step 1: Extend `test/cli.test.ts`**

Follow the existing test approach in `test/cli.test.ts` (read it first — it exercises `createProgram()`). Add, using injected fakes where the current tests inject, or by extracting the wiring into an exported `runCheckCommand(opts, io)` helper if the current tests can't reach it:

```ts
it('exits 1 with agent prompt + issue link when no backend is detected', async () => { /* stderr contains "paste this prompt", "issues/new?", exit code 1, bundle written to a temp cwd */ });
it('--backend with unknown id lists known backends and exits 1 without a bundle', async () => {});
it('unknown platform produces unsupported-platform prompt', async () => { /* selectProbe stubbed null */ });
it('--diagnose writes a bundle even when nothing failed', async () => {});
```

- [ ] **Step 2: Run to verify fail, implement the wiring, run to verify pass**

Run: `npx vitest run test/cli.test.ts`, implement, re-run.
Then `npm test && npm run typecheck` — guardrail snapshots untouched.

- [ ] **Step 3: Smoke-test on the real machine**

Run: `npm run build && node dist/cli.js check` (Ollama running)
Expected: today's normal table, no gap output.
Run: `node dist/cli.js check --diagnose`
Expected: table + a `llmfit-diagnostics-*.json` in cwd + prompt/issue text on stderr. Delete the bundle file afterward.

- [ ] **Step 4: Commit**

```bash
git add -A src/ test/
git commit -m "feat: wire gaps into diagnostics bundle with agent-prompt and issue exits"
```

---

### Task: adapters-doc

The contribution guide every generated prompt points at.

**Files:**
- Create: `docs/adapters.md`

**Interfaces:**
- Consumes: the real interfaces as they now exist in `src/backends/types.ts`, `src/probes/types.ts`, `src/estimators/types.ts`, `src/data.ts` — quote them from the code, don't paraphrase from memory.

- [ ] **Step 1: Write `docs/adapters.md`**

Audience: an AI agent (or human) landing here from a generated prompt, with a diagnostics bundle in hand. Sections, each concrete:

1. **How llmfit fits together** — three interfaces + data layer, one paragraph each, with file paths.
2. **Adding a SystemProbe** — the interface (quoted), what each field of `SystemMemoryState` means (crib the semantics from the README's "current headroom" section: `wiredGb` = genuinely unreclaimable memory), the darwin reference implementation walk-through, how to turn bundle `probeEvidence` into `test/fixtures/` files, registering in `src/probes/registry.ts`, adding a `baselineReserveGb` entry to `data/thresholds.json`, and the conformance expectations.
3. **Adding a Backend** — the interface (quoted), which capabilities are optional and what absence means for `check`/`bench` output, the Ollama reference walk-through (`detect` via version endpoint, mapping to `ModelInfo`), fixture conventions (captured raw API responses in `test/fixtures/`), `describeBackendConformance` usage, registering in `src/backends/registry.ts`.
4. **Quantization table** — `data/quants.json` format, when to add an alias vs a new entry, requirement: cite a source for bytes-per-param in the PR body.
5. **Calibration** — how `bench` output relates to `data/calibration.json`, and that every multiplier change needs a provenance row.
6. **Checklist before opening a PR** — `npm test`, `npm run typecheck`, conformance suite green, fixtures added, no network calls in tests.

- [ ] **Step 2: Verify every path and identifier in the doc exists**

Run: `grep -oE '(src|data|test|docs)/[A-Za-z0-9._/-]+' docs/adapters.md | sort -u | while read f; do [ -e "$f" ] || echo "MISSING: $f"; done`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add docs/adapters.md
git commit -m "docs: add adapter contribution guide for agents and humans"
```

---

### Task: llmfit-rename

Rename the package and CLI; rewrite the README; prep for publish.

**Files:**
- Modify: `package.json`, `src/cli.ts`, `README.md`, `.gitignore` (add `llmfit-diagnostics-*.json`)

**Interfaces:**
- Consumes: `repoUrl()` reads `package.json.repository` — set in `contribution-prompts`; keep it consistent here.

- [ ] **Step 1: Update `package.json`**

```json
{
  "name": "llmfit",
  "version": "0.2.0",
  "description": "Which local LLMs actually fit this machine? Checks models against real memory headroom.",
  "type": "module",
  "bin": { "llmfit": "./dist/cli.js" },
  "files": ["dist", "data", "README.md"],
  "repository": { "type": "git", "url": "https://github.com/technicalpickles/llmfit" }
}
```

(merging with the existing scripts/deps/engines fields, which are unchanged). Also add `"prepublishOnly": "npm test && npm run build"` to scripts.

- [ ] **Step 2: Update the CLI name**

In `src/cli.ts`: `.name('llmfit')` and description `"Which local LLMs actually fit this machine?"`. Grep for remaining user-facing `ollama-scope` strings: `grep -rn "ollama-scope" src/ test/ --include="*.ts"` — anything user-facing changes to `llmfit`; fixture file paths and the ollama backend's own identifiers stay.

- [ ] **Step 3: Rewrite `README.md`**

Structure (replacing the current Ollama-centric framing; keep the "current headroom" explanation section nearly verbatim since it's still true):

- **llmfit** — one-paragraph pitch: checks local models against the machine's *real* memory headroom, not just "does it technically load"; supports pluggable backends/platforms; today: Ollama on macOS.
- **Install/usage**: `npx llmfit check`, `npx llmfit bench <model>`, `--backend`, `--json`, `OLLAMA_HOST` note.
- **Reading the table** and **About "current headroom"**: carried over from current README with names updated.
- **When llmfit doesn't support your setup**: the pitch for the gap flow — run hits a gap → diagnostics bundle + a paste-to-your-agent prompt + an issue link. Point at `docs/adapters.md`.
- **Supported today / roadmap**: Ollama + macOS now; `linux-probe`, `llama-server-backend`, `unsloth-backend` phases next.
- **Design docs**: link both specs.

- [ ] **Step 4: Full verification**

Run: `npm test && npm run typecheck && npm run build && node dist/cli.js --help`
Expected: all green; help shows `llmfit`.
Run: `npm pack --dry-run`
Expected: tarball contains `dist/`, `data/`, `README.md`, `package.json` — and **not** `src/`, `test/`, `docs/`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: rename to llmfit and prep npm packaging"
```

- [ ] **Step 6: Manual human steps (not for the executing agent — surface these to Josh at the end)**

1. Rename the GitHub repo `ollama-scope` → `llmfit`, make it public.
2. Update the local remote: `git remote set-url origin git@github.com:technicalpickles/llmfit.git`.
3. `npm publish` (needs npm auth; `prepublishOnly` runs tests + build).
4. Smoke-test from clean: `npx llmfit@latest check`.

---

## Execution notes

- Task order matters: `output-guardrail` first, `llmfit-rename` last; the middle tasks go in the order written (each consumes the previous ones' interfaces).
- If any task breaks a `guardrail-*` snapshot, that task has a bug. The snapshot is the spec.
- After the final task, capture followups (the three roadmap phases) as taskwarrior tasks per Josh's workflow rules.
