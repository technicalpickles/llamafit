import type { Backend } from '../types.js';
import type {
  Detection,
  GenerateResult,
  LoadedModel,
  LocalModels,
  ModelInfo,
} from '../../types.js';
import {
  OLLAMA_BASE_URL,
  fetchTags,
  fetchPs,
  generate,
  pullModel,
  unloadModel,
  isCloudModel,
  parseParameterSize,
  type OllamaTagsResponse,
  type OllamaPsResponse,
} from './client.js';
import { scrapeSearch, type RemoteModelCandidate } from './scrape.js';

export function mapTagsToLocalModels(tags: OllamaTagsResponse): LocalModels {
  const models: ModelInfo[] = [];
  const skipped: LocalModels['skipped'] = [];

  for (const model of tags.models) {
    if (isCloudModel(model)) {
      skipped.push({
        name: model.name,
        reason: 'cloud model (runs remotely, not sized against this machine)',
      });
      continue;
    }
    models.push({
      name: model.name,
      source: 'local',
      url: null,
      parameterSizeB: parseParameterSize(model.details.parameter_size),
      quantizationLevel: model.details.quantization_level || null,
      diskSizeBytes: model.size,
    });
  }

  return { models, skipped };
}

export function mapPsToLoaded(ps: OllamaPsResponse): LoadedModel[] {
  return ps.models.map((model) => ({
    name: model.name,
    sizeVramGb: model.size_vram / 1e9,
    quantizationLevel: model.details.quantization_level || null,
  }));
}

export function mapCandidates(candidates: RemoteModelCandidate[]): ModelInfo[] {
  return candidates.map((candidate) => ({
    name: candidate.name,
    source: 'remote',
    url: candidate.url,
    parameterSizeB: candidate.parameterSizeB,
    quantizationLevel: null,
    diskSizeBytes: null,
  }));
}

async function detect(): Promise<Detection> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/version`);
    if (!res.ok) {
      return {
        detected: false,
        version: null,
        evidence: { baseUrl: OLLAMA_BASE_URL, error: `server returned ${res.status}` },
      };
    }
    const body = (await res.json()) as { version?: string };
    return {
      detected: true,
      version: body.version ?? null,
      evidence: { baseUrl: OLLAMA_BASE_URL },
    };
  } catch (err) {
    return {
      detected: false,
      version: null,
      evidence: { baseUrl: OLLAMA_BASE_URL, error: (err as Error).message },
    };
  }
}

async function localModels(): Promise<LocalModels> {
  const tags = await fetchTags();
  return mapTagsToLocalModels(tags);
}

async function remoteCandidates(query = ''): Promise<ModelInfo[]> {
  const candidates = await scrapeSearch(query);
  return mapCandidates(candidates);
}

async function loadedModels(): Promise<LoadedModel[]> {
  const ps = await fetchPs();
  return mapPsToLoaded(ps);
}

async function generateResult(
  model: string,
  prompt: string,
  timeoutMs?: number
): Promise<GenerateResult | null> {
  const response = await generate(model, prompt, timeoutMs);
  if (response === null) return null;
  return {
    evalCount: response.eval_count ?? null,
    evalDurationSeconds: response.eval_duration !== undefined ? response.eval_duration / 1e9 : null,
    loadDurationSeconds: response.load_duration !== undefined ? response.load_duration / 1e9 : null,
    totalDurationSeconds:
      response.total_duration !== undefined ? response.total_duration / 1e9 : null,
  };
}

export const ollamaBackend: Backend = {
  id: 'ollama',
  displayName: 'Ollama',
  detect,
  localModels,
  generate: generateResult,
  remoteCandidates,
  loadedModels,
  pull: pullModel,
  unload: unloadModel,
};
