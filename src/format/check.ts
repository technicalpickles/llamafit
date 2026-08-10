import type { CheckResult } from '../check.js';
import { colorizeVerdict, label, dim } from '../colors.js';
import { columnWidths, formatRow } from './table.js';
import type { FormatOptions } from './bench.js';

export type { FormatOptions } from './bench.js';

export function formatCheckTable(result: CheckResult, opts: FormatOptions = {}): string {
  const color = opts.color ?? false;
  const header = ['MODEL', 'SOURCE', 'PARAMS(B)', 'QUANT', 'FOOTPRINT(GB)', 'BASELINE', 'CURRENT'];
  // Column widths are computed from the plain (uncolored) cell text, since ANSI escape
  // codes would otherwise pad columns too wide.
  const plainRows = result.rows.map((r) => {
    const measured = r.estimateSource === 'measured';
    const footprint = r.footprintGb !== null ? r.footprintGb.toFixed(1) : '?';
    return [
      r.name,
      r.source,
      r.parameterSizeB !== null ? r.parameterSizeB.toFixed(1) : '?',
      r.quantizationLevel === null ? '?' : r.quantizationLevel + (r.quantKnown ? '' : '?'),
      measured || r.footprintGb === null ? footprint : `~${footprint}`,
      r.baselineVerdict,
      r.currentVerdict,
    ];
  });
  const widths = columnWidths([header, ...plainRows]);

  const displayRows = plainRows.map((row) => [
    ...row.slice(0, 5),
    colorizeVerdict(row[5], color),
    colorizeVerdict(row[6], color),
  ]);

  const lines = [
    formatRow(
      header.map((h) => label(h, color)),
      header,
      widths
    ),
    ...displayRows.map((row, i) => formatRow(row, plainRows[i], widths)),
  ];

  const legend: string[] = [];
  if (result.rows.some((r) => r.estimateSource === 'estimated' && r.footprintGb !== null)) {
    legend.push('~ = estimated from parameter count and quantization (model not currently loaded)');
  }
  if (result.rows.some((r) => !r.quantKnown && r.quantizationLevel !== null)) {
    legend.push('? after QUANT = quantization not reported; assumed for the estimate');
  }
  if (result.rows.some((r) => r.parameterSizeB === null)) {
    legend.push(
      "? = backend couldn't report this model's size (llama-server only exposes GGUF metadata for models loaded at least once)"
    );
  }
  if (legend.length > 0) {
    lines.push('', ...legend.map((l) => dim(l, color)));
  }

  const remoteLinks = result.rows.filter((r) => r.source === 'remote' && r.url !== null);
  if (remoteLinks.length > 0) {
    lines.push('', label('Remote model links:', color));
    for (const r of remoteLinks) {
      const quants = r.availableQuants ?? [];
      const shown = quants.slice(0, 4).join(', ');
      const extra = quants.length > 4 ? `, +${quants.length - 4} more` : '';
      const quantNote = quants.length > 0 ? ` (quants: ${shown}${extra})` : '';
      lines.push(`  ${r.name} → ${dim(r.url as string, color)}${quantNote}`);
    }
  }

  if (result.remoteSources.length > 0) {
    const parts = result.remoteSources.map((s) => {
      if (!s.ok) return `${s.id} failed: ${s.error}`;
      return s.query.length > 0 ? `${s.id} search "${s.query}"` : `${s.id} (default list)`;
    });
    lines.push('', dim(`Remote sources: ${parts.join(' · ')}`, color));
  }

  if (result.remoteGuidance != null) {
    lines.push(
      '',
      dim('Remote candidates are unvetted — see remoteGuidance in --json for how to judge sources.', color)
    );
  }

  if (result.cloudModels.length > 0) {
    lines.push(
      '',
      `${label('Cloud models (run on Ollama Cloud, no local footprint):', color)} ${result.cloudModels.join(', ')}`
    );
  }

  lines.push(
    '',
    `${label(`Baseline headroom (total − ${result.system.totalGb - result.baselineHeadroomGb}GB macOS reserve):`, color)} ${result.baselineHeadroomGb.toFixed(1)}GB`,
    `${label(`Current headroom (total − wired ${result.system.wiredGb.toFixed(1)}GB, approximate):`, color)} ${result.currentHeadroomGb.toFixed(2)}GB`
  );

  if (result.rows.length > 0) {
    // Prefer a row check could actually classify — recommending the one model it
    // couldn't (baselineVerdict 'unknown') would undercut the whole point of the hint.
    const suggestion = result.rows.find((r) => r.baselineVerdict !== 'unknown') ?? result.rows[0];
    const backendFlag = opts.backendId ? ` --backend ${opts.backendId}` : '';
    lines.push(
      '',
      dim(`Next: llamafit bench ${suggestion.name}${backendFlag} for real numbers on this machine.`, color)
    );
  }

  return lines.join('\n');
}

export function formatCheckJson(result: CheckResult): string {
  return JSON.stringify(result, null, 2);
}
