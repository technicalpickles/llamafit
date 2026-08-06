# llmfit

Checks whether local LLMs actually fit this machine, not just whether they
technically load. A model can "fit" by Ollama's own bookkeeping and still
push the whole system into heavy swap, because VRAM-footprint reporting like
`/api/ps` has no signal about the rest of the machine's memory pressure.
`llmfit` answers two questions:

- **`llmfit check`** — static analysis, no models are loaded. Reads
  locally-pulled models plus a live scrape of `ollama.com/search`, estimates
  memory footprint from parameter count and quantization, and classifies
  each as comfortable / tight / will-thrash against both a fixed baseline
  reserve and whatever's actually free right now.
- **`llmfit bench <model>`** — live benchmark. Pulls (if needed), loads,
  runs a fixed prompt, and reports real VRAM usage, tokens/sec, and the
  before/after system memory and swap delta.

Backends and platforms sit behind small interfaces, so `llmfit` isn't
permanently tied to Ollama or macOS, that's just where it started. When it
hits something it doesn't support yet, it doesn't just fail quietly: see
["When llmfit doesn't support your setup"](#when-llmfit-doesnt-support-your-setup)
below.

## Usage

```bash
npx llmfit check
npx llmfit check --json
npx llmfit check --query gemma
npx llmfit bench gemma3:12b
```

Or install it locally:

```bash
npm install -g llmfit
llmfit check
llmfit bench gemma3:12b
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

Point at a non-default server with `OLLAMA_HOST`, either as `host:port` or a
full URL:

```bash
OLLAMA_HOST=192.168.1.50:11434 llmfit check
OLLAMA_HOST=http://192.168.1.50:11434 llmfit check
```

## Reading the check table

A model that's currently loaded (visible in Ollama's `/api/ps`) reports its
real resident size, so its footprint prints bare. Everything else is a formula
estimate and gets a `~`. A `?` after the quantization means the backend didn't
report one and the estimate assumed `Q4_K_M`, so treat that row as a rough
guess rather than a number.

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

## When llmfit doesn't support your setup

`llmfit` is built on a few small interfaces: a backend that talks to an
inference server, a system probe that reads memory, an estimator that turns
model metadata into a verdict. Some failures mean one of those genuinely
doesn't cover your setup yet: an unrecognized quantization string, a
platform with no `SystemProbe`, or no backend it can detect at all. When
that happens, `llmfit` writes a diagnostics bundle
(`llmfit-diagnostics-<timestamp>.json`) with the raw evidence it collected,
prints a ready-to-paste prompt for handing to an AI coding agent, and
prints a pre-filled GitHub issue link for handing to a human instead.

A flaky `ollama.com` scrape isn't one of those, it's just a warning on
stderr, and the run finishes normally. That kind of transient failure only
shows up in a bundle if you ask for one with `--diagnose`.

If you're the one closing a gap, by hand or with an agent, start at
[`docs/adapters.md`](docs/adapters.md). It's the contribution guide for
implementing a new `Backend`, `SystemProbe`, or data-layer entry, written to
be handed straight to an agent along with the bundle.

## Supported today / roadmap

- **Today**: Ollama (backend), macOS (platform).
- **Next**, each its own phase: `linux-probe` (a Linux `SystemProbe`),
  `llama-server-backend` (llama.cpp's `llama-server`), `unsloth-backend`
  (Unsloth Studio's OpenAI-compatible API).

## Design

- [`docs/superpowers/specs/2026-08-04-ollama-scope-cli-design.md`](docs/superpowers/specs/2026-08-04-ollama-scope-cli-design.md)
  — the original memory estimation model, verdict thresholds, and the
  reasoning behind them, grounded in real measurements rather than
  spec-sheet math.
- [`docs/superpowers/specs/2026-08-05-llmfit-generalization-design.md`](docs/superpowers/specs/2026-08-05-llmfit-generalization-design.md)
  — the backend/probe/estimator interfaces, the data layer, and the
  gap-to-bundle-to-prompt flow described above.

## Requirements

- macOS (system memory reads use `top`/`sysctl`; Linux support is on the
  roadmap above)
- Node >= 20
- A running `ollama serve` for both commands
