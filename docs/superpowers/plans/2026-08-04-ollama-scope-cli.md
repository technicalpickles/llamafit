# ollama-scope CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `ollama-scope` CLI (TypeScript/Node) that helps decide which Ollama models are right-sized for this machine, via a static `check` command (metadata + live memory analysis, no side effects) and a live `bench <model>` command (real pull/load/generate/measure).

**Architecture:** Small focused modules — an Ollama HTTP API client, a macOS system-memory reader, a pure memory-estimation model, an `ollama.com/search` scraper, and two command orchestrators (`check`, `bench`) wired up by a `commander`-based CLI entrypoint. Every module that talks to the network, a subprocess, or the local Ollama server is a thin, isolated adapter so the parsing/estimation logic underneath is unit-testable without mocking anything exotic.

**Tech Stack:** TypeScript on Node (ES2022, NodeNext modules), `commander` for CLI parsing, `cheerio` for HTML scraping, `vitest` for tests, built-in `fetch` for HTTP.

## Global Constraints

- Node >= 20, TypeScript strict mode on.
- macOS-only for v1 — system memory reads shell out to `top -l 1 -s 0` and `sysctl vm.swapusage` / `sysctl -n hw.memsize`.
- No table-formatting dependency — hand-roll the column layout (keeps deps to exactly `commander` + `cheerio`, per spec).
- `OVERHEAD_MULTIPLIER = 1.25` (calibrated from this session's real measurements — see spec).
- `MACOS_BASELINE_RESERVE_GB = 8`, a hardcoded constant, not a CLI flag, per spec.
- Verdict thresholds: `comfortable` ≤ 70% of headroom, `tight` 70–95%, `will-thrash` > 95%.
- Spec lives at `docs/superpowers/specs/2026-08-04-ollama-scope-cli-design.md` — consult it for the "why" behind any of the above.
- All test fixtures under `test/fixtures/` are **real captured data** from this session's manual API/system exploration (not fabricated) — see each task for provenance.

---

### Task 1: Project scaffolding + CLI skeleton

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Produces: `createProgram(): Command` (from `commander`), exported from `src/cli.ts`. Later tasks (Task 8) will add subcommands to this same function.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "ollama-scope",
  "version": "0.1.0",
  "description": "Right-size Ollama models for this machine's memory and quantization",
  "type": "module",
  "bin": {
    "ollama-scope": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "cheerio": "^1.0.0",
    "commander": "^12.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: `node_modules/` populated, `package-lock.json` created, no errors.

- [ ] **Step 6: Write the failing test for the CLI skeleton**

`test/cli.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createProgram } from '../src/cli.js';

describe('createProgram', () => {
  it('names the program ollama-scope', () => {
    const program = createProgram();
    expect(program.name()).toBe('ollama-scope');
  });

  it('has a non-empty description', () => {
    const program = createProgram();
    expect(program.description().length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — `src/cli.ts` does not exist yet (module not found).

- [ ] **Step 8: Create `src/cli.ts`**

```typescript
#!/usr/bin/env node
import { Command } from 'commander';

export function createProgram(): Command {
  const program = new Command();
  program
    .name('ollama-scope')
    .description("Right-size Ollama models for this machine's memory and quantization");
  return program;
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  createProgram().parseAsync(process.argv);
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 10: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/cli.ts test/cli.test.ts
git commit -m "Scaffold ollama-scope CLI project"
```

---

### Task 2: Ollama local API client

**Files:**
- Create: `src/ollama-client.ts`
- Test: `test/ollama-client.test.ts`
- Test fixtures (already captured, real data from this session — copy as-is, do not regenerate):
  - `test/fixtures/api-tags.json` — real `/api/tags` response with 18 models, including 4 local GGUF models and 14 cloud models (mixed `parameter_size` formats: `"12.2B"`, `"756b"`, `"675000000000"` with no suffix, and `""` empty for some cloud models)
  - `test/fixtures/api-ps-empty.json` — real `/api/ps` response with nothing loaded (`{"models": []}`)
  - `test/fixtures/api-ps-loaded.json` — real `/api/ps` response with `gemma3:12b` loaded (`size_vram: 8643862854`)
  - `test/fixtures/api-show-gemma3-12b.json` — real (trimmed) `/api/show?verbose=true` response for `gemma3:12b`

**Interfaces:**
- Produces:
  - `interface OllamaModelDetails { parent_model: string; format: string; family: string; families: string[] | null; parameter_size: string; quantization_level: string; context_length?: number; embedding_length?: number; }`
  - `interface OllamaTagsModel { name: string; model: string; modified_at: string; size: number; digest: string; details: OllamaModelDetails; capabilities: string[]; remote_host?: string; remote_model?: string; }`
  - `interface OllamaTagsResponse { models: OllamaTagsModel[]; }`
  - `interface OllamaPsModel { name: string; model: string; size: number; digest: string; details: OllamaModelDetails; expires_at: string; size_vram: number; context_length: number; }`
  - `interface OllamaPsResponse { models: OllamaPsModel[]; }`
  - `interface OllamaGenerateResponse { model: string; created_at: string; response: string; done: boolean; done_reason?: string; eval_count?: number; eval_duration?: number; load_duration?: number; total_duration?: number; prompt_eval_count?: number; prompt_eval_duration?: number; }`
  - `function isCloudModel(model: OllamaTagsModel): boolean`
  - `function parseParameterSize(raw: string): number | null` — returns billions of params
  - `async function fetchTags(): Promise<OllamaTagsResponse>`
  - `async function fetchPs(): Promise<OllamaPsResponse>`
  - `async function generate(model: string, prompt: string, timeoutMs?: number): Promise<OllamaGenerateResponse | null>` — returns `null` on timeout (not a throw)
  - `async function unloadModel(model: string): Promise<void>`
  - `async function pullModel(model: string): Promise<void>` — shells out to the real `ollama pull` CLI (reuses its progress UI rather than reimplementing NDJSON stream parsing)

- [ ] **Step 1: Write failing tests for pure parsing functions**

`test/ollama-client.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isCloudModel,
  parseParameterSize,
  fetchTags,
  type OllamaTagsResponse,
} from '../src/ollama-client.js';

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8'));
}

describe('parseParameterSize', () => {
  it('parses a decimal value with uppercase B suffix', () => {
    expect(parseParameterSize('12.2B')).toBe(12.2);
  });

  it('parses a lowercase b suffix', () => {
    expect(parseParameterSize('756b')).toBe(756);
  });

  it('parses a raw integer parameter count with no suffix', () => {
    expect(parseParameterSize('675000000000')).toBe(675);
  });

  it('parses a small raw integer parameter count', () => {
    expect(parseParameterSize('24000000000')).toBe(24);
  });

  it('returns null for an empty string', () => {
    expect(parseParameterSize('')).toBeNull();
  });
});

describe('isCloudModel', () => {
  const tags = loadFixture<OllamaTagsResponse>('api-tags.json');

  it('identifies a cloud model by its remote_host field', () => {
    const cloudModel = tags.models.find((m) => m.name === 'glm-5.2:cloud');
    expect(cloudModel).toBeDefined();
    expect(isCloudModel(cloudModel!)).toBe(true);
  });

  it('identifies a local GGUF model as not cloud', () => {
    const localModel = tags.models.find((m) => m.name === 'gemma3:12b');
    expect(localModel).toBeDefined();
    expect(isCloudModel(localModel!)).toBe(false);
  });

  it('counts exactly 4 local (non-cloud) models in the fixture', () => {
    const localCount = tags.models.filter((m) => !isCloudModel(m)).length;
    expect(localCount).toBe(4);
  });
});

describe('fetchTags error handling', () => {
  it('gives a clear message when the Ollama server is unreachable', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    }) as typeof fetch;
    try {
      await expect(fetchTags()).rejects.toThrow(/is 'ollama serve' running/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/ollama-client.test.ts`
Expected: FAIL — `src/ollama-client.ts` does not exist yet.

- [ ] **Step 3: Implement `src/ollama-client.ts`**

```typescript
const OLLAMA_BASE_URL = process.env.OLLAMA_HOST
  ? `http://${process.env.OLLAMA_HOST}`
  : 'http://localhost:11434';

export interface OllamaModelDetails {
  parent_model: string;
  format: string;
  family: string;
  families: string[] | null;
  parameter_size: string;
  quantization_level: string;
  context_length?: number;
  embedding_length?: number;
}

export interface OllamaTagsModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details: OllamaModelDetails;
  capabilities: string[];
  remote_host?: string;
  remote_model?: string;
}

export interface OllamaTagsResponse {
  models: OllamaTagsModel[];
}

export interface OllamaPsModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  details: OllamaModelDetails;
  expires_at: string;
  size_vram: number;
  context_length: number;
}

export interface OllamaPsResponse {
  models: OllamaPsModel[];
}

export interface OllamaGenerateResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  done_reason?: string;
  eval_count?: number;
  eval_duration?: number;
  load_duration?: number;
  total_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
}

export function isCloudModel(model: OllamaTagsModel): boolean {
  return typeof model.remote_host === 'string' && model.remote_host.length > 0;
}

/** Returns billions of parameters, or null if unparseable/empty. */
export function parseParameterSize(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const suffixMatch = trimmed.match(/^([\d.]+)\s*([BbMmKk])$/);
  if (suffixMatch) {
    const value = parseFloat(suffixMatch[1]);
    const suffix = suffixMatch[2].toUpperCase();
    if (suffix === 'B') return value;
    if (suffix === 'M') return value / 1000;
    return value / 1_000_000; // K
  }

  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) / 1e9;
  }

  return null;
}

async function ollamaFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}${path}`, init);
  } catch (err) {
    throw new Error(
      `Could not reach Ollama server at ${OLLAMA_BASE_URL} — is 'ollama serve' running? (${(err as Error).message})`
    );
  }
  if (!res.ok) {
    throw new Error(`Ollama server returned ${res.status} for ${path}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchTags(): Promise<OllamaTagsResponse> {
  return ollamaFetch<OllamaTagsResponse>('/api/tags');
}

export async function fetchPs(): Promise<OllamaPsResponse> {
  return ollamaFetch<OllamaPsResponse>('/api/ps');
}

/** Returns null if the request times out (a meaningful result, not an error). */
export async function generate(
  model: string,
  prompt: string,
  timeoutMs = 90_000
): Promise<OllamaGenerateResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Ollama server returned ${res.status} for /api/generate`);
    }
    return (await res.json()) as OllamaGenerateResponse;
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
  await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    body: JSON.stringify({ model, keep_alive: 0 }),
  });
}

export async function pullModel(model: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  await execFileAsync('ollama', ['pull', model], { maxBuffer: 1024 * 1024 * 50 });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/ollama-client.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/ollama-client.ts test/ollama-client.test.ts test/fixtures/api-tags.json test/fixtures/api-ps-empty.json test/fixtures/api-ps-loaded.json test/fixtures/api-show-gemma3-12b.json
git commit -m "Add Ollama local API client with cloud-model detection"
```

---

### Task 3: macOS system memory reader

**Files:**
- Create: `src/system-memory.ts`
- Test: `test/system-memory.test.ts`
- Test fixtures (already captured, real data from this session):
  - `test/fixtures/top-output.txt` — real `top -l 1 -s 0 | grep -E "^PhysMem|^Load Avg"` output
  - `test/fixtures/swapusage-output.txt` — real `sysctl vm.swapusage` output
  - `test/fixtures/hw-memsize.txt` — real `sysctl -n hw.memsize` output (bytes)

**Interfaces:**
- Consumes: none (leaf module)
- Produces:
  - `interface SystemMemoryState { totalGb: number; usedGb: number; wiredGb: number; compressorGb: number; unusedGb: number; swapTotalGb: number; swapUsedGb: number; swapFreeGb: number; }`
  - `function parseTopOutput(text: string): { usedGb: number; wiredGb: number; compressorGb: number; unusedGb: number }`
  - `function parseSwapUsage(text: string): { swapTotalGb: number; swapUsedGb: number; swapFreeGb: number }`
  - `function parseHwMemsize(text: string): number` — returns GB
  - `function readSystemMemory(): SystemMemoryState` — the live, non-mockable adapter; thin by design, not unit tested directly (see Testing note in spec)

- [ ] **Step 1: Write failing tests for the parsing functions**

`test/system-memory.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTopOutput, parseSwapUsage, parseHwMemsize } from '../src/system-memory.js';

function loadFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');
}

describe('parseTopOutput', () => {
  it('parses the real captured PhysMem line', () => {
    const result = parseTopOutput(loadFixture('top-output.txt'));
    expect(result.usedGb).toBeCloseTo(23, 5);
    expect(result.wiredGb).toBeCloseTo(3910 / 1024, 5);
    expect(result.compressorGb).toBeCloseTo(9538 / 1024, 5);
    expect(result.unusedGb).toBeCloseTo(145 / 1024, 5);
  });

  it('throws a clear error on unparseable input', () => {
    expect(() => parseTopOutput('garbage')).toThrow(/Could not parse/);
  });
});

describe('parseSwapUsage', () => {
  it('parses the real captured vm.swapusage line', () => {
    const result = parseSwapUsage(loadFixture('swapusage-output.txt'));
    expect(result.swapTotalGb).toBeCloseTo(12, 5);
    expect(result.swapUsedGb).toBeCloseTo(10700.44 / 1024, 5);
    expect(result.swapFreeGb).toBeCloseTo(1587.56 / 1024, 5);
  });

  it('throws a clear error on unparseable input', () => {
    expect(() => parseSwapUsage('garbage')).toThrow(/Could not parse/);
  });
});

describe('parseHwMemsize', () => {
  it('parses the real captured hw.memsize bytes into GB', () => {
    const result = parseHwMemsize(loadFixture('hw-memsize.txt'));
    expect(result).toBeCloseTo(24, 5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/system-memory.test.ts`
Expected: FAIL — `src/system-memory.ts` does not exist yet.

- [ ] **Step 3: Implement `src/system-memory.ts`**

```typescript
import { execFileSync } from 'node:child_process';

export interface SystemMemoryState {
  totalGb: number;
  usedGb: number;
  wiredGb: number;
  compressorGb: number;
  unusedGb: number;
  swapTotalGb: number;
  swapUsedGb: number;
  swapFreeGb: number;
}

function toGb(value: number, unit: string): number {
  return unit === 'G' ? value : value / 1024;
}

export function parseTopOutput(text: string): {
  usedGb: number;
  wiredGb: number;
  compressorGb: number;
  unusedGb: number;
} {
  const match = text.match(
    /PhysMem:\s+([\d.]+)([GM])\s+used\s+\(([\d.]+)([GM])\s+wired,\s+([\d.]+)([GM])\s+compressor\),\s+([\d.]+)([GM])\s+unused\./
  );
  if (!match) {
    throw new Error(`Could not parse 'top' PhysMem line: ${text}`);
  }
  const [, usedVal, usedUnit, wiredVal, wiredUnit, compVal, compUnit, unusedVal, unusedUnit] = match;
  return {
    usedGb: toGb(parseFloat(usedVal), usedUnit),
    wiredGb: toGb(parseFloat(wiredVal), wiredUnit),
    compressorGb: toGb(parseFloat(compVal), compUnit),
    unusedGb: toGb(parseFloat(unusedVal), unusedUnit),
  };
}

export function parseSwapUsage(text: string): {
  swapTotalGb: number;
  swapUsedGb: number;
  swapFreeGb: number;
} {
  const match = text.match(/total = ([\d.]+)M\s+used = ([\d.]+)M\s+free = ([\d.]+)M/);
  if (!match) {
    throw new Error(`Could not parse 'sysctl vm.swapusage' output: ${text}`);
  }
  const [, totalMb, usedMb, freeMb] = match;
  return {
    swapTotalGb: parseFloat(totalMb) / 1024,
    swapUsedGb: parseFloat(usedMb) / 1024,
    swapFreeGb: parseFloat(freeMb) / 1024,
  };
}

/** Returns GB (binary, i.e. GiB, matching top/vm_stat's own units). */
export function parseHwMemsize(text: string): number {
  const bytes = parseInt(text.trim(), 10);
  if (Number.isNaN(bytes)) {
    throw new Error(`Could not parse 'sysctl -n hw.memsize' output: ${text}`);
  }
  return bytes / 1024 ** 3;
}

/** Live system read — thin adapter, not unit tested directly (see spec's Testing section). */
export function readSystemMemory(): SystemMemoryState {
  const topText = execFileSync('top', ['-l', '1', '-s', '0']).toString();
  const swapText = execFileSync('sysctl', ['vm.swapusage']).toString();
  const memText = execFileSync('sysctl', ['-n', 'hw.memsize']).toString();

  const { usedGb, wiredGb, compressorGb, unusedGb } = parseTopOutput(topText);
  const { swapTotalGb, swapUsedGb, swapFreeGb } = parseSwapUsage(swapText);
  const totalGb = parseHwMemsize(memText);

  return { totalGb, usedGb, wiredGb, compressorGb, unusedGb, swapTotalGb, swapUsedGb, swapFreeGb };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/system-memory.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/system-memory.ts test/system-memory.test.ts test/fixtures/top-output.txt test/fixtures/swapusage-output.txt test/fixtures/hw-memsize.txt
git commit -m "Add macOS system memory reader"
```

---

### Task 4: Memory estimation model

**Files:**
- Create: `src/estimate.ts`
- Test: `test/estimate.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, no I/O)
- Produces:
  - `const OVERHEAD_MULTIPLIER = 1.25`
  - `const MACOS_BASELINE_RESERVE_GB = 8`
  - `interface FootprintEstimate { weightsGb: number; estimatedFootprintGb: number; quantKnown: boolean; quantUsedForEstimate: string; }`
  - `function bytesPerParam(quantizationLevel: string): { value: number; known: boolean }`
  - `function estimateFootprint(parameterSizeB: number, quantizationLevel: string): FootprintEstimate`
  - `type Verdict = 'comfortable' | 'tight' | 'will-thrash'`
  - `function classifyVerdict(footprintGb: number, headroomGb: number): Verdict`

- [ ] **Step 1: Write failing tests**

`test/estimate.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { bytesPerParam, estimateFootprint, classifyVerdict } from '../src/estimate.js';

describe('bytesPerParam', () => {
  it('knows Q4_K_M', () => {
    expect(bytesPerParam('Q4_K_M')).toEqual({ value: 0.5625, known: true });
  });

  it('knows Q8_0', () => {
    expect(bytesPerParam('Q8_0')).toEqual({ value: 1.0, known: true });
  });

  it('knows F16 and BF16 as the same value', () => {
    expect(bytesPerParam('F16').value).toBe(2.0);
    expect(bytesPerParam('BF16').value).toBe(2.0);
  });

  it('knows fp8 case-insensitively (as seen in real /api/tags data)', () => {
    expect(bytesPerParam('fp8')).toEqual({ value: 1.0, known: true });
  });

  it('knows MXFP4 (as seen in real /api/tags data for gpt-oss:20b-cloud)', () => {
    expect(bytesPerParam('MXFP4')).toEqual({ value: 0.5, known: true });
  });

  it('knows NVFP4', () => {
    expect(bytesPerParam('NVFP4').value).toBe(0.5);
  });

  it('falls back to the Q4_K_M value for an unknown quant string, flagged as unknown', () => {
    const result = bytesPerParam('SOME_FUTURE_QUANT');
    expect(result.known).toBe(false);
    expect(result.value).toBe(0.5625);
  });

  it('falls back for an empty quant string (as seen for some cloud models)', () => {
    const result = bytesPerParam('');
    expect(result.known).toBe(false);
    expect(result.value).toBe(0.5625);
  });
});

describe('estimateFootprint', () => {
  // Golden cases calibrated against this session's real measurements
  // (see spec's Memory Estimation Model section).

  it('matches llama3.2:3b closely (predicted weights 1.8GB, actual measured 2.3GB)', () => {
    const result = estimateFootprint(3.2, 'Q4_K_M');
    expect(result.weightsGb).toBeCloseTo(1.8, 4);
    expect(result.estimatedFootprintGb).toBeCloseTo(2.25, 4);
    expect(result.quantKnown).toBe(true);
    expect(result.quantUsedForEstimate).toBe('Q4_K_M');
  });

  it('matches gemma3:12b closely (real param_size 12.2B, actual measured 8.64GB)', () => {
    const result = estimateFootprint(12.2, 'Q4_K_M');
    expect(result.weightsGb).toBeCloseTo(6.8625, 4);
    expect(result.estimatedFootprintGb).toBeCloseTo(8.578125, 4);
  });

  it('flags an unknown quant while still producing an estimate', () => {
    const result = estimateFootprint(8, '');
    expect(result.quantKnown).toBe(false);
    expect(result.quantUsedForEstimate).toBe('Q4_K_M');
    expect(result.weightsGb).toBeCloseTo(4.5, 4);
  });
});

describe('classifyVerdict', () => {
  it('is comfortable at or under 70% of headroom', () => {
    expect(classifyVerdict(7, 10)).toBe('comfortable');
    expect(classifyVerdict(6.9, 10)).toBe('comfortable');
  });

  it('is tight between 70% and 95% of headroom', () => {
    expect(classifyVerdict(8, 10)).toBe('tight');
    expect(classifyVerdict(9.4, 10)).toBe('tight');
  });

  it('will-thrash above 95% of headroom', () => {
    expect(classifyVerdict(9.6, 10)).toBe('will-thrash');
  });

  it('will-thrash when footprint exceeds headroom outright', () => {
    expect(classifyVerdict(17, 10)).toBe('will-thrash');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/estimate.test.ts`
Expected: FAIL — `src/estimate.ts` does not exist yet.

- [ ] **Step 3: Implement `src/estimate.ts`**

```typescript
const BYTES_PER_PARAM: Record<string, number> = {
  F32: 4.0,
  FP32: 4.0,
  F16: 2.0,
  BF16: 2.0,
  FP16: 2.0,
  FP8: 1.0,
  Q8_0: 1.0,
  Q6_K: 0.75,
  Q5_K_M: 0.69,
  Q4_K_M: 0.5625,
  Q4_0: 0.5,
  MXFP4: 0.5,
  NVFP4: 0.5,
  Q3_K_M: 0.44,
  Q2_K: 0.35,
};

const FALLBACK_QUANT = 'Q4_K_M';

/** Calibrated against real session measurements — see spec's Memory Estimation Model table. */
export const OVERHEAD_MULTIPLIER = 1.25;

/** Fixed reserve for macOS + normal daily apps on a 24GB machine. Not configurable in v1. */
export const MACOS_BASELINE_RESERVE_GB = 8;

export function bytesPerParam(quantizationLevel: string): { value: number; known: boolean } {
  const key = quantizationLevel.trim().toUpperCase();
  if (key.length > 0 && key in BYTES_PER_PARAM) {
    return { value: BYTES_PER_PARAM[key], known: true };
  }
  return { value: BYTES_PER_PARAM[FALLBACK_QUANT], known: false };
}

export interface FootprintEstimate {
  weightsGb: number;
  estimatedFootprintGb: number;
  quantKnown: boolean;
  quantUsedForEstimate: string;
}

export function estimateFootprint(parameterSizeB: number, quantizationLevel: string): FootprintEstimate {
  const { value: bpp, known } = bytesPerParam(quantizationLevel);
  const weightsGb = parameterSizeB * bpp;
  return {
    weightsGb,
    estimatedFootprintGb: weightsGb * OVERHEAD_MULTIPLIER,
    quantKnown: known,
    quantUsedForEstimate: known ? quantizationLevel : FALLBACK_QUANT,
  };
}

export type Verdict = 'comfortable' | 'tight' | 'will-thrash';

export function classifyVerdict(footprintGb: number, headroomGb: number): Verdict {
  if (footprintGb > headroomGb * 0.95) return 'will-thrash';
  if (footprintGb > headroomGb * 0.7) return 'tight';
  return 'comfortable';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/estimate.test.ts`
Expected: PASS (15 tests)

- [ ] **Step 5: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/estimate.ts test/estimate.test.ts
git commit -m "Add quantization-aware memory estimation model"
```

---

### Task 5: Remote scrape module

**Files:**
- Create: `src/scrape.ts`
- Test: `test/scrape.test.ts`
- Test fixture (already captured, real raw HTML from `ollama.com/search?q=mlx`, 20 real results): `test/fixtures/ollama-search-mlx.html`

**Interfaces:**
- Consumes: `cheerio` (add to `package.json` dependencies — already added in Task 1)
- Produces:
  - `interface RemoteModelCandidate { name: string; description: string; parameterSizeB: number | null; sizeSource: 'badge' | 'name-heuristic' | 'unknown'; }`
  - `function parseSearchResults(html: string): RemoteModelCandidate[]` — pure, testable without network
  - `async function scrapeSearch(query: string): Promise<RemoteModelCandidate[]>` — thin network adapter; throws on failure (caller in Task 6 handles graceful degradation)

**Note on markup discovered this session:** `ollama.com/search` server-renders results as `<li class="flex items-baseline ...">` containing `<a class="group w-full" href="...">`. Official models use `href="/library/<name>"`; community models use `href="/<user>/<name>"` (no `/library/` prefix). A size badge (`<span class="... text-blue-600 ...">7b</span>`) is present on some results but not all — when absent, the model name itself often contains a size token (e.g. `Qwen3.6-27B-...`), so a name-based regex fallback is used. This was verified against the real fixture, not guessed.

- [ ] **Step 1: Write failing tests against the real fixture**

`test/scrape.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSearchResults } from '../src/scrape.js';

function loadFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');
}

describe('parseSearchResults', () => {
  const html = loadFixture('ollama-search-mlx.html');
  const results = parseSearchResults(html);

  it('finds all 20 real results in the fixture', () => {
    expect(results.length).toBe(20);
  });

  it('parses an official /library/ model with a size badge', () => {
    const mxbai = results.find((r) => r.name === 'mxbai-embed-large');
    expect(mxbai).toBeDefined();
    expect(mxbai!.parameterSizeB).toBeCloseTo(0.335, 5);
    expect(mxbai!.sizeSource).toBe('badge');
  });

  it('parses a size badge in whole billions', () => {
    const gptoss = results.find((r) => r.name === 'pd95/gptoss-mlx');
    expect(gptoss).toBeDefined();
    expect(gptoss!.parameterSizeB).toBe(20);
    expect(gptoss!.sizeSource).toBe('badge');
  });

  it('falls back to name-heuristic parsing when there is no size badge', () => {
    // real fixture: cyborgxx101/gemma-4-12b-opus-finetuned-mlx has no badge,
    // but "12b" is in the name — and this matches what we actually measured (11.9B).
    const gemma4 = results.find((r) => r.name === 'cyborgxx101/gemma-4-12b-opus-finetuned-mlx');
    expect(gemma4).toBeDefined();
    expect(gemma4!.parameterSizeB).toBe(12);
    expect(gemma4!.sizeSource).toBe('name-heuristic');
  });

  it('picks the first size token when a name has multiple digit+B substrings', () => {
    // real fixture: "Qwen3.6-35B-A3B-mlx-claude-coder-abliterated" — "35B" comes
    // before "A3B" in the string, so it should win.
    const candidate = results.find(
      (r) => r.name === 'rafw007/Qwen3.6-35B-A3B-mlx-claude-coder-abliterated'
    );
    expect(candidate).toBeDefined();
    expect(candidate!.parameterSizeB).toBe(35);
    expect(candidate!.sizeSource).toBe('name-heuristic');
  });

  it('returns unknown when neither a badge nor a name pattern is present', () => {
    const mistralLarge = results.find((r) => r.name === 'mistral-large-3');
    expect(mistralLarge).toBeDefined();
    expect(mistralLarge!.parameterSizeB).toBeNull();
    expect(mistralLarge!.sizeSource).toBe('unknown');
  });

  it('derives the community model name from the href without a /library/ prefix', () => {
    const apertus = results.find((r) => r.name === 'pd95/apertus-mlx');
    expect(apertus).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/scrape.test.ts`
Expected: FAIL — `src/scrape.ts` does not exist yet.

- [ ] **Step 3: Implement `src/scrape.ts`**

```typescript
import * as cheerio from 'cheerio';

export interface RemoteModelCandidate {
  name: string;
  description: string;
  parameterSizeB: number | null;
  sizeSource: 'badge' | 'name-heuristic' | 'unknown';
}

function parseSizeBadgeText(text: string): number | null {
  const match = text.trim().match(/^([\d.]+)\s*([BbMm])$/);
  if (!match) return null;
  const value = parseFloat(match[1]);
  return match[2].toUpperCase() === 'B' ? value : value / 1000;
}

function parseSizeFromName(name: string): number | null {
  const match = name.match(/(\d+(?:\.\d+)?)[Bb]\b/);
  return match ? parseFloat(match[1]) : null;
}

export function parseSearchResults(html: string): RemoteModelCandidate[] {
  const $ = cheerio.load(html);
  const results: RemoteModelCandidate[] = [];

  $('a.group.w-full').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    const name = href.startsWith('/library/') ? href.slice('/library/'.length) : href.slice(1);
    const description = $(el).find('p.max-w-lg').first().text().trim();
    const badgeText = $(el).find('span.text-blue-600').first().text().trim();
    const badgeSize = badgeText.length > 0 ? parseSizeBadgeText(badgeText) : null;

    if (badgeSize !== null) {
      results.push({ name, description, parameterSizeB: badgeSize, sizeSource: 'badge' });
      return;
    }

    const nameSize = parseSizeFromName(name);
    results.push({
      name,
      description,
      parameterSizeB: nameSize,
      sizeSource: nameSize !== null ? 'name-heuristic' : 'unknown',
    });
  });

  return results;
}

export async function scrapeSearch(query: string): Promise<RemoteModelCandidate[]> {
  const res = await fetch(`https://ollama.com/search?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) {
    throw new Error(`ollama.com/search returned ${res.status}`);
  }
  const html = await res.text();
  return parseSearchResults(html);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/scrape.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/scrape.ts test/scrape.test.ts test/fixtures/ollama-search-mlx.html
git commit -m "Add ollama.com/search scraper for remote model candidates"
```

---

### Task 6: `check` command orchestration + output formatting

**Files:**
- Create: `src/check.ts`
- Create: `src/format.ts`
- Test: `test/check.test.ts`
- Test: `test/format.test.ts`

**Interfaces:**
- Consumes:
  - From Task 2: `fetchTags`, `isCloudModel`, `parseParameterSize`, `type OllamaTagsModel`, `type OllamaTagsResponse`
  - From Task 3: `readSystemMemory`, `type SystemMemoryState`
  - From Task 4: `estimateFootprint`, `classifyVerdict`, `type Verdict`, `MACOS_BASELINE_RESERVE_GB`
  - From Task 5: `scrapeSearch`, `type RemoteModelCandidate`
- Produces:
  - `interface CheckRow { name: string; source: 'local' | 'remote'; parameterSizeB: number | null; quantizationLevel: string | null; footprintGb: number | null; baselineVerdict: Verdict | 'unknown'; currentVerdict: Verdict | 'unknown'; }`
  - `interface CheckResult { rows: CheckRow[]; cloudModels: string[]; system: SystemMemoryState; baselineHeadroomGb: number; currentHeadroomGb: number; scrapeWarning: string | null; }`
  - `async function runCheck(query?: string): Promise<CheckResult>` — takes injectable dependencies for testing (see below)
  - `function formatCheckTable(result: CheckResult): string`
  - `function formatCheckJson(result: CheckResult): string`
  - Note: `formatBenchResult` is deliberately *not* added here — it depends on `BenchResult` from `bench.ts`, which doesn't exist until Task 7. Task 7 modifies this same `src/format.ts` to add it, once its dependency exists.

To keep `runCheck` unit-testable without live network/system calls, it takes its dependencies as an optional injected object defaulting to the real implementations — this is the seam the test uses to supply fixture-backed fakes.

- [ ] **Step 1: Write failing tests for `runCheck` (with injected fakes) and formatting**

`test/check.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runCheck } from '../src/check.js';
import type { OllamaTagsResponse } from '../src/ollama-client.js';
import type { SystemMemoryState } from '../src/system-memory.js';
import type { RemoteModelCandidate } from '../src/scrape.js';

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8'));
}

const fakeSystem: SystemMemoryState = {
  totalGb: 24,
  usedGb: 23,
  wiredGb: 3.8,
  compressorGb: 9.3,
  unusedGb: 0.14,
  swapTotalGb: 12,
  swapUsedGb: 10.4,
  swapFreeGb: 1.5,
};

describe('runCheck', () => {
  it('excludes cloud models from rows but lists them separately', async () => {
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
      readSystemMemory: () => fakeSystem,
      scrapeSearch: async () => [],
    });

    expect(result.rows.every((r) => r.source !== 'local' || !r.name.includes(':cloud'))).toBe(true);
    expect(result.cloudModels).toContain('glm-5.2:cloud');
    expect(result.rows.filter((r) => r.source === 'local').length).toBe(4);
  });

  it('computes baseline headroom as total minus the fixed macOS reserve', async () => {
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
      readSystemMemory: () => fakeSystem,
      scrapeSearch: async () => [],
    });
    expect(result.baselineHeadroomGb).toBe(16); // 24 - 8
  });

  it('computes current headroom directly from live unused memory', async () => {
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
      readSystemMemory: () => fakeSystem,
      scrapeSearch: async () => [],
    });
    expect(result.currentHeadroomGb).toBeCloseTo(0.14, 5);
  });

  it('classifies gemma3:27b as will-thrash under current (near-zero) headroom', async () => {
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
      readSystemMemory: () => fakeSystem,
      scrapeSearch: async () => [],
    });
    const row = result.rows.find((r) => r.name === 'gemma3:27b');
    expect(row).toBeDefined();
    expect(row!.currentVerdict).toBe('will-thrash');
  });

  it('degrades gracefully when scraping fails, keeping local results', async () => {
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
      readSystemMemory: () => fakeSystem,
      scrapeSearch: async () => {
        throw new Error('network unreachable');
      },
    });
    expect(result.scrapeWarning).toMatch(/network unreachable/);
    expect(result.rows.filter((r) => r.source === 'local').length).toBe(4);
  });

  it('includes remote candidates with a parsed size, using the unknown-quant fallback', async () => {
    const tags = loadFixture<OllamaTagsResponse>('api-tags.json');
    const remote: RemoteModelCandidate[] = [
      { name: 'pd95/gptoss-mlx', description: '', parameterSizeB: 20, sizeSource: 'badge' },
      { name: 'mistral-large-3', description: '', parameterSizeB: null, sizeSource: 'unknown' },
    ];
    const result = await runCheck('mlx', {
      fetchTags: async () => tags,
      readSystemMemory: () => fakeSystem,
      scrapeSearch: async () => remote,
    });
    const row = result.rows.find((r) => r.name === 'pd95/gptoss-mlx');
    expect(row).toBeDefined();
    expect(row!.source).toBe('remote');
    expect(row!.quantizationLevel).toBe('Q4_K_M'); // fallback, unknown quant
    // remote candidate with no parsed size should be excluded, not shown with a bogus estimate
    expect(result.rows.find((r) => r.name === 'mistral-large-3')).toBeUndefined();
  });
});
```

`test/format.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { formatCheckTable, formatCheckJson } from '../src/format.js';
import type { CheckResult } from '../src/check.js';

const sampleResult: CheckResult = {
  rows: [
    {
      name: 'gemma3:12b',
      source: 'local',
      parameterSizeB: 12.2,
      quantizationLevel: 'Q4_K_M',
      footprintGb: 8.58,
      baselineVerdict: 'comfortable',
      currentVerdict: 'will-thrash',
    },
  ],
  cloudModels: ['glm-5.2:cloud'],
  system: {
    totalGb: 24,
    usedGb: 23,
    wiredGb: 3.8,
    compressorGb: 9.3,
    unusedGb: 0.14,
    swapTotalGb: 12,
    swapUsedGb: 10.4,
    swapFreeGb: 1.5,
  },
  baselineHeadroomGb: 16,
  currentHeadroomGb: 0.14,
  scrapeWarning: null,
};

describe('formatCheckTable', () => {
  it('includes the model name and both verdicts', () => {
    const table = formatCheckTable(sampleResult);
    expect(table).toContain('gemma3:12b');
    expect(table).toContain('comfortable');
    expect(table).toContain('will-thrash');
  });

  it('lists cloud models separately with a note that they run remotely', () => {
    const table = formatCheckTable(sampleResult);
    expect(table).toContain('glm-5.2:cloud');
    expect(table.toLowerCase()).toContain('cloud');
  });

  it('shows a scrape warning when present', () => {
    const table = formatCheckTable({ ...sampleResult, scrapeWarning: 'could not reach ollama.com' });
    expect(table).toContain('could not reach ollama.com');
  });
});

describe('formatCheckJson', () => {
  it('round-trips the result as valid JSON', () => {
    const json = formatCheckJson(sampleResult);
    const parsed = JSON.parse(json);
    expect(parsed.rows[0].name).toBe('gemma3:12b');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/check.test.ts test/format.test.ts`
Expected: FAIL — `src/check.ts` and `src/format.ts` do not exist yet.

- [ ] **Step 3: Implement `src/check.ts`**

```typescript
import {
  fetchTags as realFetchTags,
  isCloudModel,
  parseParameterSize,
  type OllamaTagsResponse,
} from './ollama-client.js';
import { readSystemMemory as realReadSystemMemory, type SystemMemoryState } from './system-memory.js';
import { estimateFootprint, classifyVerdict, type Verdict, MACOS_BASELINE_RESERVE_GB } from './estimate.js';
import { scrapeSearch as realScrapeSearch, type RemoteModelCandidate } from './scrape.js';

export interface CheckRow {
  name: string;
  source: 'local' | 'remote';
  parameterSizeB: number | null;
  quantizationLevel: string | null;
  footprintGb: number | null;
  baselineVerdict: Verdict | 'unknown';
  currentVerdict: Verdict | 'unknown';
}

export interface CheckResult {
  rows: CheckRow[];
  cloudModels: string[];
  system: SystemMemoryState;
  baselineHeadroomGb: number;
  currentHeadroomGb: number;
  scrapeWarning: string | null;
}

export interface CheckDeps {
  fetchTags: () => Promise<OllamaTagsResponse>;
  readSystemMemory: () => SystemMemoryState;
  scrapeSearch: (query: string) => Promise<RemoteModelCandidate[]>;
}

const defaultDeps: CheckDeps = {
  fetchTags: realFetchTags,
  readSystemMemory: realReadSystemMemory,
  scrapeSearch: realScrapeSearch,
};

export async function runCheck(query = 'mlx', deps: CheckDeps = defaultDeps): Promise<CheckResult> {
  const tags = await deps.fetchTags();
  const localModels = tags.models.filter((m) => !isCloudModel(m));
  const cloudModels = tags.models.filter(isCloudModel).map((m) => m.name);

  const system = deps.readSystemMemory();
  const baselineHeadroomGb = system.totalGb - MACOS_BASELINE_RESERVE_GB;
  const currentHeadroomGb = system.unusedGb;

  let remoteCandidates: RemoteModelCandidate[] = [];
  let scrapeWarning: string | null = null;
  try {
    remoteCandidates = await deps.scrapeSearch(query);
  } catch (err) {
    scrapeWarning = `Could not fetch remote model list: ${(err as Error).message}`;
  }

  const localRows: CheckRow[] = localModels.map((m) => {
    const paramB = parseParameterSize(m.details.parameter_size);
    if (paramB === null) {
      return {
        name: m.name,
        source: 'local',
        parameterSizeB: null,
        quantizationLevel: m.details.quantization_level || null,
        footprintGb: null,
        baselineVerdict: 'unknown',
        currentVerdict: 'unknown',
      };
    }
    const estimate = estimateFootprint(paramB, m.details.quantization_level);
    return {
      name: m.name,
      source: 'local',
      parameterSizeB: paramB,
      quantizationLevel: estimate.quantUsedForEstimate,
      footprintGb: estimate.estimatedFootprintGb,
      baselineVerdict: classifyVerdict(estimate.estimatedFootprintGb, baselineHeadroomGb),
      currentVerdict: classifyVerdict(estimate.estimatedFootprintGb, currentHeadroomGb),
    };
  });

  const remoteRows: CheckRow[] = remoteCandidates
    .filter((c) => c.parameterSizeB !== null)
    .map((c) => {
      const estimate = estimateFootprint(c.parameterSizeB as number, '');
      return {
        name: c.name,
        source: 'remote',
        parameterSizeB: c.parameterSizeB,
        quantizationLevel: estimate.quantUsedForEstimate,
        footprintGb: estimate.estimatedFootprintGb,
        baselineVerdict: classifyVerdict(estimate.estimatedFootprintGb, baselineHeadroomGb),
        currentVerdict: classifyVerdict(estimate.estimatedFootprintGb, currentHeadroomGb),
      };
    });

  return {
    rows: [...localRows, ...remoteRows],
    cloudModels,
    system,
    baselineHeadroomGb,
    currentHeadroomGb,
    scrapeWarning,
  };
}
```

- [ ] **Step 4: Implement `src/format.ts`**

```typescript
import { MACOS_BASELINE_RESERVE_GB } from './estimate.js';
import type { CheckResult } from './check.js';

export function formatCheckTable(result: CheckResult): string {
  const header = ['MODEL', 'SOURCE', 'PARAMS(B)', 'QUANT', 'EST FOOTPRINT(GB)', 'BASELINE', 'CURRENT'];
  const rows = result.rows.map((r) => [
    r.name,
    r.source,
    r.parameterSizeB !== null ? r.parameterSizeB.toFixed(1) : '?',
    r.quantizationLevel ?? '?',
    r.footprintGb !== null ? r.footprintGb.toFixed(1) : '?',
    r.baselineVerdict,
    r.currentVerdict,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const formatRow = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');

  const lines = [formatRow(header), ...rows.map(formatRow)];

  if (result.cloudModels.length > 0) {
    lines.push('', `Cloud models (run on Ollama Cloud, no local footprint): ${result.cloudModels.join(', ')}`);
  }

  lines.push(
    '',
    `Baseline headroom (total − ${MACOS_BASELINE_RESERVE_GB}GB macOS reserve): ${result.baselineHeadroomGb.toFixed(1)}GB`,
    `Current headroom (live free memory right now): ${result.currentHeadroomGb.toFixed(2)}GB`
  );

  if (result.scrapeWarning) {
    lines.push('', `Warning: ${result.scrapeWarning}`);
  }

  return lines.join('\n');
}

export function formatCheckJson(result: CheckResult): string {
  return JSON.stringify(result, null, 2);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/check.test.ts test/format.test.ts`
Expected: PASS (6 tests in `check.test.ts`, 4 tests in `format.test.ts`)

- [ ] **Step 6: Commit**

```bash
git add src/check.ts src/format.ts test/check.test.ts test/format.test.ts
git commit -m "Add check command orchestration and output formatting"
```

---

### Task 7: `bench` command orchestration

**Files:**
- Create: `src/bench.ts`
- Test: `test/bench.test.ts`
- Modify: `src/format.ts` (add `formatBenchResult`, deferred from Task 6 since it needs `BenchResult`)
- Modify: `test/format.test.ts` (add tests for `formatBenchResult`)

**Interfaces:**
- Consumes:
  - From Task 2: `fetchTags`, `fetchPs`, `generate`, `unloadModel`, `pullModel`, `type OllamaTagsResponse`, `type OllamaPsResponse`, `type OllamaGenerateResponse`
  - From Task 3: `readSystemMemory`, `type SystemMemoryState`
- Produces:
  - `interface BenchResult { model: string; status: 'completed' | 'timed-out'; sizeVramGb: number | null; evalTokensPerSecond: number | null; loadDurationSeconds: number | null; totalDurationSeconds: number | null; memoryBefore: SystemMemoryState; memoryAfter: SystemMemoryState; }`
  - `async function runBench(model: string, deps?: BenchDeps): Promise<BenchResult>` — same injectable-deps pattern as `runCheck`, for testability
  - `function formatBenchResult(result: BenchResult): string` (added to `src/format.ts`)

- [ ] **Step 1: Write failing tests with injected fakes**

`test/bench.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { runBench } from '../src/bench.js';
import type { OllamaTagsResponse, OllamaPsResponse, OllamaGenerateResponse } from '../src/ollama-client.js';
import type { SystemMemoryState } from '../src/system-memory.js';

const before: SystemMemoryState = {
  totalGb: 24,
  usedGb: 3,
  wiredGb: 3,
  compressorGb: 6,
  unusedGb: 15,
  swapTotalGb: 0,
  swapUsedGb: 0,
  swapFreeGb: 0,
};

const after: SystemMemoryState = {
  ...before,
  usedGb: 23,
  unusedGb: 0.1,
  swapUsedGb: 22.6,
};

describe('runBench', () => {
  it('reports a completed run with tokens/sec computed from eval_count and eval_duration', async () => {
    const alreadyPulledTags: OllamaTagsResponse = {
      models: [{ name: 'gemma3:12b', model: 'gemma3:12b', modified_at: '', size: 1, digest: '', details: { parent_model: '', format: 'gguf', family: 'gemma3', families: null, parameter_size: '12.2B', quantization_level: 'Q4_K_M' }, capabilities: [] }],
    };
    const ps: OllamaPsResponse = {
      models: [{ name: 'gemma3:12b', model: 'gemma3:12b', size: 8643862854, digest: '', details: { parent_model: '', format: 'gguf', family: 'gemma3', families: null, parameter_size: '12.2B', quantization_level: 'Q4_K_M' }, expires_at: '', size_vram: 8643862854, context_length: 4096 }],
    };
    const generateResponse: OllamaGenerateResponse = {
      model: 'gemma3:12b',
      created_at: '',
      response: 'a story',
      done: true,
      eval_count: 166,
      eval_duration: 10_690_000_000,
      load_duration: 12_880_000_000,
      total_duration: 24_060_000_000,
    };

    let unloadCalled = false;
    let pullCalled = false;

    const result = await runBench('gemma3:12b', {
      fetchTags: async () => alreadyPulledTags,
      fetchPs: async () => ps,
      generate: async () => generateResponse,
      unloadModel: async () => {
        unloadCalled = true;
      },
      pullModel: async () => {
        pullCalled = true;
      },
      readSystemMemory: (() => {
        let callCount = 0;
        return () => (callCount++ === 0 ? before : after);
      })(),
    });

    expect(result.status).toBe('completed');
    expect(result.sizeVramGb).toBeCloseTo(8.64, 1);
    expect(result.evalTokensPerSecond).toBeCloseTo(166 / 10.69, 2);
    expect(unloadCalled).toBe(true);
    expect(pullCalled).toBe(false); // already pulled, should not re-pull
  });

  it('reports timed-out status when generate returns null', async () => {
    const tags: OllamaTagsResponse = {
      models: [{ name: 'gemma3:27b', model: 'gemma3:27b', modified_at: '', size: 1, digest: '', details: { parent_model: '', format: 'gguf', family: 'gemma3', families: null, parameter_size: '27.4B', quantization_level: 'Q4_K_M' }, capabilities: [] }],
    };
    const ps: OllamaPsResponse = {
      models: [{ name: 'gemma3:27b', model: 'gemma3:27b', size: 18534629372, digest: '', details: { parent_model: '', format: 'gguf', family: 'gemma3', families: null, parameter_size: '27.4B', quantization_level: 'Q4_K_M' }, expires_at: '', size_vram: 16908340427, context_length: 4096 }],
    };

    const result = await runBench('gemma3:27b', {
      fetchTags: async () => tags,
      fetchPs: async () => ps,
      generate: async () => null,
      unloadModel: async () => {},
      pullModel: async () => {},
      readSystemMemory: (() => {
        let callCount = 0;
        return () => (callCount++ === 0 ? before : after);
      })(),
    });

    expect(result.status).toBe('timed-out');
    expect(result.evalTokensPerSecond).toBeNull();
    expect(result.sizeVramGb).toBeCloseTo(16.91, 1);
  });

  it('pulls the model when not already present', async () => {
    const emptyTags: OllamaTagsResponse = { models: [] };
    const ps: OllamaPsResponse = { models: [] };
    const generateResponse: OllamaGenerateResponse = {
      model: 'llama3.2:3b',
      created_at: '',
      response: 'hi',
      done: true,
      eval_count: 3,
      eval_duration: 52_821_000,
      load_duration: 1_481_564_750,
      total_duration: 1_838_357_583,
    };

    let pullCalled = false;

    await runBench('llama3.2:3b', {
      fetchTags: async () => emptyTags,
      fetchPs: async () => ps,
      generate: async () => generateResponse,
      unloadModel: async () => {},
      pullModel: async () => {
        pullCalled = true;
      },
      readSystemMemory: () => before,
    });

    expect(pullCalled).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/bench.test.ts`
Expected: FAIL — `src/bench.ts` does not exist yet.

- [ ] **Step 3: Implement `src/bench.ts`**

```typescript
import {
  fetchTags as realFetchTags,
  fetchPs as realFetchPs,
  generate as realGenerate,
  unloadModel as realUnloadModel,
  pullModel as realPullModel,
  type OllamaTagsResponse,
  type OllamaPsResponse,
  type OllamaGenerateResponse,
} from './ollama-client.js';
import { readSystemMemory as realReadSystemMemory, type SystemMemoryState } from './system-memory.js';

const BENCH_PROMPT = 'Write a 150 word short story about a robot learning to paint.';
const GENERATE_TIMEOUT_MS = 90_000;

export interface BenchResult {
  model: string;
  status: 'completed' | 'timed-out';
  sizeVramGb: number | null;
  evalTokensPerSecond: number | null;
  loadDurationSeconds: number | null;
  totalDurationSeconds: number | null;
  memoryBefore: SystemMemoryState;
  memoryAfter: SystemMemoryState;
}

export interface BenchDeps {
  fetchTags: () => Promise<OllamaTagsResponse>;
  fetchPs: () => Promise<OllamaPsResponse>;
  generate: (model: string, prompt: string, timeoutMs?: number) => Promise<OllamaGenerateResponse | null>;
  unloadModel: (model: string) => Promise<void>;
  pullModel: (model: string) => Promise<void>;
  readSystemMemory: () => SystemMemoryState;
}

const defaultDeps: BenchDeps = {
  fetchTags: realFetchTags,
  fetchPs: realFetchPs,
  generate: realGenerate,
  unloadModel: realUnloadModel,
  pullModel: realPullModel,
  readSystemMemory: realReadSystemMemory,
};

export async function runBench(model: string, deps: BenchDeps = defaultDeps): Promise<BenchResult> {
  const tags = await deps.fetchTags();
  const alreadyPulled = tags.models.some((m) => m.name === model);
  if (!alreadyPulled) {
    await deps.pullModel(model);
  }

  const memoryBefore = deps.readSystemMemory();
  const response = await deps.generate(model, BENCH_PROMPT, GENERATE_TIMEOUT_MS);
  const ps = await deps.fetchPs();
  const running = ps.models.find((m) => m.name === model);
  const memoryAfter = deps.readSystemMemory();
  await deps.unloadModel(model);

  const sizeVramGb = running ? running.size_vram / 1e9 : null;

  if (response === null) {
    return {
      model,
      status: 'timed-out',
      sizeVramGb,
      evalTokensPerSecond: null,
      loadDurationSeconds: null,
      totalDurationSeconds: null,
      memoryBefore,
      memoryAfter,
    };
  }

  const evalTokensPerSecond =
    response.eval_count && response.eval_duration
      ? response.eval_count / (response.eval_duration / 1e9)
      : null;

  return {
    model,
    status: 'completed',
    sizeVramGb,
    evalTokensPerSecond,
    loadDurationSeconds: response.load_duration ? response.load_duration / 1e9 : null,
    totalDurationSeconds: response.total_duration ? response.total_duration / 1e9 : null,
    memoryBefore,
    memoryAfter,
  };
}
```

- [ ] **Step 4: Run `bench.test.ts` to verify it passes**

Run: `npx vitest run test/bench.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing test for `formatBenchResult`**

Extend `test/format.test.ts` (add to the file from Task 6) — add this import alongside the existing ones:

```typescript
import { formatBenchResult } from '../src/format.js';
import type { BenchResult } from '../src/bench.js';
```

and this describe block:

```typescript
describe('formatBenchResult', () => {
  const memoryBefore = {
    totalGb: 24, usedGb: 3, wiredGb: 3, compressorGb: 6, unusedGb: 15,
    swapTotalGb: 0, swapUsedGb: 0, swapFreeGb: 0,
  };
  const memoryAfter = { ...memoryBefore, usedGb: 23, unusedGb: 0.1, swapUsedGb: 22.6 };

  it('reports tokens/sec and durations for a completed run', () => {
    const result: BenchResult = {
      model: 'gemma3:12b',
      status: 'completed',
      sizeVramGb: 8.64,
      evalTokensPerSecond: 15.5,
      loadDurationSeconds: 12.88,
      totalDurationSeconds: 24.06,
      memoryBefore,
      memoryAfter,
    };
    const output = formatBenchResult(result);
    expect(output).toContain('gemma3:12b');
    expect(output).toContain('15.5');
    expect(output).toContain('completed');
  });

  it('reports a plain-language timeout message without fabricating numbers', () => {
    const result: BenchResult = {
      model: 'gemma3:27b',
      status: 'timed-out',
      sizeVramGb: 16.91,
      evalTokensPerSecond: null,
      loadDurationSeconds: null,
      totalDurationSeconds: null,
      memoryBefore,
      memoryAfter,
    };
    const output = formatBenchResult(result);
    expect(output).toContain('timed-out');
    expect(output.toLowerCase()).toContain('swap');
  });

  it('shows the swap delta between before and after', () => {
    const result: BenchResult = {
      model: 'gemma3:27b',
      status: 'timed-out',
      sizeVramGb: 16.91,
      evalTokensPerSecond: null,
      loadDurationSeconds: null,
      totalDurationSeconds: null,
      memoryBefore,
      memoryAfter,
    };
    const output = formatBenchResult(result);
    expect(output).toContain('22.6');
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run test/format.test.ts`
Expected: FAIL — `formatBenchResult` is not exported from `src/format.ts` yet.

- [ ] **Step 7: Add `formatBenchResult` to `src/format.ts`**

Add this import at the top of `src/format.ts` (alongside the existing ones):

```typescript
import type { BenchResult } from './bench.js';
```

and append this function:

```typescript
export function formatBenchResult(result: BenchResult): string {
  const lines: string[] = [];
  lines.push(`Model: ${result.model}`);
  lines.push(`Status: ${result.status}`);
  if (result.sizeVramGb !== null) {
    lines.push(`VRAM: ${result.sizeVramGb.toFixed(2)}GB`);
  }
  if (result.status === 'completed') {
    lines.push(`Load duration: ${result.loadDurationSeconds?.toFixed(2)}s`);
    lines.push(`Tokens/sec: ${result.evalTokensPerSecond?.toFixed(1)}`);
    lines.push(`Total duration: ${result.totalDurationSeconds?.toFixed(2)}s`);
  } else {
    lines.push('Did not complete within timeout — likely heavy swap contention.');
  }
  const swapDeltaGb = result.memoryAfter.swapUsedGb - result.memoryBefore.swapUsedGb;
  lines.push(
    `Swap used: ${result.memoryBefore.swapUsedGb.toFixed(1)}GB -> ${result.memoryAfter.swapUsedGb.toFixed(1)}GB ` +
      `(Δ ${swapDeltaGb >= 0 ? '+' : ''}${swapDeltaGb.toFixed(1)}GB)`
  );
  return lines.join('\n');
}
```

- [ ] **Step 8: Run all tests to verify everything passes together**

Run: `npm test`
Expected: PASS — all suites across Tasks 1–7 green.

- [ ] **Step 9: Verify typecheck passes for the whole project**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 10: Commit**

```bash
git add src/bench.ts src/format.ts test/bench.test.ts test/format.test.ts
git commit -m "Add bench command orchestration and its output formatting"
```

---

### Task 8: CLI wiring + README

**Files:**
- Modify: `src/cli.ts`
- Create: `README.md` (overwrite the current placeholder `"an idea... to be specified"`)
- Test: `test/cli.test.ts` (extend)

**Interfaces:**
- Consumes: `runCheck` (Task 6), `runBench` (Task 7), `formatCheckTable`, `formatCheckJson`, `formatBenchResult` (Task 6)
- Produces: the final `ollama-scope check [--json] [-q|--query <query>]` and `ollama-scope bench <model>` commands

- [ ] **Step 1: Write failing tests for the wired-up subcommands**

Extend `test/cli.test.ts` (add to the existing file from Task 1):

```typescript
describe('createProgram subcommands', () => {
  it('registers a check command with --json and --query options', () => {
    const program = createProgram();
    const check = program.commands.find((c) => c.name() === 'check');
    expect(check).toBeDefined();
    const optionNames = check!.options.map((o) => o.long);
    expect(optionNames).toContain('--json');
    expect(optionNames).toContain('--query');
  });

  it('registers a bench command requiring a model argument', () => {
    const program = createProgram();
    const bench = program.commands.find((c) => c.name() === 'bench');
    expect(bench).toBeDefined();
    expect(bench!.registeredArguments.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — `check`/`bench` subcommands not yet registered.

- [ ] **Step 3: Update `src/cli.ts`**

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { runCheck } from './check.js';
import { runBench } from './bench.js';
import { formatCheckTable, formatCheckJson, formatBenchResult } from './format.js';

export function createProgram(): Command {
  const program = new Command();
  program
    .name('ollama-scope')
    .description("Right-size Ollama models for this machine's memory and quantization");

  program
    .command('check')
    .description('Static analysis: which models fit this machine right now (no models are loaded)')
    .option('--json', 'output as JSON')
    .option('-q, --query <query>', 'remote search query on ollama.com', 'mlx')
    .action(async (opts: { json?: boolean; query: string }) => {
      try {
        const result = await runCheck(opts.query);
        console.log(opts.json ? formatCheckJson(result) : formatCheckTable(result));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  program
    .command('bench')
    .argument('<model>', 'model name to benchmark (will be pulled if not already present)')
    .description('Live benchmark: pull, load, generate, measure real memory/tok-s impact')
    .action(async (model: string) => {
      try {
        const result = await runBench(model);
        console.log(formatBenchResult(result));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  return program;
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  createProgram().parseAsync(process.argv);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full test suite and typecheck one more time**

Run: `npm test && npm run typecheck`
Expected: all green, no errors

- [ ] **Step 6: Build and smoke-test the real binary**

```bash
npm run build
node dist/cli.js check
node dist/cli.js --help
```

Expected: `check` prints a real table using your actual currently-pulled models and live memory state (no crash); `--help` lists both `check` and `bench`.

- [ ] **Step 7: Write `README.md`**

```markdown
# ollama-scope

Right-size [Ollama](https://ollama.com) models for this machine's memory and quantization.

Ollama's own `/api/ps` reports a model's VRAM footprint with no signal about
whether the rest of the system has room for it — a model can "fit" and still
push the whole machine into heavy swap. `ollama-scope` answers two questions:

- **`ollama-scope check`** — static analysis, no models are loaded. Reads
  locally-pulled models plus a live scrape of `ollama.com/search`, estimates
  memory footprint from parameter count and quantization, and classifies
  each as comfortable / tight / will-thrash against both a fixed macOS
  baseline reserve and whatever's actually free right now.
- **`ollama-scope bench <model>`** — live benchmark. Pulls (if needed),
  loads, runs a fixed prompt, and reports real VRAM usage, tokens/sec, and
  the before/after system memory and swap delta.

## Usage

```bash
npm install
npm run build
node dist/cli.js check
node dist/cli.js check --json
node dist/cli.js check --query gemma
node dist/cli.js bench gemma3:12b
```

## Design

See [`docs/superpowers/specs/2026-08-04-ollama-scope-cli-design.md`](docs/superpowers/specs/2026-08-04-ollama-scope-cli-design.md)
for the memory estimation model, verdict thresholds, and the reasoning
behind them (grounded in real measurements, not just spec-sheet math).

## Requirements

- macOS (system memory reads use `top`/`sysctl`, not portable yet)
- Node >= 20
- A running `ollama serve` for both commands
```

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts test/cli.test.ts README.md
git commit -m "Wire up check and bench subcommands; write README"
```

---

## Post-plan verification

After Task 8:

```bash
npm test
npm run typecheck
npm run build
node dist/cli.js check
```

All four should succeed, and the final `check` output should be a real table reflecting whatever models are actually pulled on this machine right now.
