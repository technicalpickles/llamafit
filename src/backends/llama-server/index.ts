import type { Detection, GenerateResult, LocalModels, ModelInfo } from '../../types.js';
import { searchGgufModels, type HfCandidate } from '../../hf/discovery.js';
import type { Backend, RemoteCandidateOptions } from '../types.js';
import type { LlamaServerCompletionResponse, LlamaServerModelsResponse } from './client.js';
import {
  LLAMA_SERVER_BASE_URL,
  completion,
  fetchModels,
  fetchProps,
  pullModel,
  unloadModel,
} from './client.js';

/** llama-server reports quantization as the human string from llama.cpp's
 * llama_ftype_name() (src/llama-model-loader.cpp). This maps each known string
 * to the canonical id form data/quants.json uses. Exact-string map rather than
 * a " - Medium"→"_M" parsing rule because the rendering isn't mechanical:
 * "Q2_K - Medium" is enum LLAMA_FTYPE_MOSTLY_Q2_K (no suffix) and
 * "IQ3_S mix - 3.66 bpw" is enum LLAMA_FTYPE_MOSTLY_IQ3_M. */
const FTYPE_TO_QUANT: Record<string, string> = {
  'all F32': 'F32',
  F16: 'F16',
  BF16: 'BF16',
  Q1_0: 'Q1_0',
  Q2_0: 'Q2_0',
  Q4_0: 'Q4_0',
  Q4_1: 'Q4_1',
  Q5_0: 'Q5_0',
  Q5_1: 'Q5_1',
  Q8_0: 'Q8_0',
  'MXFP4 MoE': 'MXFP4',
  NVFP4: 'NVFP4',
  'Q2_K - Medium': 'Q2_K',
  'Q2_K - Small': 'Q2_K_S',
  'Q3_K - Small': 'Q3_K_S',
  'Q3_K - Medium': 'Q3_K_M',
  'Q3_K - Large': 'Q3_K_L',
  'Q4_K - Small': 'Q4_K_S',
  'Q4_K - Medium': 'Q4_K_M',
  'Q5_K - Small': 'Q5_K_S',
  'Q5_K - Medium': 'Q5_K_M',
  Q6_K: 'Q6_K',
  'TQ1_0 - 1.69 bpw ternary': 'TQ1_0',
  'TQ2_0 - 2.06 bpw ternary': 'TQ2_0',
  'IQ2_XXS - 2.0625 bpw': 'IQ2_XXS',
  'IQ2_XS - 2.3125 bpw': 'IQ2_XS',
  'IQ2_S - 2.5 bpw': 'IQ2_S',
  'IQ2_M - 2.7 bpw': 'IQ2_M',
  'IQ3_XXS - 3.0625 bpw': 'IQ3_XXS',
  'IQ3_XS - 3.3 bpw': 'IQ3_XS',
  'IQ3_S - 3.4375 bpw': 'IQ3_S',
  'IQ3_S mix - 3.66 bpw': 'IQ3_M',
  'IQ1_S - 1.5625 bpw': 'IQ1_S',
  'IQ1_M - 1.75 bpw': 'IQ1_M',
  'IQ4_NL - 4.5 bpw': 'IQ4_NL',
  'IQ4_XS - 4.25 bpw': 'IQ4_XS',
};

const GUESSED_PREFIX = '(guessed) ';

/** Unknown strings pass through verbatim so lookupQuant (src/data.ts) flags
 * them as an unknown-quant gap instead of silently mis-normalizing. */
export function normalizeFtype(ftype: string): string {
  const stripped = ftype.startsWith(GUESSED_PREFIX) ? ftype.slice(GUESSED_PREFIX.length) : ftype;
  return FTYPE_TO_QUANT[stripped] ?? stripped;
}

/** Every model the router knows about is 'local' — an unloaded-but-known model
 * is still installed, just not resident. Size/quant fields come from `meta`,
 * which the API includes only for models loaded at least once this server
 * lifetime; without it they're null — a real, disclosed gap (the router
 * genuinely can't know an unloaded model's footprint without loading it). */
export function mapModelsToLocalModels(res: LlamaServerModelsResponse): LocalModels {
  const models: ModelInfo[] = res.data.map((model) => ({
    name: model.id,
    source: 'local',
    url: null,
    parameterSizeB: model.meta ? model.meta.n_params / 1e9 : null,
    quantizationLevel: model.meta ? normalizeFtype(model.meta.ftype) : null,
    diskSizeBytes: model.meta ? model.meta.size : null,
  }));
  return { models, skipped: [] };
}

export function mapCompletionToGenerate(res: LlamaServerCompletionResponse): GenerateResult {
  const { prompt_ms, predicted_ms, predicted_n } = res.timings;
  return {
    evalCount: predicted_n,
    evalDurationSeconds: predicted_ms / 1000,
    // Router-mode auto-load latency is absorbed into overall request latency,
    // not broken out anywhere in the response.
    loadDurationSeconds: null,
    totalDurationSeconds: (prompt_ms + predicted_ms) / 1000,
  };
}

async function detect(): Promise<Detection> {
  try {
    const res = await fetch(`${LLAMA_SERVER_BASE_URL}/health`);
    if (!res.ok) {
      return {
        detected: false,
        version: null,
        evidence: { baseUrl: LLAMA_SERVER_BASE_URL, error: `server returned ${res.status}` },
      };
    }
    // Bare GET /props (no ?model=) works in router mode; version is a
    // nice-to-have, not a gate — /health alone decides detection.
    let version: string | null = null;
    try {
      version = (await fetchProps()).build_info ?? null;
    } catch {
      version = null;
    }
    return { detected: true, version, evidence: { baseUrl: LLAMA_SERVER_BASE_URL } };
  } catch (err) {
    return {
      detected: false,
      version: null,
      evidence: { baseUrl: LLAMA_SERVER_BASE_URL, error: (err as Error).message },
    };
  }
}

async function localModels(): Promise<LocalModels> {
  return mapModelsToLocalModels(await fetchModels());
}

export function mapCandidatesToModelInfo(candidates: HfCandidate[]): ModelInfo[] {
  return candidates.map((c) => ({
    name: c.repoId,
    source: 'remote',
    url: c.url,
    parameterSizeB: c.parameterSizeB,
    // Repos ship many quants; no single quant describes the repo. The
    // estimator's fallback covers the estimate, availableQuants covers pulling.
    quantizationLevel: null,
    diskSizeBytes: null,
    author: c.author,
    availableQuants: c.availableQuants,
    signals: c.signals,
  }));
}

async function remoteCandidates(
  query = '',
  opts: RemoteCandidateOptions = {}
): Promise<ModelInfo[]> {
  return mapCandidatesToModelInfo(
    await searchGgufModels(query, { maxParameterSizeB: opts.maxParameterSizeB })
  );
}

async function generateResult(
  model: string,
  prompt: string,
  timeoutMs?: number
): Promise<GenerateResult | null> {
  const response = await completion(model, prompt, timeoutMs);
  if (response === null) return null;
  return mapCompletionToGenerate(response);
}

/** Router mode only. loadedModels() is deliberately absent: no llama-server
 * endpoint reports real per-model VRAM, and faking it from file size would
 * poison bench.ts's calibration provenance (see docs/adapters.md). */
export const llamaServerBackend: Backend = {
  id: 'llama-server',
  displayName: 'llama-server',
  detect,
  localModels,
  generate: generateResult,
  remoteCandidates,
  pull: pullModel,
  unload: unloadModel,
};
