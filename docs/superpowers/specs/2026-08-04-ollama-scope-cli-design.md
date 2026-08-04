# ollama-scope CLI — Design

## Purpose

A CLI that helps decide which Ollama models are right-sized for the current
machine (initially: this MacBook Air, M5, 24GB unified memory, macOS). It
answers two related questions:

1. Statically, without running anything: given what's known about a model
   (parameter count, quantization) and the machine's current memory state,
   would it fit comfortably, be tight, or thrash the system into swap?
2. Empirically: for a specific model, what actually happens when you load it
   and generate, measured the same way we did by hand this session (before/
   after memory, `size_vram`, tokens/sec)?

This grew out of manual exploration of the local Ollama HTTP API
(`/api/tags`, `/api/show`, `/api/ps`, `/api/pull`, `/api/generate`) plus
macOS memory tools (`top`, `vm_stat`, `sysctl vm.swapusage`). Key findings
from that exploration that motivate this design:

- Ollama's own `/api/ps` reports `size_vram` that "fits" in unified memory
  with no signal about what else is running — a model can technically fit
  and still thrash the whole system into swap if other apps already hold
  most of the RAM.
- Real-world overhead over raw quantized weight size was consistently
  ~17-28% (KV cache + runtime overhead) across three models measured today.
- There is no local API or CLI command to browse Ollama's remote model
  library (`ollama search` doesn't exist) — the only way to discover remote
  models is scraping `ollama.com/search`, which is inherently fragile.
- Models tagged "mlx" in the community registry are not reliably running on
  an actual MLX backend; `/api/show` still reports `format: gguf` for such
  models, and Ollama's official MLX support today is limited to specific
  models (e.g. `Qwen3.5-35B-A3B`) requiring >32GB unified memory, out of
  reach for this machine regardless.

## Non-goals

- Not a general Ollama management tool (pulling/deleting/running models
  generically) — only what's needed to answer the sizing question.
- Not trying to precisely model KV cache from full architecture details
  (attention heads, layer count, etc.) — a calibrated flat overhead
  multiplier is good enough and far simpler than exact math, per the
  measurements taken this session.
- Not cross-platform initially — memory reads use macOS-specific tools
  (`top`, `sysctl vm.swapusage`). Linux/Windows support is out of scope
  unless it comes up later.
- No calibration step — the macOS baseline reserve is a fixed constant, not
  something the tool learns from the user's machine.

## Commands

### `ollama-scope check`

Static analysis pass, no models are loaded or pulled.

1. Read `/api/tags` from the local Ollama server (`http://localhost:11434`)
   for already-pulled models.
2. Scrape `ollama.com/search` for remote model candidates (best-effort — see
   Error Handling below).
3. Read live system memory/swap state via `top -l 1 -s 0` and
   `sysctl vm.swapusage`.
4. For each model (local or remote), compute an estimated memory footprint
   (see Memory Estimation Model) and classify it against two headroom
   figures:
   - **Baseline headroom**: total unified memory − fixed macOS reserve
     (8GB, a hardcoded constant in v1 — not a CLI flag or config file; if it
     turns out wrong for this machine, it's a one-line code change).
   - **Current headroom**: total unified memory − actual live usage right
     now.
5. Print a table: model name, parameter size, quantization, estimated
   footprint, verdict under baseline, verdict under current load. `--json`
   emits the same data as structured JSON instead of a table.

For any locally-pulled model that's currently loaded (visible in
`/api/ps`), use its real `size_vram` instead of the formula estimate, and
mark that row as "measured" rather than "estimated."

### `ollama-scope bench <model>`

Live benchmarking for one specific model, mirrors the manual workflow used
throughout this session.

1. Record system memory state (before).
2. `ollama pull <model>` if not already present.
3. Run a fixed benchmark prompt via `/api/generate` (non-streaming), timing
   the request.
4. Read `/api/ps` immediately after for real `size_vram`.
5. Record system memory state (after).
6. Unload the model (`keep_alive: 0`) to leave the system as it found it.
7. Print: load duration, eval duration, tokens/sec, `size_vram`, and the
   memory/swap delta between before and after.

`bench` always prints a plain-language verdict too ("completed normally" /
"completed but induced heavy swap" / "timed out — did not complete"), since
that distinction (gemma3:27b never even finished) matters more than raw
numbers.

## Memory Estimation Model

```
weights_gb = parameter_size_B × bytes_per_param(quantization_level)
estimated_footprint_gb = weights_gb × OVERHEAD_MULTIPLIER
```

`bytes_per_param` lookup, keyed off Ollama's `quantization_level` string:

| Quant | Bytes/param |
|---|---|
| F32 | 4.0 |
| F16 / BF16 | 2.0 |
| Q8_0 | 1.0 |
| Q6_K | 0.75 |
| Q5_K_M | 0.69 |
| Q4_K_M | 0.5625 |
| Q4_0 | 0.5 |
| Q3_K_M | 0.44 |
| Q2_K | 0.35 |
| unknown quant string | fall back to Q4_K_M's value; output flags the row as a rough estimate |

`OVERHEAD_MULTIPLIER` default **1.25**, a single named constant, calibrated
from this session's measurements:

| Model | Predicted weights | Actual size_vram | Overhead |
|---|---|---|---|
| llama3.2:3b (Q4_K_M) | 1.8GB | 2.3GB | 1.28× |
| gemma3:12b (Q4_K_M) | 6.75GB | 8.6GB | 1.27× |
| gemma-4-12b-mlx:4bit (Q4_K_M) | 6.69GB | 7.8GB | 1.17× |

This covers KV cache at Ollama's default context window plus general
runtime overhead. It is deliberately not a precise KV-cache formula (which
would require per-model architecture details like layer count and KV head
count) — the calibrated flat multiplier matches observed reality closely
enough for a sizing tool, and is a single tunable number instead of a
complex, hard-to-verify calculation.

**Verdict thresholds**, applied against a given headroom figure:

- `comfortable`: footprint ≤ 70% of headroom
- `tight`: footprint is 70–95% of headroom
- `will thrash`: footprint > 95% of headroom, or exceeds it outright

## Error Handling

- **Remote scraping failure** (network error, unexpected HTML structure):
  `check` prints a warning to stderr and continues with local-only results.
  Never a hard failure — the local half of the report is still useful on
  its own.
- **Ollama server unreachable** (`/api/tags` fails to connect): both
  commands fail fast with a clear message ("is `ollama serve` running?").
  There's no meaningful degraded mode without the local server.
- **`bench` timeout**: if a generate request doesn't complete within a
  bounded wait, report it as "timed out" (not as an error/crash) — this is
  itself a meaningful result, per the gemma3:27b test.
- **Unknown quantization string**: estimate using the Q4_K_M multiplier as
  a reasonable middle-ground default, and flag the row rather than silently
  presenting a false-precision number.

## Testing

- Memory estimation formula: unit tests against fixture JSON, using this
  session's three real measurements as golden test cases (predicted value
  within the actual measured range).
- `/api/tags` / `/api/ps` / `/api/show` parsing: unit tests against
  captured fixture responses (from this session's actual API output).
- Scraping and live system-memory reads: thin adapter modules so they're
  mockable in tests; no test depends on network access or the actual local
  `top`/`sysctl` output.
- No end-to-end test against a real Ollama server or real `ollama.com` — too
  slow and non-deterministic for routine test runs; `bench` is inherently a
  manual/interactive tool to run against the real thing.

## Tech Stack

- TypeScript on Node.
- Built-in `fetch` for both the local Ollama API and scraping
  `ollama.com/search`.
- `cheerio` for HTML parsing of scrape results.
- `commander` for CLI argument parsing.
- System memory reads shell out to `top -l 1 -s 0` and
  `sysctl vm.swapusage`, parsed with regex — macOS-only, which matches the
  target platform.
