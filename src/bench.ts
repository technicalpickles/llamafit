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
  const target = normalizeModelTarget(model);
  const notes: string[] = [];

  const { models: local } = await backend.localModels();
  const alreadyPulled = local.some((m) => m.name === target);
  if (!alreadyPulled) {
    if (!backend.pull) {
      throw new Error(
        `${backend.displayName} can't pull models — pull '${model}' yourself, then re-run`
      );
    }
    await backend.pull(model);
  }

  if (!backend.loadedModels) {
    notes.push(
      `${backend.displayName} can't report per-model VRAM; footprint shown is the system-memory delta only`
    );
  }
  if (!backend.unload) {
    notes.push(`${backend.displayName} can't unload models — '${model}' is still loaded`);
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
    response = await backend.generate(model, BENCH_PROMPT, GENERATE_TIMEOUT_MS);
    if (backend.loadedModels) {
      const loaded = await backend.loadedModels();
      const running = loaded.find((m) => m.name === target);
      sizeVramGb = running ? running.sizeVramGb : null;
    }
    memoryAfter = await probe.read();
  } finally {
    if (backend.unload) {
      await backend.unload(model);
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
