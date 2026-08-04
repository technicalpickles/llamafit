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

Or install it as a command on your `PATH`:

```bash
npm link           # from this directory, for local development
# or: npm install -g .
ollama-scope check
ollama-scope bench gemma3:12b
```

You can also run it without installing:

```bash
npx ollama-scope check
```

Point at a non-default server with `OLLAMA_HOST`, either as `host:port` or a
full URL:

```bash
OLLAMA_HOST=192.168.1.50:11434 ollama-scope check
OLLAMA_HOST=http://192.168.1.50:11434 ollama-scope check
```

## Reading the check table

A model that's currently loaded (visible in Ollama's `/api/ps`) reports its
real resident size, so its footprint prints bare. Everything else is a formula
estimate and gets a `~`. A `?` after the quantization means Ollama didn't
report one and the estimate assumed `Q4_K_M`, so treat that row as a rough
guess rather than a number.

### About "current headroom"

Current headroom is computed as **total memory minus wired memory**, and it's a
deliberate approximation. Wired pages are the only thing here the kernel truly
can't reclaim: it can't page them out or compress them. Everything else
(active, inactive, compressed, free) is at least theoretically available to a
large new allocation, at some performance cost.

What it is not is an exact "available memory" figure. macOS's own `unused`
number is useless for this, it sits near zero almost constantly (a 24GB machine
sitting idle can report 145M unused) because macOS deliberately spends free RAM
on the compressor and file cache. Using it directly would flag every model as
will-thrash, including ones that load and run fine.

The limitation: the system memory reader parses `top`'s summary line, which has
no active/inactive/purgeable breakdown. That breakdown (from `vm_stat`) is what
you'd need for a genuinely precise number, so treat current headroom as an
optimistic upper bound and the baseline verdict as the conservative one.

## Design

See [`docs/superpowers/specs/2026-08-04-ollama-scope-cli-design.md`](docs/superpowers/specs/2026-08-04-ollama-scope-cli-design.md)
for the memory estimation model, verdict thresholds, and the reasoning
behind them (grounded in real measurements, not just spec-sheet math).

## Requirements

- macOS (system memory reads use `top`/`sysctl`, not portable yet)
- Node >= 20
- A running `ollama serve` for both commands
