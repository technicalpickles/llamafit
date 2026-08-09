import type { Backend } from './backends/types.js';
import type { SystemProbe, SystemMemoryState } from './probes/types.js';
import type { GenerateResult } from './types.js';

const BENCH_PROMPT = 'Write a 150 word short story about a robot learning to paint.';
export const GENERATE_TIMEOUT_MS = 90_000;

/** Ollama normalizes an untagged name to `:latest` in its own API responses, so
 * matching what the user typed against those responses needs the same normalization.
 * Only the *matching* is normalized: pull/generate/unload still get the raw input,
 * which the backend resolves itself. */
export function normalizeModelTarget(model: string): string {
  return model.includes(':') ? model : `${model}:latest`;
}

/** Whether a locally-reported model name refers to the same model the user asked to
 * bench. Ollama reports untagged pulls back with `:latest` appended, so the normalized
 * form has to match too — but a backend like llama-server's router mode reports its own
 * untagged ids verbatim and never appends `:latest`, so the raw name has to match as
 * well. Accepting either keeps this working for both without assuming one backend's
 * naming convention. */
export function matchesModelTarget(localName: string, model: string): boolean {
  return localName === model || localName === normalizeModelTarget(model);
}

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

export interface BenchDeps {
  backend: Backend;
  probe: SystemProbe;
}

export async function runBench(model: string, deps: BenchDeps): Promise<BenchResult> {
  const { backend, probe } = deps;
  const notes: string[] = [];

  const { models: local } = await backend.localModels();
  const alreadyPulled = local.some((m) => matchesModelTarget(m.name, model));
  // The id used for every call after this point. Ollama's API resolves a bare name
  // itself, so an already-present model keeps the raw request (Ollama's pull() never
  // returns a resolved id). llama-server has no such resolution and can register a
  // pull under a different id than requested (e.g. auto-picking a quant for a bare
  // multi-quant HF repo) — when pull() reports that id back, generate/unload must use
  // it or they 400 against an id nothing is actually registered under.
  let resolvedModel = model;
  if (!alreadyPulled) {
    if (!backend.pull) {
      throw new Error(
        `${backend.displayName} can't pull models — pull '${model}' yourself, then re-run`
      );
    }
    resolvedModel = (await backend.pull(model)) || model;
  }

  if (!backend.loadedModels) {
    notes.push(
      `${backend.displayName} can't report per-model VRAM; footprint shown is the system-memory delta only`
    );
  }
  if (!backend.unload) {
    notes.push(`${backend.displayName} can't unload models — '${resolvedModel}' is still loaded`);
  }

  const memoryBefore = await probe.read();

  // Once generate() has been called, the model may be resident in VRAM — everything
  // from here through reading its post-run state must unload it on the way out (when
  // the backend can), even if generate() itself throws or loadedModels()/probe.read()
  // throw afterward. Otherwise a failure here leaves the model loaded, silently
  // contaminating the next benchmark's memory readings.
  let response: GenerateResult | null;
  let sizeVramGb: number | null = null;
  let memoryAfter: SystemMemoryState;
  try {
    response = await backend.generate(resolvedModel, BENCH_PROMPT, GENERATE_TIMEOUT_MS);
    if (backend.loadedModels) {
      const loaded = await backend.loadedModels();
      const running = loaded.find((m) => matchesModelTarget(m.name, resolvedModel));
      sizeVramGb = running ? running.sizeVramGb : null;
    }
    memoryAfter = await probe.read();
  } finally {
    // A failed unload (e.g. llama-server 400s when the model isn't actually loaded,
    // such as after a timed-out generate) must not replace whatever this try block was
    // about to return/throw — that would turn a legitimate result or error into a
    // confusing unload failure instead. Note it and move on.
    if (backend.unload) {
      try {
        await backend.unload(resolvedModel);
      } catch (err) {
        notes.push(`${backend.displayName} failed to unload '${resolvedModel}': ${(err as Error).message}`);
      }
    }
  }

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
      notes,
    };
  }

  const evalTokensPerSecond =
    response.evalCount && response.evalDurationSeconds
      ? response.evalCount / response.evalDurationSeconds
      : null;

  return {
    model,
    status: 'completed',
    sizeVramGb,
    evalTokensPerSecond,
    loadDurationSeconds: response.loadDurationSeconds,
    totalDurationSeconds: response.totalDurationSeconds,
    memoryBefore,
    memoryAfter,
    notes,
  };
}
