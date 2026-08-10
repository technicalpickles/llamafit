import type { CheckResult, CheckRow, FitGroup } from '../check.js';
import { label, dim } from '../colors.js';
import type { FormatOptions } from './bench.js';
import { splitModelTag } from '../model-names.js';

export type { FormatOptions } from './bench.js';

/** Both sections get the same cap, so the local inventory gets no more room
 * than the remote list. */
export const SECTION_CAP = 5;

/** Best news first: the answer to "what should I run" leads, caveats follow. */
const GROUP_ORDER: readonly FitGroup[] = [
  'comfortable',
  'pressured',
  'tight',
  'over-budget',
  'will-thrash',
  'unclassified',
];

function gb(n: number): string {
  return `${n.toFixed(1)}G`;
}

/** 4489302 → "4.5M", 62682 → "63k". Download counts are a rough signal; full
 * precision would imply more than they carry. */
function compactCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function groupLabel(group: FitGroup, result: CheckResult): string {
  const b = gb(result.baselineHeadroomGb);
  const c = gb(result.currentHeadroomGb);
  switch (group) {
    case 'comfortable':
      return 'comfortable';
    case 'pressured':
      return `tight right now · only ${c} free, other apps are holding memory`;
    case 'tight':
      return `tight · close to the ${b} safe budget`;
    case 'over-budget':
      return `over the ${b} safe budget · fits right now, ${c} free`;
    case 'will-thrash':
      return "won't fit";
    case 'unclassified':
      return "unclassified · backend didn't report a size";
  }
}

/** Nulls last — a row with no footprint can't be ranked, and trailing it keeps
 * the "biggest first" reading of everything above it intact. */
function bySizeDesc(a: CheckRow, b: CheckRow): number {
  if (a.footprintGb === null) return b.footprintGb === null ? 0 : 1;
  if (b.footprintGb === null) return -1;
  return b.footprintGb - a.footprintGb;
}

/** Downloads descending, nulls last. */
function byDownloadsDesc(a: CheckRow, b: CheckRow): number {
  return (b.signals?.downloads ?? -1) - (a.signals?.downloads ?? -1);
}

/** Flattens to display order: group order first, `within` descending inside
 * each group. Capping then slices this list, so the cap is defined over the
 * section rather than per group — five rows means five rows, whatever mix of
 * groups.
 *
 * GROUP_ORDER is a hardcoded list of FitGroup values; flatMap-ing over it
 * alone would silently drop any row whose fit isn't in that list —
 * unrendered, uncounted in the section header, absent from "+N more". Unlike
 * groupLabel's switch (TypeScript exhaustiveness-checks that), nothing else
 * guards this list, so a leftover bucket is appended for any fit outside
 * GROUP_ORDER rather than trusting every caller to keep the two in sync. */
function orderRows(rows: CheckRow[], within: (a: CheckRow, b: CheckRow) => number): CheckRow[] {
  const known = new Set<FitGroup>(GROUP_ORDER);
  const grouped = GROUP_ORDER.flatMap((g) => rows.filter((r) => r.fit === g).sort(within));
  const leftover = rows.filter((r) => !known.has(r.fit)).sort(within);
  return [...grouped, ...leftover];
}

/** Collapsed sibling tags render as just their tag (`:latest`) only when the
 * sibling shares the representative row's base name — sharing a digest does
 * *not* imply a shared base name (`ollama cp <model> <alias>` produces two
 * tags on one digest with different bases), so a sibling whose base differs
 * renders in full. Rendering it as `:tag` in that case would fabricate a
 * model name that does not exist. Also collapses a same-base repeated name:
 * because column widths span the section, one long HF repo name rendered
 * twice padded every other row in PULLED out past 170 columns. */
function siblingTags(name: string, alsoTagged: string[] | undefined): string {
  if (!alsoTagged?.length) return '';
  const { base: repBase } = splitModelTag(name);
  const shown = alsoTagged.map((sibling) => {
    const { base, tag } = splitModelTag(sibling);
    return base === repBase && tag !== null ? `:${tag}` : sibling;
  });
  return ` (${shown.join(', ')})`;
}

/** Ragged-right, not columnar: name then metrics, single spaces, no padding.
 * One 78-char HF repo name used to inflate the whole section's name column
 * (~107 chars), wrapping the metric cells of every other row onto what read
 * as a second, misassociated row at 80 columns. Ragged-right never wraps
 * that way and never truncates. */
function renderCells(r: CheckRow, withDownloads: boolean): string[] {
  const tags = siblingTags(r.name, r.alsoTagged);
  const measured = r.estimateSource === 'measured';
  const raw = r.footprintGb !== null ? `${r.footprintGb.toFixed(1)}G` : '?';
  const out = [
    `${r.name}${tags}`,
    measured || r.footprintGb === null ? raw : `~${raw}`,
    r.quantizationLevel === null ? '?' : r.quantizationLevel + (r.quantKnown ? '' : '?'),
  ];
  if (withDownloads && r.signals?.downloads != null) {
    out.push(`${compactCount(r.signals.downloads)} dl`);
  }
  return out;
}

function renderSection(
  title: string,
  rows: CheckRow[],
  result: CheckResult,
  o: {
    color: boolean;
    expanded: boolean;
    flag: string;
    emptyMessage: string;
    withDownloads: boolean;
    within: (a: CheckRow, b: CheckRow) => number;
    suffix?: string;
    /** Row names that must render even if the cap would otherwise hide them —
     * a row named in the "Run now"/"Worth pulling" prose above the section.
     * Names not present in `rows` are ignored (e.g. a PULLED-only name passed
     * to the PULLABLE section). */
    pinnedNames?: string[];
  }
): { lines: string[]; shown: CheckRow[] } {
  if (rows.length === 0) {
    return {
      lines: [label(`${title} (0)`, o.color), `  ${dim(o.emptyMessage, o.color)}`],
      shown: [],
    };
  }

  const ordered = orderRows(rows, o.within);
  const capped = o.expanded ? ordered : ordered.slice(0, SECTION_CAP);
  const cappedSet = new Set(capped);
  // Extends the shown set by one row per pin rather than swapping another row
  // out: a swap would just move the "which row got hidden" confusion onto a
  // different row, while extending never removes information the cap already
  // decided to show.
  const pinned = (o.pinnedNames ?? [])
    .map((name) => ordered.find((r) => r.name === name))
    .filter((r): r is CheckRow => r !== undefined && !cappedSet.has(r));
  const shown = o.expanded ? ordered : [...capped, ...pinned];
  const shownSet = new Set(shown);
  const hiddenRows = ordered.filter((r) => !shownSet.has(r));
  const hidden = hiddenRows.length;

  const count = hidden > 0 ? `${shown.length} of ${ordered.length}` : String(ordered.length);
  const suffix = o.suffix !== undefined ? `, ${o.suffix}` : '';
  const lines = [label(`${title} (${count}${suffix})`, o.color)];

  const renderRow = (r: CheckRow) => {
    lines.push(`    ${renderCells(r, o.withDownloads).join(' ')}`);
  };

  for (const group of GROUP_ORDER) {
    const inGroup = shown.filter((r) => r.fit === group);
    if (inGroup.length === 0) continue;
    lines.push(`  ${dim(groupLabel(group, result), o.color)}`);
    inGroup.forEach(renderRow);
  }

  // See orderRows: a row whose fit isn't in GROUP_ORDER lands here instead of
  // vanishing.
  const known = new Set<FitGroup>(GROUP_ORDER);
  const leftover = shown.filter((r) => !known.has(r.fit));
  if (leftover.length > 0) {
    lines.push(`  ${dim('other', o.color)}`);
    leftover.forEach(renderRow);
  }

  if (hidden > 0) {
    const sizes = hiddenRows.map((r) => r.footprintGb).filter((f): f is number => f !== null);
    const unknownCount = hiddenRows.length - sizes.length;
    // Degenerate case: a single distinct size (or a range that happens to
    // collapse to one) reads better as "19.3G" than "19.3G–19.3G". And a
    // range built only from the hidden rows that *have* a footprint silently
    // implied it covered every hidden row — say so instead when some don't.
    let range = '';
    if (sizes.length > 0) {
      const min = Math.min(...sizes);
      const max = Math.max(...sizes);
      range = min === max ? `, ${gb(min)}` : `, ${gb(min)}–${gb(max)}`;
      if (unknownCount > 0) range += ` (+${unknownCount} size unknown)`;
    } else if (unknownCount > 0) {
      range = ', size unknown';
    }
    lines.push(`    ${dim(`+${hidden} more${range}`, o.color)}${'  '}${dim(o.flag, o.color)}`);
  }

  return { lines, shown };
}

/** Matches the group the row actually landed in, so the qualifier never
 * contradicts the group header printed a few lines below it. */
function runNowQualifier(fit: FitGroup): string {
  switch (fit) {
    case 'comfortable':
      return 'safe bet';
    case 'pressured':
      return 'fits the safe budget, but memory is tight right now';
    case 'tight':
      return 'close to the safe budget';
    case 'over-budget':
      return 'over the safe budget — fits right now, but needs most of your free memory';
    case 'unclassified':
      return 'size unknown — bench it to find out';
    case 'will-thrash':
      return 'nothing here fits comfortably; this is the smallest you have';
  }
}

/** "Run now" plus the two spaces `formatCheckTable` pads it with before the
 * value starts — the continuation line below indents to the same column. */
const RUN_NOW_PREFIX_WIDTH = 'Run now'.length + 8;

function renderRecommendations(result: CheckResult, color: boolean): string[] {
  const { runNow, runNowFit, runNowBigger, worthPulling } = result.recommendations;
  const find = (name: string): CheckRow | undefined =>
    result.rows.find((r) => r.name === name);
  const lines: string[] = [];

  if (runNow !== null) {
    const row = find(runNow);
    const size = row?.footprintGb != null ? ` · ${gb(row.footprintGb)}` : '';
    const qualifier = runNowFit !== null ? runNowQualifier(runNowFit) : '';
    let text = `${runNow}${size} · ${qualifier}`;
    if (runNowBigger !== null) {
      const big = find(runNowBigger);
      const bigSize = big?.footprintGb != null ? ` (${gb(big.footprintGb)})` : '';
      // Its own indented continuation line, not wrapped inline — the combined
      // sentence runs past 130 characters, and a reader could misread an
      // inline wrap as belonging to a different model.
      text +=
        `\n${' '.repeat(RUN_NOW_PREFIX_WIDTH)}${runNowBigger}${bigSize} is bigger and fits ` +
        'at this moment, but needs most of your free memory';
    }
    lines.push(`${label('Run now', color)}        ${text}`);
  }

  if (worthPulling !== null) {
    const row = find(worthPulling);
    const parts = [worthPulling];
    if (row?.footprintGb != null) parts.push(gb(row.footprintGb));
    if (row?.quantizationLevel) parts.push(row.quantizationLevel);
    if (row?.signals?.downloads != null) {
      parts.push(`${compactCount(row.signals.downloads)} downloads`);
    }
    lines.push(`${label('Worth pulling', color)}  ${parts.join(' · ')}`);
  }

  return lines;
}

export function formatCheckTable(result: CheckResult, opts: FormatOptions = {}): string {
  const color = opts.color ?? false;
  const expand = opts.expand;
  const local = result.rows.filter((r) => r.source === 'local');
  const remote = result.rows.filter((r) => r.source === 'remote');

  // The header comes first because every verdict below is relative to these two
  // figures. Reserve is derived rather than hardcoded, and deliberately unnamed
  // by platform so a Linux probe needs no wording change here.
  const reserveGb = result.system.totalGb - result.baselineHeadroomGb;
  const lines: string[] = [
    `${gb(result.system.totalGb)} total  ·  ${gb(result.baselineHeadroomGb)} safe budget ` +
      `(−${gb(reserveGb)} reserve)  ·  ${gb(result.currentHeadroomGb)} free now ` +
      `(−${gb(result.system.wiredGb)} wired)`,
  ];

  const recs = renderRecommendations(result, color);
  if (recs.length > 0) lines.push('', ...recs);

  const pulled = renderSection('PULLED', local, result, {
    color,
    expanded: expand === 'local' || expand === 'all',
    flag: '--local',
    emptyMessage: 'No models pulled yet.',
    withDownloads: false,
    within: bySizeDesc,
    pinnedNames: [result.recommendations.runNow, result.recommendations.runNowBigger].filter(
      (n): n is string => n !== null
    ),
  });
  lines.push('', ...pulled.lines);

  const sourceIds = result.remoteSources.filter((s) => s.ok).map((s) => s.id);
  const pullable = renderSection('PULLABLE', remote, result, {
    color,
    expanded: expand === 'remote' || expand === 'all',
    flag: '--remote',
    emptyMessage: 'No remote candidates found.',
    withDownloads: true,
    within: byDownloadsDesc,
    suffix: sourceIds.length > 0 ? `${sourceIds.join(' + ')}, by downloads` : undefined,
    pinnedNames:
      result.recommendations.worthPulling !== null ? [result.recommendations.worthPulling] : [],
  });
  lines.push('', ...pullable.lines);

  // Legend: only the lines that apply to rows actually on screen. Both
  // sections cap at SECTION_CAP, so this must key off what renderSection
  // decided to show, not result.rows (the full, uncapped set) — a marker
  // whose only rows are all in the capped-out tail has nothing on screen to
  // explain.
  const shownRows = [...pulled.shown, ...pullable.shown];
  const legend: string[] = [];
  if (shownRows.some((r) => r.estimateSource === 'estimated' && r.footprintGb !== null)) {
    legend.push('~ = estimated from parameter count and quantization (model not currently loaded)');
  }
  if (shownRows.some((r) => !r.quantKnown && r.quantizationLevel !== null)) {
    legend.push('? after a quantization = not reported by the backend; assumed for the estimate');
  }
  if (shownRows.some((r) => r.parameterSizeB === null)) {
    legend.push(
      "? = backend couldn't report this model's size (llama-server only exposes GGUF metadata for models loaded at least once)"
    );
  }
  if (legend.length > 0) lines.push('', ...legend.map((l) => dim(l, color)));

  const failed = result.remoteSources.filter((s) => !s.ok);
  if (failed.length > 0) {
    lines.push(
      '',
      ...failed.map((s) => dim(`${s.id} failed: ${'error' in s ? s.error : 'unknown'}`, color))
    );
  }

  if (result.remoteGuidance != null) {
    lines.push(
      '',
      dim(
        'Remote candidates are unvetted — see remoteGuidance in --json for how to judge sources.',
        color
      )
    );
  }

  if (result.recommendations.runNow !== null) {
    const backendFlag = opts.backendId ? ` --backend ${opts.backendId}` : '';
    lines.push(
      '',
      dim(
        `Next: llamafit bench ${result.recommendations.runNow}${backendFlag} for real numbers on this machine.`,
        color
      )
    );
  }

  return lines.join('\n');
}

export function formatCheckJson(result: CheckResult): string {
  return JSON.stringify(result, null, 2);
}
