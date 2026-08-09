import type { Backend, RemoteCandidateOptions, RemoteDiscovery, RemoteSourceReport } from '../types.js';
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
  normalizeQuant,
  type OllamaTagsResponse,
  type OllamaPsResponse,
} from './client.js';
import { scrapeSearch, type RemoteModelCandidate } from './scrape.js';
import { searchGgufModels, type HfCandidate } from '../../hf/discovery.js';
import { hfCandidatesToModelInfo } from '../../hf/model-info.js';

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
      quantizationLevel: normalizeQuant(model.details.quantization_level),
      diskSizeBytes: model.size,
    });
  }

  return { models, skipped };
}

export function mapPsToLoaded(ps: OllamaPsResponse): LoadedModel[] {
  return ps.models.map((model) => ({
    name: model.name,
    sizeVramGb: model.size_vram / 1e9,
    quantizationLevel: normalizeQuant(model.details.quantization_level),
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
    discoverySource: 'ollama.com',
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

/** ollama.com's historical search default, applied when the user gave no query.
 * The HF source defaults to '' — bare trending, matching llama-server. */
const SCRAPE_DEFAULT_QUERY = 'mlx';

/** ollama pulls HF repos as `ollama pull hf.co/<owner>/<repo>[:<quant>]`; the
 * quant tag is the caller's pick from availableQuants. */
function hfPullName(c: HfCandidate): string {
  return `hf.co/${c.repoId}`;
}

async function remoteCandidates(
  query?: string,
  opts: RemoteCandidateOptions = {}
): Promise<RemoteDiscovery> {
  const scrapeQuery = query ?? SCRAPE_DEFAULT_QUERY;
  const hfQuery = query ?? '';
  // allSettled: the sources fail independently — one being down must not
  // blank the other's rows.
  const [scrapeResult, hfResult] = await Promise.allSettled([
    scrapeSearch(scrapeQuery),
    // The scrape can't size-filter server-side (oversized rows still get
    // informative "won't fit" verdicts); HF can, so only it takes the cap.
    searchGgufModels(hfQuery, { maxParameterSizeB: opts.maxParameterSizeB }),
  ]);

  const candidates: ModelInfo[] = [];
  const sources: RemoteSourceReport[] = [];

  if (scrapeResult.status === 'fulfilled') {
    candidates.push(...mapCandidates(scrapeResult.value));
    sources.push({ id: 'ollama.com', query: scrapeQuery, ok: true });
  } else {
    sources.push({
      id: 'ollama.com',
      query: scrapeQuery,
      ok: false,
      error: (scrapeResult.reason as Error).message,
    });
  }

  if (hfResult.status === 'fulfilled') {
    candidates.push(...hfCandidatesToModelInfo(hfResult.value, hfPullName));
    sources.push({ id: 'huggingface', query: hfQuery, ok: true });
  } else {
    sources.push({
      id: 'huggingface',
      query: hfQuery,
      ok: false,
      error: (hfResult.reason as Error).message,
    });
  }

  return { candidates, sources };
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
