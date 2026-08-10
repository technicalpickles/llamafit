import type { CheckResult, CheckRow, FitGroup } from '../check.js';
import { label, dim } from '../colors.js';
import { columnWidths, formatRow } from './table.js';
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
 * groups. */
function orderRows(rows: CheckRow[], within: (a: CheckRow, b: CheckRow) => number): CheckRow[] {
  return GROUP_ORDER.flatMap((g) => rows.filter((r) => r.fit === g).sort(within));
}

/** Collapsed sibling tags render as just their tag (`:latest`), never the whole
 * repeated name. Sharing a digest means the base name is identical by
 * definition, so repeating it is pure noise — and because column widths span
 * the section, one long HF repo name rendered twice padded every other row in
 * PULLED out past 170 columns. */
function siblingTags(alsoTagged: string[] | undefined): string {
  if (!alsoTagged?.length) return '';
  const shown = alsoTagged.map((name) => {
    const { tag } = splitModelTag(name);
    return tag === null ? name : `:${tag}`;
  });
  return ` (${shown.join(', ')})`;
}

function cells(r: CheckRow, withDownloads: boolean): string[] {
  const tags = siblingTags(r.alsoTagged);
  const measured = r.estimateSource === 'measured';
  const raw = r.footprintGb !== null ? `${r.footprintGb.toFixed(1)}G` : '?';
  const out = [
    `${r.name}${tags}`,
    measured || r.footprintGb === null ? raw : `~${raw}`,
    r.quantizationLevel === null ? '?' : r.quantizationLevel + (r.quantKnown ? '' : '?'),
  ];
  if (withDownloads) {
    out.push(r.signals?.downloads != null ? `${compactCount(r.signals.downloads)} dl` : '');
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
  }
): string[] {
  if (rows.length === 0) {
    return [label(`${title} (0)`, o.color), `  ${dim(o.emptyMessage, o.color)}`];
  }

  const ordered = orderRows(rows, o.within);
  const shown = o.expanded ? ordered : ordered.slice(0, SECTION_CAP);
  const hidden = ordered.length - shown.length;

  const count = hidden > 0 ? `${shown.length} of ${ordered.length}` : String(ordered.length);
  const suffix = o.suffix !== undefined ? `, ${o.suffix}` : '';
  const lines = [label(`${title} (${count}${suffix})`, o.color)];

  // Widths span the whole section so columns line up across group boundaries.
  const widths = columnWidths(shown.map((r) => cells(r, o.withDownloads)));

  for (const group of GROUP_ORDER) {
    const inGroup = shown.filter((r) => r.fit === group);
    if (inGroup.length === 0) continue;
    lines.push(`  ${dim(groupLabel(group, result), o.color)}`);
    for (const r of inGroup) {
      const c = cells(r, o.withDownloads);
      lines.push(`    ${formatRow(c, c, widths)}`.trimEnd());
    }
  }

  if (hidden > 0) {
    const sizes = ordered
      .slice(shown.length)
      .map((r) => r.footprintGb)
      .filter((f): f is number => f !== null);
    const range =
      sizes.length > 0
        ? `, ${gb(Math.min(...sizes))}–${gb(Math.max(...sizes))}`
        : '';
    lines.push(`    ${dim(`+${hidden} more${range}`, o.color)}${'  '}${dim(o.flag, o.color)}`);
  }

  return lines;
}

function renderRecommendations(result: CheckResult, color: boolean): string[] {
  const { runNow, runNowBigger, worthPulling } = result.recommendations;
  const find = (name: string): CheckRow | undefined =>
    result.rows.find((r) => r.name === name);
  const lines: string[] = [];

  if (runNow !== null) {
    const row = find(runNow);
    const size = row?.footprintGb != null ? ` · ${gb(row.footprintGb)}` : '';
    let text = `${runNow}${size} · safe bet`;
    if (runNowBigger !== null) {
      const big = find(runNowBigger);
      const bigSize = big?.footprintGb != null ? ` (${gb(big.footprintGb)})` : '';
      text += `. ${runNowBigger}${bigSize} is bigger and fits at this moment, but needs most of your free memory`;
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

  lines.push(
    '',
    ...renderSection('PULLED', local, result, {
      color,
      expanded: expand === 'local' || expand === 'all',
      flag: '--local',
      emptyMessage: 'No models pulled yet.',
      withDownloads: false,
      within: bySizeDesc,
    })
  );

  const sourceIds = result.remoteSources.filter((s) => s.ok).map((s) => s.id);
  lines.push(
    '',
    ...renderSection('PULLABLE', remote, result, {
      color,
      expanded: expand === 'remote' || expand === 'all',
      flag: '--remote',
      emptyMessage: 'No remote candidates found.',
      withDownloads: true,
      within: byDownloadsDesc,
      suffix: sourceIds.length > 0 ? `${sourceIds.join(' + ')}, by downloads` : undefined,
    })
  );

  // Legend, unchanged in spirit: only the lines that apply to rows on screen.
  const legend: string[] = [];
  if (result.rows.some((r) => r.estimateSource === 'estimated' && r.footprintGb !== null)) {
    legend.push('~ = estimated from parameter count and quantization (model not currently loaded)');
  }
  if (result.rows.some((r) => !r.quantKnown && r.quantizationLevel !== null)) {
    legend.push('? after a quantization = not reported by the backend; assumed for the estimate');
  }
  if (result.rows.some((r) => r.parameterSizeB === null)) {
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
