# Adding platform and backend support to llamafit

You probably got here from a generated prompt (`src/prompts.ts`) pointing at a
diagnostics bundle: a JSON file produced by `llamafit`'s `--diagnose` flow
(`src/diagnostics.ts`) when it hit something it couldn't handle — an
unsupported OS, no detectable inference backend, an unknown quantization, or
a backend response it couldn't parse. This doc is the contract for fixing
that gap: the interfaces you implement, what the reference implementations
look like, and what has to be true before you open a PR.

Read the bundle first. It has `platform`, the `gaps` array (each with a
`kind`, `summary`, and `evidence`), and `probeEvidence` — the raw command
output your machine's memory probe collected (or `null` if it never got that
far). That's your ground truth; use it to build fixtures rather than
hand-writing them.

## 1. How llamafit fits together

llamafit is three small interfaces plus a data layer, wired together by
`src/check.ts` (static analysis) and `src/bench.ts` (live benchmark).

**Backend** (`src/backends/types.ts`) talks to an inference server or
runtime: detecting whether it's present, listing local and remote models,
and running a generation. Most of its surface is optional — a backend
declares only the capabilities it actually has, and callers degrade
gracefully when a method is missing. The reference implementation is
`src/backends/ollama/`, registered in `src/backends/registry.ts`.

**SystemProbe** (`src/probes/types.ts`) reads how much memory the host has
and how much of it is actually available, plus swap. It's the thing that
makes llamafit platform-specific — there's exactly one probe per OS. The
reference implementation is `src/probes/darwin.ts`, registered in
`src/probes/registry.ts`.

**Estimator** (`src/estimators/types.ts`) is a pure function: given a
model's parameter count and quantization, plus the current headroom numbers,
it produces a footprint estimate and a comfortable/tight/will-thrash
verdict. `src/estimators/formula.ts` is the only implementation and you
almost certainly don't need a new one — new platforms and backends need a
probe or a backend, not a new estimator.

**Data layer** (`src/data.ts` + `data/quants.json`, `data/calibration.json`,
`data/thresholds.json`) is what the estimator reads: bytes-per-parameter by
quantization scheme, an empirically-derived overhead multiplier with its
provenance, and per-platform verdict thresholds. `src/data.ts` loads and
validates each file and throws on load if the shape is wrong, so a malformed
edit fails fast rather than silently producing bad numbers.

Everything that doesn't fit — an unrecognized platform, no backend detected,
an unknown quant, a backend response that doesn't parse — gets recorded as a
`Gap` (`src/gaps.ts`) and turned into an agent prompt (`src/prompts.ts`) and
a diagnostics bundle (`src/diagnostics.ts`). That's the loop this doc closes.

## 2. Adding a SystemProbe

The interface, from `src/probes/types.ts`:

```ts
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

export interface SystemProbe {
  platform: string;
  read(): Promise<SystemMemoryState>;
  /** Raw command outputs keyed by command name, for diagnostics bundles. */
  describe(): Promise<Record<string, string>>;
}
```

`platform` must match the value `llamafit` sees from Node's `os.platform()`
(`darwin`, `linux`, `win32`, ...) — that's the string `src/probes/registry.ts`
dispatches on.

### `SystemMemoryState` field semantics

These are cribbed from README.md's "About current headroom" section, which
explains why the estimator uses `wiredGb` rather than the OS's own "free"
number:

- `totalGb` — total physical memory.
- `usedGb` — memory in active use (whatever the OS calls "used").
- `wiredGb` — the one field that matters most: memory the kernel genuinely
  cannot reclaim (can't page out, can't compress). This is what llamafit
  subtracts from `totalGb` to get "current headroom" — a deliberate
  approximation, treated as an optimistic upper bound rather than an exact
  available-memory figure.
- `compressorGb` — memory held by the OS's memory compressor.
- `unusedGb` — literally idle memory. On macOS this sits near zero almost
  constantly even on an idle machine, because the OS spends free RAM on the
  compressor and file cache — don't use this as your "available" number, or
  everything will read as will-thrash.
- `swapTotalGb`, `swapUsedGb`, `swapFreeGb` — swap file/partition usage.

If your platform's tools don't cleanly distinguish all of these, prefer
under-reporting than fabricating: a `SystemProbe` must produce *some* number
for every field (the conformance suite requires finite, non-negative values),
but it's fine for a field to be conservatively estimated from what your OS
does expose. Note it in the module's comments the way `src/probes/darwin.ts`
does for its own limitation (no active/inactive/purgeable breakdown).

### Reference implementation: `src/probes/darwin.ts`

`createDarwinProbe(exec)` takes an injectable `exec` function (defaulting to
`execFileSync`) and runs three commands, defined as a `commands` map so
`read()` and `describe()` share exactly one source of truth for what gets
run:

- `top -l 1 -s 0` → parsed by `parseTopOutput` for `usedGb`, `wiredGb`,
  `compressorGb`, `unusedGb`.
- `sysctl vm.swapusage` → parsed by `parseSwapUsage` for the three swap
  fields.
- `sysctl -n hw.memsize` → parsed by `parseHwMemsize` for `totalGb`.

Each parser is a small regex match against a real captured command output,
throwing a clear error (`Could not parse '...' output: ...`) if the shape
changes. `read()` calls all three and assembles a `SystemMemoryState`;
`describe()` re-runs the same commands and returns their raw text keyed by
the command string, catching failures per-command as `FAILED: <message>`
strings rather than letting the whole thing reject — `describe()` must never
reject, because it's what feeds the diagnostics bundle when something else
is already broken.

Your probe doesn't have to shell out to CLI tools specifically — it just has
to produce the same two methods. But keep the "never reject from `describe()`"
property; a probe author debugging a partial failure needs the evidence
`describe()` collected even when `read()` couldn't be trusted.

### Turning bundle `probeEvidence` into fixtures

When `read()` or `describe()` fails on someone's machine, `describe()`'s
output — keyed by the same command-name strings `read()` uses internally —
ends up verbatim in the diagnostics bundle's `probeEvidence` field
(`src/diagnostics.ts`'s `DiagnosticsInput.probeEvidence`). That's your test
data. For darwin, `test/darwin-probe.test.ts` uses exactly this pattern: a
`fakeExec` function that returns the contents of `test/fixtures/top-output.txt`,
`test/fixtures/swapusage-output.txt`, and `test/fixtures/hw-memsize.txt` for
the matching command, instead of calling real system commands.

For a new platform: take each key from the bundle's `probeEvidence` object,
write its value verbatim to a new file under `test/fixtures/` (plain text,
no JSON wrapping — one file per command, following the existing
`<command>-output.txt` naming convention), then write an `exec` fake in your
probe's test file that returns the matching fixture for each command your
probe runs, mirroring `test/darwin-probe.test.ts`'s `fakeExec`.

### Registering

Add your probe to `src/probes/registry.ts`:

```ts
export function selectProbe(platform: string): SystemProbe | null {
  if (platform === 'darwin') return createDarwinProbe();
  return null;
}
```

Add a branch for your platform string before the `return null` fallback.

### `data/thresholds.json`

```json
{
  "tightRatio": 0.7,
  "thrashRatio": 0.95,
  "baselineReserveGb": { "darwin": 8 }
}
```

`baselineReserveGb` is keyed by platform and used by `src/check.ts` to
compute "baseline headroom" (`totalGb` minus a fixed OS reserve, as opposed
to "current headroom" which subtracts live `wiredGb`). Add an entry for your
platform — the value is however much memory your OS reserves for itself
before user allocations start feeling pressure. If you skip this, `check`
still runs (`src/check.ts` falls back to 8 GB, the macOS figure, for any
platform without an entry), but that number is very likely wrong for your
platform, so add a real one.

### Conformance expectations

`test/conformance/probe.ts` exports `describeProbeConformance(label, setup)`
— a suite you invoke from your own probe's test file, not a test file
itself (it's excluded from vitest's `test/**/*.test.ts` include). It checks:

- `platform` is a non-empty string.
- `read()` resolves to a `SystemMemoryState` where every field is finite and
  `>= 0`, and `totalGb > 0`.
- `describe()` resolves to a non-empty `Record<string, string>` and never
  rejects.

Wire it up the way `test/darwin-probe.test.ts` does:

```ts
describeProbeConformance('darwin', async () => createDarwinProbe(fakeExec));
```

## 3. Adding a Backend

The interface, from `src/backends/types.ts`:

```ts
/** Aggregated download progress across all files a pull is fetching in parallel. */
export interface PullProgress {
  doneBytes: number;
  totalBytes: number;
}

export interface RemoteCandidateOptions {
  /** Server-side size filter — candidates above this are never fetched. */
  maxParameterSizeB?: number;
}

export interface RemoteSourceReport {
  id: string; // 'ollama.com' | 'huggingface'
  query: string; // the query actually sent to this source
  ok: boolean;
  error?: string; // present when ok is false
}

export interface RemoteDiscovery {
  candidates: ModelInfo[];
  sources: RemoteSourceReport[];
}

export interface Backend {
  id: string;
  displayName: string;
  detect(): Promise<Detection>;
  localModels(): Promise<LocalModels>;
  /** Resolves null on timeout — a meaningful result, not an error. */
  generate(model: string, prompt: string, timeoutMs?: number): Promise<GenerateResult | null>;
  // Optional capabilities — absent method = backend can't do it; callers degrade and say so.
  remoteCandidates?(query?: string, opts?: RemoteCandidateOptions): Promise<RemoteDiscovery>;
  loadedModels?(): Promise<LoadedModel[]>;
  /** onProgress is best-effort UI plumbing: it may never fire (a download can
   * complete before any progress event), and implementations need not guard
   * against it throwing. */
  pull?(model: string, onProgress?: (p: PullProgress) => void): Promise<void>;
  unload?(model: string): Promise<void>;
}
```

`Detection`, `LocalModels`, `ModelInfo`, `LoadedModel`, and `GenerateResult`
are all defined in `src/types.ts`. A backend can back `remoteCandidates` with
more than one source (e.g. a scrape and an API query) — `RemoteDiscovery`
carries both the merged `candidates` and a `sources` report per source
queried. Source-level failures are reported as a `RemoteSourceReport` with
`ok: false` and an `error` message; `remoteCandidates` itself must never
throw for a single source going down, only for something backend-wide (a bug,
not a source outage). `query === undefined` means "the caller gave no query —
apply your own per-source default," not "pass an empty string upstream."
`opts.maxParameterSizeB` on `remoteCandidates` is a server-side size filter —
backends that can't apply it upstream (or don't support remote discovery at
all) are free to ignore it. A backend with multiple sources can apply it
selectively, per source: ollama's HF query takes the cap (the HF API accepts
a `num_parameters` filter), its `ollama.com` scrape does not (the search page
has no such param, so it returns oversized rows too — the check table still
gives those an informative "won't fit" verdict rather than silently dropping
them).

### Required vs. optional, and what absence means

`id`, `displayName`, `detect()`, `localModels()`, and `generate()` are
required — every backend must at least say who it is, whether it's present,
what's already pulled, and be able to run a prompt. The rest is genuinely
optional, and `src/check.ts`/`src/bench.ts` are written to degrade rather
than fail when a capability is missing:

- **No `loadedModels`** — `src/check.ts` calls it as
  `backend.loadedModels?.() ?? Promise.resolve([])`. With nothing to
  measure, every row in the check table is `estimateSource: 'estimated'`;
  no row ever gets the real-VRAM `'measured'` treatment. `src/bench.ts`
  pushes a note: `"<displayName> can't report per-model VRAM; footprint
  shown is the system-memory delta only"`.
- **No `unload`** — `src/bench.ts` pushes a note:
  `"<displayName> can't unload models — '<model>' is still loaded"`, and
  skips the unload call in its `finally` block (see the comment above
  `runBench` about why that cleanup is exception-safe when the capability
  *is* present).
- **No `pull`** — if the requested bench model isn't already local,
  `runBench` throws rather than silently failing:
  `"<displayName> can't pull models — pull '<model>' yourself, then
  re-run"`.
- **No `remoteCandidates`** — `src/check.ts` calls it as
  `const discovery = await backend.remoteCandidates?.(query, opts);` and,
  when `discovery` is present, reads `discovery.candidates` and
  `discovery.sources` off it (an absent capability just leaves both at their
  empty defaults). No remote rows appear in the check table; this is not a
  gap (a *failed* source is — each `RemoteSourceReport` with `ok: false`
  produces its own `scrape-failed` gap via `GapCollector`, one per failed
  source, and a throw from `remoteCandidates` itself is treated the same way
  as a backstop).

### Reference implementation: `src/backends/ollama/`

`detect()` (`src/backends/ollama/index.ts`) hits `${OLLAMA_BASE_URL}/api/version`
and never throws: a non-OK response or a network error both resolve to
`{ detected: false, version: null, evidence: { baseUrl, error } }` rather
than rejecting, matching the conformance suite's "never rejects" requirement.

`remoteCandidates` queries two independent sources and merges them into one
`RemoteDiscovery`:

- an HTML scrape of `ollama.com/search`, defaulting to the query `'mlx'`
  when the caller passes no query (ollama.com's own historical search
  default);
- a Hugging Face Hub API query via `searchGgufModels`
  (`src/hf/discovery.ts`), defaulting to `''` — bare trending — when the
  caller passes no query, matching llama-server's own HF-only behavior.

Both run through `Promise.allSettled`, not `Promise.all`: the two sources
fail independently, so one being down must not blank the other's rows or
throw away its report. Each settled result becomes one `RemoteSourceReport`
(`{ id: 'ollama.com' | 'huggingface', query, ok, error? }`) regardless of
whether it fulfilled or rejected. HF candidates are pulled as
`hf.co/<repoId>` (Ollama's own convention for pulling a Hugging Face repo
directly), built by a small `hfPullName` mapper passed into the shared
`hfCandidatesToModelInfo` (`src/hf/model-info.ts`) — see the llama-server
section below for why that mapper is shared rather than duplicated.

Mapping from Ollama's wire format to llamafit's types is factored into pure,
independently-tested functions in `src/backends/ollama/index.ts`:
`mapTagsToLocalModels` (from `OllamaTagsResponse`, defined in
`src/backends/ollama/client.ts`, to `LocalModels` — also where cloud models
get filtered into `skipped`), `mapPsToLoaded` (from `OllamaPsResponse` to
`LoadedModel[]`), and `mapCandidates` (from the HTML-scrape result type
`RemoteModelCandidate` in `src/backends/ollama/scrape.ts` to `ModelInfo[]` —
the `ollama.com` side only; the Hugging Face side goes through the shared
`hfCandidatesToModelInfo` instead). Keep this separation for your own
backend: a pure mapping function can be tested directly against a captured
fixture, with no network or process involved.

### Fixture conventions

`test/fixtures/` holds real captured responses, not hand-rolled JSON:
`api-tags.json`, `api-ps-loaded.json`, `api-ps-empty.json`,
`api-show-gemma3-12b.json` for Ollama's REST API, and
`ollama-search-mlx.html` for its scraped search page. Loaded via the
`loadJsonFixture`/`loadTextFixture` helpers in
`test/helpers/fixture-backend.ts`.

That same file also exports `fixtureBackend(overrides)`: a `Backend` built
from real fixtures run through the *actual* mapping functions (so a mapping
bug can't hide behind hand-written test data), used by the check/bench tests
instead of a live server. Pass `{ loadedModels: undefined }` or similar to
model a backend missing a capability, and confirm `check`/`bench` degrade
the way the previous section describes. Follow this pattern for your own
backend: capture real API responses into `test/fixtures/`, write mapping
functions that consume them, and build an equivalent fixture-backed `Backend`
for your tests.

### `describeBackendConformance` usage

`test/conformance/backend.ts` exports `describeBackendConformance(label,
setup)`, invoked from your backend's own test file the same way
`test/ollama-backend.test.ts` does:

```ts
describeBackendConformance('ollama', async () => ollamaBackend);
```

It checks: `id`/`displayName` are non-empty strings; `detect()` resolves to
a `Detection` shape and never rejects; every row from `localModels()` has
`source: 'local'` and a string `name`; and every optional capability that is
present is actually a function (guards against, e.g., accidentally exporting
`unload: undefined` instead of omitting the key).

### Registering

Add your backend to the `BACKENDS` array in `src/backends/registry.ts`:

```ts
const BACKENDS: Backend[] = [ollamaBackend];
```

`allBackends()`, `findBackend(id)`, and `detectBackends()` all read from
this array — nothing else needs to change for your backend to be picked up
by `--backend <id>` or by autodetection.

### Second implementation: `src/backends/llama-server/`

llama.cpp's `llama-server` (router mode only — classic single-instance mode
is out of scope) is the example of a deliberately degraded backend: it
implements `detect()`, `localModels()`, `generate()`, `unload()`, `pull()`,
and `remoteCandidates()` (backed by Hugging Face Hub search — see
`src/hf/discovery.ts`), but omits `loadedModels()`. Its `remoteCandidates()`
maps `HfCandidate[]` to `ModelInfo[]` via the same `hfCandidatesToModelInfo`
in `src/hf/model-info.ts` that the ollama backend uses for its HF source —
the only per-backend difference is the pull-name shape passed in
(llama-server uses the bare `repoId`; ollama uses `hf.co/<repoId>`). Two of
its behaviors are worth knowing if you're adapting another llama.cpp-family
server:

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

## 4. Quantization table

`data/quants.json`:

```json
{
  "fallback": "Q4_K_M",
  "entries": [
    { "id": "F32", "bytesPerParam": 4.0, "aliases": ["FP32"] },
    { "id": "F16", "bytesPerParam": 2.0, "aliases": ["BF16", "FP16"] },
    ...
  ]
}
```

Loaded and validated by `loadQuantTable()` in `src/data.ts`: `entries` must
be non-empty, every `id`/alias name across the whole file must be unique,
and `fallback` must name an entry that exists. `lookupQuant(table,
rawQuant)` trims and uppercases the input, matches against any entry's `id`
or `aliases`, and falls back to the `fallback` entry with `known: false` if
nothing matches — that `known: false` is what triggers an `unknown-quant`
gap in `src/estimators/formula.ts`'s caller (`src/check.ts`).

**Alias vs. new entry:** if the quantization scheme you're adding has the
*same* bytes-per-parameter value as an existing entry (e.g. `BF16` and
`FP16` are both 2.0), add it as an alias on that entry. Add a new entry only
when the bytes-per-param value actually differs — duplicating a value across
two entries just makes the table harder to audit.

**Requirement:** cite a source for the `bytesPerParam` value in your PR
body. This number is a formula input, not something llamafit measures — get
it wrong and every estimate downstream is wrong. A model card, a
quantization scheme's spec, or a measured weights-file size divided by
parameter count are all acceptable; "I guessed" is not.

## 5. Calibration

`data/calibration.json`:

```json
{
  "overheadMultiplier": 1.25,
  "provenance": [
    { "backend": "ollama", "model": "llama3.2:3b", "predictedWeightsGb": 1.8, "measuredVramGb": 2.3 },
    ...
  ],
  "backends": {}
}
```

`formulaEstimator` (`src/estimators/formula.ts`) computes
`footprintGb = parameterSizeB * bytesPerParam * overheadMultiplier` — the
multiplier exists because raw weights size undercounts actual VRAM use
(KV cache, activations, runtime overhead). `loadCalibration()` in
`src/data.ts` refuses to load the file if `provenance` is empty: "every
multiplier needs evidence."

`llamafit bench <model>` (`src/bench.ts`) is how you produce that evidence: it
loads a real model, runs a generation, and reports `sizeVramGb` — the actual
measured resident VRAM (via the backend's `loadedModels()`, when available).
Compare that to what the formula alone would predict
(`parameterSizeB * bytesPerParam`, before the multiplier) for the same
model, and that ratio is a data point toward `overheadMultiplier`.

**Requirement:** don't just edit `overheadMultiplier`. Add a new row to
`provenance` — `backend`, `model`, `predictedWeightsGb`, `measuredVramGb` —
from a real `bench` run backing the change, the same way the existing rows
do. The `backends` map is reserved for future per-backend multipliers (the
`Calibration` type in `src/data.ts` supports it) but is currently unused by
`formulaEstimator`, which only reads the top-level `overheadMultiplier`.

## 6. Checklist before opening a PR

- [ ] `npm test` passes (runs `vitest run`, including the conformance suites
      wired up from your new probe's or backend's test file).
- [ ] `npm run typecheck` passes (`tsc --noEmit`).
- [ ] Your probe or backend is wired into `describeProbeConformance` /
      `describeBackendConformance` and that suite is green — not just
      passing incidentally as part of `npm test`, actually check it ran
      (`npm test` output names each `describe` block).
- [ ] Fixtures are added under `test/fixtures/` from real captured data (a
      diagnostics bundle's `probeEvidence`, or real backend API/HTML
      responses) — not hand-written JSON standing in for the real shape.
- [ ] Tests make no network calls and run no real system commands. Fake
      `exec`/`fetch` the way `test/darwin-probe.test.ts` (injectable `exec`)
      and `test/ollama-backend.test.ts` (`globalThis.fetch` stubbed in
      `beforeEach`/restored in `afterEach`) do.
- [ ] If you touched `data/quants.json` or `data/calibration.json`, your PR
      body cites a source (section 4) or a `bench` provenance row (section 5).
