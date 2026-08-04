import {
  fetchTags as realFetchTags,
  isCloudModel,
  parseParameterSize,
  type OllamaTagsResponse,
} from './ollama-client.js';
import { readSystemMemory as realReadSystemMemory, type SystemMemoryState } from './system-memory.js';
import { estimateFootprint, classifyVerdict, type Verdict, MACOS_BASELINE_RESERVE_GB } from './estimate.js';
import { scrapeSearch as realScrapeSearch, type RemoteModelCandidate } from './scrape.js';

export interface CheckRow {
  name: string;
  source: 'local' | 'remote';
  parameterSizeB: number | null;
  quantizationLevel: string | null;
  footprintGb: number | null;
  baselineVerdict: Verdict | 'unknown';
  currentVerdict: Verdict | 'unknown';
}

export interface CheckResult {
  rows: CheckRow[];
  cloudModels: string[];
  system: SystemMemoryState;
  baselineHeadroomGb: number;
  currentHeadroomGb: number;
  scrapeWarning: string | null;
}

export interface CheckDeps {
  fetchTags: () => Promise<OllamaTagsResponse>;
  readSystemMemory: () => SystemMemoryState;
  scrapeSearch: (query: string) => Promise<RemoteModelCandidate[]>;
}

const defaultDeps: CheckDeps = {
  fetchTags: realFetchTags,
  readSystemMemory: realReadSystemMemory,
  scrapeSearch: realScrapeSearch,
};

export async function runCheck(query = 'mlx', deps: CheckDeps = defaultDeps): Promise<CheckResult> {
  const tags = await deps.fetchTags();
  const localModels = tags.models.filter((m) => !isCloudModel(m));
  const cloudModels = tags.models.filter(isCloudModel).map((m) => m.name);

  const system = deps.readSystemMemory();
  const baselineHeadroomGb = system.totalGb - MACOS_BASELINE_RESERVE_GB;
  const currentHeadroomGb = system.unusedGb;

  let remoteCandidates: RemoteModelCandidate[] = [];
  let scrapeWarning: string | null = null;
  try {
    remoteCandidates = await deps.scrapeSearch(query);
  } catch (err) {
    scrapeWarning = `Could not fetch remote model list: ${(err as Error).message}`;
  }

  const localRows: CheckRow[] = localModels.map((m) => {
    const paramB = parseParameterSize(m.details.parameter_size);
    if (paramB === null) {
      return {
        name: m.name,
        source: 'local',
        parameterSizeB: null,
        quantizationLevel: m.details.quantization_level || null,
        footprintGb: null,
        baselineVerdict: 'unknown',
        currentVerdict: 'unknown',
      };
    }
    const estimate = estimateFootprint(paramB, m.details.quantization_level);
    return {
      name: m.name,
      source: 'local',
      parameterSizeB: paramB,
      quantizationLevel: estimate.quantUsedForEstimate,
      footprintGb: estimate.estimatedFootprintGb,
      baselineVerdict: classifyVerdict(estimate.estimatedFootprintGb, baselineHeadroomGb),
      currentVerdict: classifyVerdict(estimate.estimatedFootprintGb, currentHeadroomGb),
    };
  });

  const remoteRows: CheckRow[] = remoteCandidates
    .filter((c) => c.parameterSizeB !== null)
    .map((c) => {
      const estimate = estimateFootprint(c.parameterSizeB as number, '');
      return {
        name: c.name,
        source: 'remote',
        parameterSizeB: c.parameterSizeB,
        quantizationLevel: estimate.quantUsedForEstimate,
        footprintGb: estimate.estimatedFootprintGb,
        baselineVerdict: classifyVerdict(estimate.estimatedFootprintGb, baselineHeadroomGb),
        currentVerdict: classifyVerdict(estimate.estimatedFootprintGb, currentHeadroomGb),
      };
    });

  return {
    rows: [...localRows, ...remoteRows],
    cloudModels,
    system,
    baselineHeadroomGb,
    currentHeadroomGb,
    scrapeWarning,
  };
}
