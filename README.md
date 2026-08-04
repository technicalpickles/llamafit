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
