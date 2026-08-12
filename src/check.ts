import { isFailedSource } from './backends/types.js';
import type { Backend, RemoteSourceReport } from './backends/types.js';
import type { LoadedModel, ModelInfo, RemoteSignals } from './types.js';
import type { SystemProbe, SystemMemoryState } from './probes/types.js';
import type { Estimator, Verdict } from './estimators/types.js';
import { classifyVerdict, maxCandidateParamsB } from './estimators/formula.js';
import type { GapCollector } from './gaps.js';
import { loadThresholds } from './data.js';
import { REMOTE_GUIDANCE } from './hf/guidance.js';
import { splitModelTag } from './model-names.js';

/** Same tag rule as quantFromTag, via the same helper — one is asking what the
 * tag says, the other is asking what the name is without it. */
export function untagged(name: string): string {
  return splitModelTag(name).base;
}

/** Embedding and reranking models are not what "which model should I run"
 * means, and HF's pipeline_tag filter doesn't cover the ollama.com scrape.
 * Applied to candidates only — a user's own pulled model is theirs to see
 * regardless of what we think it's for. */
const NON_CHAT_PATTERNS: readonly RegExp[] = [/embed/i, /rerank/i];

export function isNonChat(name: string): boolean {
  return NON_CHAT_PATTERNS.some((re) => re.test(name));
}

export type FitGroup =
  | 'comfortable'
  | 'pressured'
  | 'tight'
  | 'over-budget'
  | 'will-thrash'
  | 'unclassified';

const SEVERITY: Record<Verdict, number> = { comfortable: 0, tight: 1, 'will-thrash': 2 };

/** Collapses the baseline/current verdict pair into one group. Baseline is the
 * grouping axis because it is the conservative, trustworthy figure; the two
 * derived groups carry the disagreement.
 *
 * The `over-budget` branch must test that current is *strictly* better than
 * will-thrash. Testing only `baseline === 'will-thrash'` would send
 * (will-thrash, will-thrash) — a model that fits nowhere — into a group
 * labelled "fits right now", since equal severities don't trip `pressured`. */
export function fitGroup(
  baseline: Verdict | 'unknown',
  current: Verdict | 'unknown'
): FitGroup {
  if (baseline === 'unknown') return 'unclassified';
  if (current === 'unknown') return baseline;
  if (SEVERITY[current] > SEVERITY[baseline]) return 'pressured';
  if (baseline === 'will-thrash' && SEVERITY[current] < SEVERITY['will-thrash']) {
    return 'over-budget';
  }
  return baseline;
}

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
  /** Derived from baselineVerdict + currentVerdict; see fitGroup(). Additive —
   * both raw verdicts stay on the row for --json consumers. */
  fit: FitGroup;
  /** Other tags pointing at the same weights, collapsed by the backend. Absent
   * when there are none, so --json output stays byte-identical for single-tag
   * models. Display-only — the collapse decision already happened upstream. */
  alsoTagged?: string[];
  author?: string | null;
  availableQuants?: string[];
  signals?: RemoteSignals | null;
  discoverySource?: string;
}

export interface Recommendations {
  /** Largest local row in the best available fit group (comfortable →
   * pressured → tight → over-budget). If none of those groups has a row,
   * falls back to the largest `unclassified` row (a never-loaded llama-server
   * model — benching it is how it becomes classifiable), then the smallest
   * `will-thrash` row (least-bad, not arbitrary). Null only when there are no
   * local models at all. */
  runNow: string | null;
  /** The fit group of the row named by `runNow`, so renderers can pick a
   * qualifier that matches the group instead of assuming "safe bet" for every
   * pick. Null exactly when runNow is null. Additive to the --json contract. */
  runNowFit: FitGroup | null;
  /** A larger local row in `over-budget`, mentioned as the bigger-but-riskier option. */
  runNowBigger: string | null;
  /** Highest-ranked remote row in `comfortable`. Rows arrive pre-sorted by downloads. */
  worthPulling: string | null;
}

export interface CheckResult {
  rows: CheckRow[];
  recommendations: Recommendations;
  cloudModels: string[];
  system: SystemMemoryState;
  baselineHeadroomGb: number;
  currentHeadroomGb: number;
  scrapeWarning: string | null;
  remoteSources: RemoteSourceReport[];
  remoteGuidance: string | null;
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

/** Fit groups in Run now preference order. Best-available wins; this is not a
 * filter. See recommend() for why the fallback beyond these matters. */
const RUN_NOW_PREFERENCE: readonly FitGroup[] = [
  'comfortable',
  'pressured',
  'tight',
  'over-budget',
];

/** Downloads descending, nulls last. Shared by the domain ranking (which fixes
 * the order rows arrive in) and the PULLABLE renderer (which re-sorts within
 * each fit group), so the two can't drift apart.
 *
 * `?? -1` and not `|| -1`: a row with `downloads: 0` reported a real count of
 * zero and must still outrank a row that reported no count at all. `||` would
 * fold both onto the same sentinel. */
export function byDownloadsDesc(a: CheckRow, b: CheckRow): number {
  return (b.signals?.downloads ?? -1) - (a.signals?.downloads ?? -1);
}

/** Computed rather than inferred from sort position, so the recommendation can
 * encode nuance a sort order cannot — notably that the largest model a machine
 * can run right now may be one the conservative budget rejects. */
export function recommend(rows: CheckRow[]): Recommendations {
  const biggest = (candidates: CheckRow[]): CheckRow | null =>
    candidates.length === 0
      ? null
      : candidates.reduce((a, b) => ((b.footprintGb ?? 0) > (a.footprintGb ?? 0) ? b : a));
  const smallest = (candidates: CheckRow[]): CheckRow | null =>
    candidates.length === 0
      ? null
      : candidates.reduce((a, b) =>
          (b.footprintGb ?? Infinity) < (a.footprintGb ?? Infinity) ? b : a
        );

  const local = rows.filter((r) => r.source === 'local');
  // Preference order, not a filter. Insisting on 'comfortable' would print no
  // hint at all on a machine whose models are all tight or over-budget. Beyond
  // the ladder, the fallback is explicit and ordered rather than "first local
  // row": prefer the largest unclassified row (this is the aa4a7d0 case — on
  // llama-server a never-loaded model reports no size, and benching it is
  // exactly how it becomes classifiable), and only when there isn't even one
  // of those, the *smallest* will-thrash row — the least-bad option, not
  // whatever happened to be listed first.
  const preferred = RUN_NOW_PREFERENCE.map((g) =>
    biggest(local.filter((r) => r.fit === g))
  ).find((r) => r !== null);
  const runNowRow =
    preferred ??
    biggest(local.filter((r) => r.fit === 'unclassified')) ??
    smallest(local.filter((r) => r.fit === 'will-thrash'));
  const overBudget = biggest(local.filter((r) => r.fit === 'over-budget'));
  // Rows arrive pre-sorted by downloads, so the first match is the top-ranked one.
  const worthPulling =
    rows.find((r) => r.source === 'remote' && r.fit === 'comfortable') ?? null;

  return {
    runNow: runNowRow?.name ?? null,
    runNowFit: runNowRow?.fit ?? null,
    runNowBigger:
      overBudget && (overBudget.footprintGb ?? 0) > (runNowRow?.footprintGb ?? 0)
        ? overBudget.name
        : null,
    worthPulling: worthPulling?.name ?? null,
  };
}

export async function runCheck(query: string | undefined, deps: CheckDeps): Promise<CheckResult> {
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
  let remoteSources: RemoteSourceReport[] = [];
  let scrapeWarning: string | null = null;
  try {
    const discovery = await backend.remoteCandidates?.(query, {
      // Baseline headroom, not current: discovery shows what the machine can
      // run, not what this moment's memory pressure allows.
      maxParameterSizeB: maxCandidateParamsB(baselineHeadroomGb),
    });
    if (discovery) {
      remoteCandidates = discovery.candidates;
      remoteSources = discovery.sources;
    }
  } catch (err) {
    // Backstop only: backends report source failures via sources[].ok, so a
    // throw landing here is a backend bug — treated as every source failing.
    const message = (err as Error).message;
    scrapeWarning = `Could not fetch remote model list: ${message}`;
    gaps.add({
      kind: 'scrape-failed',
      summary: `remote model search failed for backend ${backend.id}`,
      evidence: { backend: backend.id, query, error: message },
    });
  }
  const failedSources = remoteSources.filter(isFailedSource);
  for (const s of failedSources) {
    // Per-source summary keeps GapCollector's kind+summary dedup from
    // collapsing two different failed sources into one gap.
    gaps.add({
      kind: 'scrape-failed',
      summary: `remote source ${s.id} failed for backend ${backend.id}`,
      evidence: { backend: backend.id, source: s.id, query: s.query, error: s.error },
    });
  }
  if (failedSources.length > 0) {
    scrapeWarning = failedSources
      .map((s) => `Could not fetch remote candidates from ${s.id}: ${s.error}`)
      .join('; ');
  }

  const localRows: CheckRow[] = localModels.map((model) => {
    // A currently-loaded model reports its real resident size. Prefer that over the
    // formula every time — no reason to estimate something the backend already measured.
    const measured = running.get(model.name);
    if (measured) {
      const baselineVerdict = classifyVerdict(measured.sizeVramGb, baselineHeadroomGb);
      const currentVerdict = classifyVerdict(measured.sizeVramGb, currentHeadroomGb);
      return {
        name: model.name,
        source: 'local',
        url: null,
        parameterSizeB: model.parameterSizeB,
        quantizationLevel: measured.quantizationLevel,
        footprintGb: measured.sizeVramGb,
        estimateSource: 'measured',
        quantKnown: true,
        baselineVerdict,
        currentVerdict,
        fit: fitGroup(baselineVerdict, currentVerdict),
        ...(model.alsoTagged !== undefined ? { alsoTagged: model.alsoTagged } : {}),
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
        fit: 'unclassified',
        ...(model.alsoTagged !== undefined ? { alsoTagged: model.alsoTagged } : {}),
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
      fit: fitGroup(estimate.baselineVerdict, estimate.currentVerdict),
      ...(model.alsoTagged !== undefined ? { alsoTagged: model.alsoTagged } : {}),
    };
  });

  // Includes alsoTagged: digest collapse means a name can vanish from row
  // names entirely (e.g. `ollama cp llama3.2:3b zzz-review-alias` collapses to
  // one row, and either name could be the one that didn't survive), so
  // dedup against row names alone would let the collapsed-away name leak back
  // into PULLABLE as a candidate the user already has.
  const localNames = new Set(
    localRows.flatMap((r) => [r.name, ...(r.alsoTagged ?? [])]).map(untagged)
  );
  const remoteRows: CheckRow[] = remoteCandidates
    .filter((c) => c.parameterSizeB !== null)
    .filter((c) => !localNames.has(untagged(c.name)))
    .filter((c) => !isNonChat(c.name))
    .map((c) => {
      // Whether a remote candidate carries a quantization depends on where it
      // came from: HF rows carry one picked from the repo's own GGUF files,
      // ollama.com scrape rows carry none (mapCandidates hardcodes null). So a
      // fallback here says something about the candidate, not about a backend
      // failing to report — reported per-row via quantKnown, not as a gap.
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
        fit: fitGroup(estimate.baselineVerdict, estimate.currentVerdict),
        ...(c.author !== undefined ? { author: c.author } : {}),
        ...(c.availableQuants !== undefined ? { availableQuants: c.availableQuants } : {}),
        ...(c.signals !== undefined ? { signals: c.signals } : {}),
        ...(c.discoverySource !== undefined ? { discoverySource: c.discoverySource } : {}),
      };
    });

  // The HF API sorts by trendingScore, which rewards novelty: in the checked-in
  // fixture it ranks a 928-download 0.1B model above a 4.5M-download 9B one.
  // downloads is already in the payload and answers "is this worth pulling"
  // far better. trendingScore stays on the row for --json consumers.
  const rankedRemoteRows = [...remoteRows].sort(byDownloadsDesc);

  const rows = [...localRows, ...rankedRemoteRows];

  return {
    rows,
    recommendations: recommend(rows),
    cloudModels,
    system,
    baselineHeadroomGb,
    currentHeadroomGb,
    scrapeWarning,
    remoteSources,
    remoteGuidance: remoteRows.some((r) => r.signals != null) ? REMOTE_GUIDANCE : null,
  };
}
