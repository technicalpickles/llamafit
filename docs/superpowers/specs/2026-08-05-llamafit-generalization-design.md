# llamafit — Generalizing ollama-scope: Design

## Purpose

Evolve `ollama-scope` from a macOS+Ollama-specific tool into **llamafit**, a
shareable CLI that answers "which local LLMs actually fit this machine?"
across multiple inference backends and platforms, with an explicit
contribution funnel: when the tool hits something it doesn't support, it
produces a diagnostics bundle and a ready-to-paste agent prompt (plus a
pre-filled issue link) so anyone can extend it.

Concrete near-term targets driving the seams (each a roadmap phase, not
part of this spec's implementation scope):

- **Backends**: llama.cpp's `llama-server`, Unsloth Studio (desktop app
  with an OpenAI-compatible API). Ollama remains the reference backend.
- **Platforms**: Linux (`/proc/meminfo`, possibly discrete-GPU VRAM).
  macOS remains the reference platform.
- **Quantizations**: unsloth dynamic quants (`UD-Q4_K_XL` etc.), MLX-style
  labels (`4bit`) — handled by the data layer, not new code.

## Decisions already made

- **Approach**: in-tree adapters behind TypeScript interfaces, with
  cheaply-varying values (quant tables, calibration, thresholds) as
  checked-in data files. **No runtime plugin system** — extension is by PR,
  and the failure flow is designed to make those PRs easy for humans and
  agents alike.
- **Scope**: this spec covers the architecture carve-out, the failure →
  diagnostics → prompt flow, and the rename + npm publish. Linux,
  llama-server, and unsloth are phased follow-ups
  (`linux-probe`, `llama-server-backend`, `unsloth-backend`), each getting
  its own plan against the by-then-real interfaces.
- **Name/distribution**: rename to **llamafit** (verified available on npm),
  publish to npm with a `bin` entry so `npx llamafit check` works cold, repo
  public on GitHub.

## Non-goals

- No runtime plugin loading, plugin API versioning, or out-of-tree
  adapters.
- No auto-calibration feedback loop: `bench` prints observed overhead so a
  human/agent can PR a calibration entry, but the tool never edits its own
  data.
- No attempt to support backends/platforms beyond the reference
  implementations in this phase — the deliverable is the seams plus the
  funnel, proven by the existing macOS+Ollama code re-landing as adapters.
- Model discovery stays inside each backend (Ollama's `ollama.com/search`
  scrape is an Ollama implementation detail). A standalone
  discovery/source interface (e.g. HuggingFace feeding multiple backends)
  is a noted future seam, not built now.

## Architecture: three interfaces

Each interface's first implementation is a carve-out of existing code, not
a rewrite. Behavior of `check` and `bench` on macOS+Ollama must be
unchanged after the refactor.

### `Backend`

Where models come from *and* what runs them.

```ts
interface Backend {
  id: string;                            // "ollama", "llama-server", ...
  detect(): Promise<Detection>;          // reachable? version? evidence for diagnostics
  localModels(): Promise<ModelInfo[]>;   // installed models + metadata (params, quant, disk size)
  // Optional capabilities — declared, not assumed:
  remoteCandidates?(query?: string): Promise<ModelCandidate[]>; // Ollama: scrape; others: absent
  loadedModels?(): Promise<LoadedModel[]>;  // Ollama /api/ps with size_vram; OpenAI-compat servers: absent
  pull?(model: string): Promise<void>;
  generate(model: string, prompt: string): Promise<GenerateResult>; // timings for bench
  unload?(model: string): Promise<void>;
}
```

The commands degrade per-capability and say so in output:

- No `loadedModels` → `bench` reports system-memory delta only, labeled as
  such; `check` never shows "measured" rows.
- No `remoteCandidates` → `check` reports local models only.
- No `pull` → `bench` requires the model to already be present.
- No `unload` → `bench` warns it's leaving the model loaded.

`check` runs detection across all registered backends and sections the
report per detected backend; `--backend <id>` pins one. Ollama's current
client, scraper, and cloud-model detection move under `src/backends/ollama/`.

### `SystemProbe`

Platform memory/swap reading.

```ts
interface SystemProbe {
  platform: string;                   // matches process.platform
  read(): Promise<SystemMemory>;      // total, wired/unreclaimable, swap state
  describe(): Promise<ProbeEvidence>; // raw command outputs, for diagnostics bundles
}
```

Selected by `process.platform`. Current `top`/`sysctl` code becomes
`src/probes/darwin.ts`. An unmatched platform is a **gap** (see failure
flow), not a bare error.

### `Estimator`

Model metadata + system state → footprint estimate + verdict.

```ts
interface Estimator {
  id: string;
  estimate(model: ModelInfo, system: SystemMemory): Estimate; // footprint, verdicts, confidence flags
}
```

v1 has exactly one implementation: the current formula
(`params × bytes_per_param(quant) × overhead`), now reading its inputs
from the data layer. The interface exists so a future estimator can use
e.g. HuggingFace per-file sizes instead of parameter math. No estimator
selection UI in v1.

## Data layer

Checked-in JSON in `data/`, imported at build time (no runtime config
discovery). Rationale: the most common "support this better" failures are
data gaps, and a one-entry data PR with evidence pasted in is the easiest
contribution for a drive-by human or agent.

- **`data/quants.json`** — quant string → bytes-per-param, with an
  `aliases` list per entry so `Q4_K_M`, `UD-Q4_K_XL`, `4bit`, etc. can map
  to the right row. Unknown quant: fall back to Q4_K_M's value, flag the
  row (current behavior), *and* record a gap carrying the literal unknown
  string.
- **`data/calibration.json`** — overhead multipliers with provenance:
  which (backend, model, measured size) justified each. Today: the single
  1.25× backed by the three measured models from the original design.
  Structure allows per-backend multipliers later. `bench` output prints
  observed overhead vs the table so drift is visible.
- **`data/thresholds.json`** — verdict boundaries (70% comfortable / 95%
  tight) and per-platform baseline reserve (darwin: 8GB).

Each file gets a schema-shaped TypeScript type and a load-time validation
test, so a malformed data PR fails CI with a useful message.

## Failure flow: gaps → bundle → two exits

Every "I don't know how to handle this" callsite reports a **typed gap**
instead of only warning:

```ts
type Gap = {
  kind: "unsupported-platform" | "no-backend-detected"
      | "unknown-quant" | "backend-response-unexpected" | "scrape-failed";
  evidence: Record<string, unknown>;   // raw outputs/responses, the unknown string, etc.
};
```

**Diagnostics bundle**: on any gap (or explicit `--diagnose`), write a
JSON bundle to `llamafit-diagnostics-<timestamp>.json` in the current
directory (printed on write), containing: tool version, platform info, gap records with
evidence, raw command outputs from `SystemProbe.describe()`, truncated raw
API responses. Scrub obvious personal noise (home-dir paths, hostnames)
beyond what's needed to reproduce.

**Two exits from one bundle**, both printed at the failure site:

1. **Agent prompt** — templated per gap kind, ready to paste into Claude
   Code/Codex. Example shapes:
   - `unsupported-platform`: "Clone `<repo>`. My machine produced this
     diagnostics bundle: `<path>`. Implement `SystemProbe` for this
     platform — see `src/probes/darwin.ts` as the reference and
     `docs/adapters.md` for the contract. Add fixtures from the bundle's
     raw outputs. Run the conformance test. Open a PR."
   - `unknown-quant`: "...add an entry or alias to `data/quants.json` for
     `<string>`, with a bytes-per-param value justified in the PR body."
2. **Issue link** — pre-filled GitHub issue URL containing the bundle
   summary, for people who'd rather hand it to the maintainer.

Supporting piece that makes the agent prompt actually land:
**`docs/adapters.md`** — a per-seam contribution guide (what each
interface method means, what fixtures look like, how to test without the
real platform/backend), written for agents as much as humans and pointed
to by every generated prompt.

## Rename and publish

- Package name `llamafit`, `bin: { "llamafit": "dist/cli.js" }`.
- Repo renamed/public on GitHub (prerequisite: both failure-flow exits
  need a public clone/issue target). The prompt/issue templates read the
  repo URL from `package.json`, not hardcoded strings.
- README rewritten around the general story: what it answers, the three
  seams, Ollama/macOS as reference implementations, the "hit a gap? the
  tool hands you the fix-it prompt" pitch, roadmap phases.
- Publish flow: manual `npm publish` for now; no release automation in
  this phase.

## Error handling

Unchanged philosophy, one upgrade:

- Scrape/remote failures: degrade with a warning (now also a recorded gap).
- Backend unreachable when explicitly pinned via `--backend`: fail fast.
- **No backend detected at all**: not a bare error — it's a gap, producing
  the bundle + agent prompt + issue link. The dead-end state *is* the
  contribution funnel.
- `bench` timeout stays a meaningful result, not a crash.

## Testing

- Existing fixture-based tests carry over; no test touches network or real
  system tools.
- **Conformance test suite per interface**: a shared spec any adapter
  implementation runs against (given fixtures, methods return
  correctly-shaped results; declared-absent capabilities are actually
  absent). A stranger's adapter PR learns exactly what contract it broke.
- **Failure-flow golden tests**: fixture gap in → expected bundle shape
  and expected prompt text out, per gap kind.
- **Data validation tests**: each `data/*.json` parses against its type;
  alias collisions and missing provenance fail.
- Refactor guardrail: `check`/`bench` output on the existing macOS+Ollama
  fixtures is unchanged pre/post carve-out (snapshot the current output
  first).

## Roadmap (each its own plan later)

1. `linux-probe` — `SystemProbe` for Linux; smallest seam-proof.
2. `llama-server-backend` — exercises degraded capabilities (no ps, no
   pull, models from disk/HF).
3. `unsloth-backend` — Unsloth Studio's OpenAI-compatible API; metadata
   surface to be learned during that phase.
