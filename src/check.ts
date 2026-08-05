import type { Backend } from './backends/types.js';
import type { LoadedModel, ModelInfo } from './types.js';
import type { SystemProbe, SystemMemoryState } from './probes/types.js';
import type { Estimator, Verdict } from './estimators/types.js';
import { classifyVerdict } from './estimators/formula.js';
import type { GapCollector } from './gaps.js';
import { loadThresholds } from './data.js';

export interface CheckRow {
  name: string;
  source: 'local' | 'remote';
  /** Only set for remote rows — the ollama.com page for a model the user hasn't tried yet. */
  url: string | null;
  parameterSizeB: number | null;
  quantizationLevel: string | null;
  footprintGb: number | null;
  /** 'measured' means footprintGb is a real resident-size reading from the backend, not formula output. */
  estimateSource: 'measured' | 'estimated';
  /** False when the backend reported no quantization and we fell back to an assumed one. */
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
  backend: Backend;
  probe: SystemProbe;
  estimator: Estimator;
  /** Caller-owned, so the CLI can report gaps from every backend in one place. */
  gaps: GapCollector;
}

/** Platforms we have no measured reserve for still need a number; 8 GB is the macOS figure. */
const FALLBACK_BASELINE_RESERVE_GB = 8;

export async function runCheck(query: string, deps: CheckDeps): Promise<CheckResult> {
  const { backend, probe, estimator, gaps } = deps;

  const [{ models: localModels, skipped }, loaded] = await Promise.all([
    backend.localModels(),
    // No loadedModels capability means nothing to measure — every row is an estimate.
    backend.loadedModels?.() ?? Promise.resolve<LoadedModel[]>([]),
  ]);
  const cloudModels = skipped.map((s) => s.name);
  const running = new Map<string, LoadedModel>(loaded.map((m) => [m.name, m]));

  const system = await probe.read();
  const baselineReserveGb =
    loadThresholds().baselineReserveGb[probe.platform] ?? FALLBACK_BASELINE_RESERVE_GB;
  const baselineHeadroomGb = system.totalGb - baselineReserveGb;
  // Deliberate approximation: wired is the only genuinely non-reclaimable figure our
  // system-memory reader captures. Everything else (active, inactive, compressed, free)
  // is at least theoretically available to a big new allocation, at some performance
  // cost. macOS's `unused` sits near zero even when idle — using it directly would call
  // everything will-thrash. This is not exact "available" memory: `top`'s summary line
  // gives us no active/inactive/purgeable breakdown to do better.
  const currentHeadroomGb = system.totalGb - system.wiredGb;
  const headroom = { baselineHeadroomGb, currentHeadroomGb };

  let remoteCandidates: ModelInfo[] = [];
  let scrapeWarning: string | null = null;
  try {
    remoteCandidates = (await backend.remoteCandidates?.(query)) ?? [];
  } catch (err) {
    const message = (err as Error).message;
    scrapeWarning = `Could not fetch remote model list: ${message}`;
    gaps.add({
      kind: 'scrape-failed',
      summary: 'remote model search failed',
      evidence: { backend: backend.id, query, error: message },
    });
  }

  const localRows: CheckRow[] = localModels.map((model) => {
    // A currently-loaded model reports its real resident size. Prefer that over the
    // formula every time — no reason to estimate something the backend already measured.
    const measured = running.get(model.name);
    if (measured) {
      return {
        name: model.name,
        source: 'local',
        url: null,
        parameterSizeB: model.parameterSizeB,
        quantizationLevel: measured.quantizationLevel,
        footprintGb: measured.sizeVramGb,
        estimateSource: 'measured',
        quantKnown: true,
        baselineVerdict: classifyVerdict(measured.sizeVramGb, baselineHeadroomGb),
        currentVerdict: classifyVerdict(measured.sizeVramGb, currentHeadroomGb),
      };
    }

    if (model.parameterSizeB === null) {
      // Without a parameter count there is nothing to estimate, so the quantization
      // (known or not) is never consulted — no gap to report, just an unknown row.
      return {
        name: model.name,
        source: 'local',
        url: null,
        parameterSizeB: null,
        quantizationLevel: model.quantizationLevel,
        footprintGb: null,
        estimateSource: 'estimated',
        quantKnown: false,
        baselineVerdict: 'unknown',
        currentVerdict: 'unknown',
      };
    }

    const estimate = estimator.estimate(
      { parameterSizeB: model.parameterSizeB, quantizationLevel: model.quantizationLevel },
      headroom
    );
    // The backend named a quantization the estimator does not know: the number we print
    // rests on a fallback, and that is exactly the kind of thing the gap report exists for.
    if (model.quantizationLevel && !estimate.quantKnown) {
      gaps.add({
        kind: 'unknown-quant',
        summary: `unknown quantization "${model.quantizationLevel}"`,
        evidence: { model: model.name, quantizationLevel: model.quantizationLevel },
      });
    }
    return {
      name: model.name,
      source: 'local',
      url: null,
      parameterSizeB: model.parameterSizeB,
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
      // Remote candidates never carry a quantization — the fallback is expected here,
      // so it is reported per-row via quantKnown rather than as a gap.
      const estimate = estimator.estimate(
        { parameterSizeB: c.parameterSizeB, quantizationLevel: c.quantizationLevel },
        headroom
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
