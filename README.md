# llamafit

Checks whether local LLMs actually fit this machine, not just whether they
technically load. A model can "fit" by Ollama's own bookkeeping and still
push the whole system into heavy swap, because VRAM-footprint reporting like
`/api/ps` has no signal about the rest of the machine's memory pressure.
`llamafit` answers two questions:

- **`llamafit check`** — static analysis, no models are loaded. Reads
  locally-pulled models plus remote candidates from `ollama.com/search` and
  Hugging Face Hub (pullable as `hf.co/<owner>/<repo>:<quant>`), estimates
  memory footprint from parameter count and quantization, and classifies
  each as comfortable / tight / will-thrash against both a fixed baseline
  reserve and whatever's actually free right now.
- **`llamafit bench <model>`** — live benchmark. Pulls (if needed), loads,
  runs a fixed prompt, and reports real VRAM usage, tokens/sec, and the
  before/after system memory and swap delta.

Backends and platforms sit behind small interfaces, so `llamafit` isn't
permanently tied to Ollama or macOS, that's just where it started. When it
hits something it doesn't support yet, it doesn't just fail quietly: see
["When llamafit doesn't support your setup"](#when-llamafit-doesnt-support-your-setup)
below.

## Usage

```bash
npx llamafit check
npx llamafit check --json
npx llamafit check --query gemma
npx llamafit bench gemma3:12b
```

Or install it locally:

```bash
npm install -g llamafit
llamafit check
llamafit bench gemma3:12b
```

A few flags worth knowing about:

- `--backend <id>` (on both `check` and `bench`) pins a specific backend
  instead of autodetecting one. Detection is skipped entirely, so if the
  backend you named isn't actually reachable, that shows up as a normal
  connection error rather than a "no backend detected" gap.
- `--diagnose` (on `check`) writes a diagnostics bundle even on a run that
  didn't hit anything worth reporting, which is handy when you're filing an
  issue about something short of a hard failure.
- `--json` (on `check`) prints machine-readable output on stdout; warnings
  and gap reporting still go to stderr, so piping the table doesn't pick up
  the chatter.
- `--local` / `--remote` / `--all` (on `check`) expand the capped local or
  remote section (or both) to show every row instead of the default top few
  plus a `+N more`. `--local --remote` together is rejected; use `--all`
  for that.

Point at a non-default server with `OLLAMA_HOST` (Ollama) or
`LLAMA_SERVER_BASE_URL` (llama-server), either as `host:port` or a full URL:

```bash
OLLAMA_HOST=192.168.1.50:11434 llamafit check
OLLAMA_HOST=http://192.168.1.50:11434 llamafit check

LLAMA_SERVER_BASE_URL=192.168.1.50:8080 llamafit check
LLAMA_SERVER_BASE_URL=http://192.168.1.50:8080 llamafit check
```

`LLAMA_SERVER_BASE_URL` defaults to `http://localhost:8080`.

## Reading the check table

The header line gives the two numbers everything else is relative to: the
safe budget (total memory minus a fixed reserve) and current headroom (what's
actually free right now). Every row below is one of two sources, `PULLED`
(models already local) or `PULLABLE` (remote candidates from `ollama.com`
and Hugging Face), each capped to a handful of rows unless you pass
`--local`, `--remote`, or `--all`.

Within a section, rows are grouped by fit rather than printed as a flat list:
`comfortable` first, then `pressured` (fits the safe budget but memory is
tight right now), `tight`, `over-budget` (fails the safe budget but happens
to fit given what's free this moment), `will-thrash`, and `unclassified`
(the backend didn't report enough to size it). A `Run now` / `Worth pulling`
line above the sections calls out the single best answer in each category
when there is one.

A model that's currently loaded (visible in Ollama's `/api/ps`) reports its
real resident size, so its footprint prints bare. Everything else is a formula
estimate and gets a `~`. A `?` after the quantization means the backend didn't
report one and the estimate assumed `Q4_K_M`, so treat that row as a rough
guess rather than a number.

Cloud-only models (Ollama's `:cloud` tag) aren't sized at all, so they're
left out of the table entirely; they still show up under `cloudModels` in
`--json`.

### About "current headroom"

Current headroom is computed as **total memory minus wired memory**, and it's
a deliberate approximation. Wired pages are the only thing here the kernel
truly can't reclaim: it can't page them out or compress them. Everything else
(active, inactive, compressed, free) is at least theoretically available to a
large new allocation, at some performance cost.

What it is not is an exact "available memory" figure. macOS's own `unused`
number is useless for this, it sits near zero almost constantly (a 24GB
machine sitting idle can report 145M unused) because macOS deliberately
spends free RAM on the compressor and file cache. Using it directly would
flag every model as will-thrash, including ones that load and run fine.

The limitation: the system memory reader parses `top`'s summary line, which
has no active/inactive/purgeable breakdown. That breakdown (from `vm_stat`)
is what you'd need for a genuinely precise number, so treat current headroom
as an optimistic upper bound and the baseline verdict as the conservative
one.

## When llamafit doesn't support your setup

`llamafit` is built on a few small interfaces: a backend that talks to an
inference server, a system probe that reads memory, an estimator that turns
model metadata into a verdict. Some failures mean one of those genuinely
doesn't cover your setup yet: an unrecognized quantization string, a
platform with no `SystemProbe`, or no backend it can detect at all. When
that happens, `llamafit` writes a diagnostics bundle
(`llamafit-diagnostics-<timestamp>.json`) with the raw evidence it collected,
prints a ready-to-paste prompt for handing to an AI coding agent, and
prints a pre-filled GitHub issue link for handing to a human instead.

A flaky remote source (the `ollama.com` scrape or a Hugging Face Hub query)
isn't one of those, it's just a warning on stderr, and the run finishes
normally — the other source's candidates still show up. That kind of
transient failure only shows up in a bundle if you ask for one with
`--diagnose`.

If you're the one closing a gap, by hand or with an agent, start at
[`docs/adapters.md`](docs/adapters.md). It's the contribution guide for
implementing a new `Backend`, `SystemProbe`, or data-layer entry, written to
be handed straight to an agent along with the bundle.

## Supported today / roadmap

- **Today**: Ollama and llama-server (backends, router mode only for the
  latter), macOS (platform). llama-server's router mode only exposes GGUF
  metadata for a model once it's been loaded at least once this server
  lifetime, so a model that's never been loaded shows up with `?` for
  params/quant/footprint instead of a real number, and llama-server never
  reports per-model VRAM the way Ollama's `/api/ps` does.
- **Next**, each its own phase: `linux-probe` (a Linux `SystemProbe`),
  `unsloth-backend` (Unsloth Studio's OpenAI-compatible API).

## Design

- [`docs/superpowers/specs/2026-08-04-ollama-scope-cli-design.md`](docs/superpowers/specs/2026-08-04-ollama-scope-cli-design.md)
  — the original memory estimation model, verdict thresholds, and the
  reasoning behind them, grounded in real measurements rather than
  spec-sheet math.
- [`docs/superpowers/specs/2026-08-05-llamafit-generalization-design.md`](docs/superpowers/specs/2026-08-05-llamafit-generalization-design.md)
  — the backend/probe/estimator interfaces, the data layer, and the
  gap-to-bundle-to-prompt flow described above.

## Requirements

- macOS (system memory reads use `top`/`sysctl`; Linux support is on the
  roadmap above)
- Node >= 20
- A running `ollama serve`, or a running `llama-server` in router mode, for
  both commands
