import {
  fetchTags as realFetchTags,
  fetchPs as realFetchPs,
  isCloudModel,
  parseParameterSize,
  type OllamaTagsResponse,
  type OllamaPsResponse,
  type OllamaPsModel,
} from './backends/ollama/client.js';
import { selectProbe } from './probes/registry.js';
import type { SystemMemoryState } from './probes/types.js';
import { formulaEstimator, classifyVerdict } from './estimators/formula.js';
import type { Verdict } from './estimators/types.js';
import { loadThresholds } from './data.js';
import { scrapeSearch as realScrapeSearch, type RemoteModelCandidate } from './backends/ollama/scrape.js';

export interface CheckRow {
  name: string;
  source: 'local' | 'remote';
  /** Only set for remote rows — the ollama.com page for a model the user hasn't tried yet. */
  url: string | null;
  parameterSizeB: number | null;
  quantizationLevel: string | null;
  footprintGb: number | null;
  /** 'measured' means footprintGb is a real size_vram reading from /api/ps, not formula output. */
  estimateSource: 'measured' | 'estimated';
  /** False when Ollama reported no quantization and we fell back to an assumed one. */
  quantKnown: boolean;
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
  fetchPs: () => Promise<OllamaPsResponse>;
  readSystemMemory: () => Promise<SystemMemoryState>;
  scrapeSearch: (query: string) => Promise<RemoteModelCandidate[]>;
}

const defaultDeps: CheckDeps = {
  fetchTags: realFetchTags,
  fetchPs: realFetchPs,
  readSystemMemory: () => selectProbe(process.platform)!.read(),
  scrapeSearch: realScrapeSearch,
};

export async function runCheck(query = 'mlx', deps: CheckDeps = defaultDeps): Promise<CheckResult> {
  const [tags, ps] = await Promise.all([deps.fetchTags(), deps.fetchPs()]);
  const localModels = tags.models.filter((m) => !isCloudModel(m));
  const cloudModels = tags.models.filter(isCloudModel).map((m) => m.name);
  const running = new Map<string, OllamaPsModel>(ps.models.map((m) => [m.name, m]));

  const system = await deps.readSystemMemory();
  const baselineHeadroomGb = system.totalGb - loadThresholds().baselineReserveGb['darwin'];
  // Deliberate approximation: wired is the only genuinely non-reclaimable figure our
  // system-memory reader captures. Everything else (active, inactive, compressed, free)
  // is at least theoretically available to a big new allocation, at some performance
  // cost. macOS's `unused` sits near zero even when idle — using it directly would call
  // everything will-thrash. This is not exact "available" memory: `top`'s summary line
  // gives us no active/inactive/purgeable breakdown to do better.
  const currentHeadroomGb = system.totalGb - system.wiredGb;

  let remoteCandidates: RemoteModelCandidate[] = [];
  let scrapeWarning: string | null = null;
  try {
    remoteCandidates = await deps.scrapeSearch(query);
  } catch (err) {
    scrapeWarning = `Could not fetch remote model list: ${(err as Error).message}`;
  }

  const localRows: CheckRow[] = localModels.map((m) => {
    const paramB = parseParameterSize(m.details.parameter_size);

    // A currently-loaded model reports its real resident size. Prefer that over the
    // formula every time — no reason to estimate something Ollama already measured.
    const loaded = running.get(m.name);
    if (loaded) {
      const measuredGb = loaded.size_vram / 1e9;
      return {
        name: m.name,
        source: 'local',
        url: null,
        parameterSizeB: paramB,
        quantizationLevel: loaded.details.quantization_level || null,
        footprintGb: measuredGb,
        estimateSource: 'measured',
        quantKnown: true,
        baselineVerdict: classifyVerdict(measuredGb, baselineHeadroomGb),
        currentVerdict: classifyVerdict(measuredGb, currentHeadroomGb),
      };
    }

    if (paramB === null) {
      return {
        name: m.name,
        source: 'local',
        url: null,
        parameterSizeB: null,
        quantizationLevel: m.details.quantization_level || null,
        footprintGb: null,
        estimateSource: 'estimated',
        quantKnown: false,
        baselineVerdict: 'unknown',
        currentVerdict: 'unknown',
      };
    }
    const estimate = formulaEstimator.estimate(
      { parameterSizeB: paramB, quantizationLevel: m.details.quantization_level },
      { baselineHeadroomGb, currentHeadroomGb }
    );
    return {
      name: m.name,
      source: 'local',
      url: null,
      parameterSizeB: paramB,
      quantizationLevel: estimate.quantUsedForEstimate,
      footprintGb: estimate.footprintGb,
      estimateSource: 'estimated',
      quantKnown: estimate.quantKnown,
      baselineVerdict: estimate.baselineVerdict,
      currentVerdict: estimate.currentVerdict,
    };
  });

  const remoteRows: CheckRow[] = remoteCandidates
    .filter((c) => c.parameterSizeB !== null)
    .map((c) => {
      const estimate = formulaEstimator.estimate(
        { parameterSizeB: c.parameterSizeB, quantizationLevel: '' },
        { baselineHeadroomGb, currentHeadroomGb }
      );
      return {
        name: c.name,
        source: 'remote',
        url: c.url,
        parameterSizeB: c.parameterSizeB,
        quantizationLevel: estimate.quantUsedForEstimate,
        footprintGb: estimate.footprintGb,
        // Remote candidates aren't even pulled, so there is nothing to measure.
        estimateSource: 'estimated',
        quantKnown: estimate.quantKnown,
        baselineVerdict: estimate.baselineVerdict,
        currentVerdict: estimate.currentVerdict,
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
