import {
  fetchTags as realFetchTags,
  fetchPs as realFetchPs,
  generate as realGenerate,
  unloadModel as realUnloadModel,
  pullModel as realPullModel,
  type OllamaTagsResponse,
  type OllamaPsResponse,
  type OllamaPsModel,
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
  // Ollama normalizes an untagged name to `:latest` in its own API responses, so
  // matching what the user typed against those responses needs the same normalization.
  // Only the *matching* is normalized: pull/generate/unload still get the raw input,
  // which Ollama resolves itself.
  const target = model.includes(':') ? model : `${model}:latest`;

  const tags = await deps.fetchTags();
  const alreadyPulled = tags.models.some((m) => m.name === target || m.model === target);
  if (!alreadyPulled) {
    await deps.pullModel(model);
  }

  const memoryBefore = deps.readSystemMemory();

  // Once generate() has been called, the model may be resident in VRAM — everything
  // from here through reading its post-run state must unload it on the way out, even
  // if generate() itself throws or fetchPs()/readSystemMemory() throw afterward.
  // Otherwise a failure here leaves the model loaded, silently contaminating the next
  // benchmark's memory readings.
  let response: OllamaGenerateResponse | null;
  let running: OllamaPsModel | undefined;
  let memoryAfter: SystemMemoryState;
  try {
    response = await deps.generate(model, BENCH_PROMPT, GENERATE_TIMEOUT_MS);
    const ps = await deps.fetchPs();
    running = ps.models.find((m) => m.name === target || m.model === target);
    memoryAfter = deps.readSystemMemory();
  } finally {
    await deps.unloadModel(model);
  }

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
    loadDurationSeconds: response.load_duration != null ? response.load_duration / 1e9 : null,
    totalDurationSeconds: response.total_duration != null ? response.total_duration / 1e9 : null,
    memoryBefore,
    memoryAfter,
  };
}
