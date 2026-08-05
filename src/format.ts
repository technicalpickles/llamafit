import { loadThresholds } from './data.js';
import type { CheckResult } from './check.js';
import type { BenchResult } from './bench.js';
import { modelPageUrl } from './backends/ollama/client.js';
import { colorizeVerdict, colorizeBenchStatus, label, dim, warn } from './colors.js';

export interface FormatOptions {
  color?: boolean;
}

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
  const widths = header.map((h, i) => Math.max(h.length, ...plainRows.map((row) => row[i].length)));
  // Pad against the plain-text width, not the display cell's own length — a colorized
  // cell has invisible escape codes that would otherwise throw off the column alignment.
  const padCell = (display: string, plain: string, width: number) =>
    display + ' '.repeat(Math.max(0, width - plain.length));
  const formatRow = (displayCells: string[], plainCells: string[]) =>
    displayCells.map((c, i) => padCell(c, plainCells[i], widths[i])).join('  ');

  const displayRows = plainRows.map((row) => [
    ...row.slice(0, 5),
    colorizeVerdict(row[5], color),
    colorizeVerdict(row[6], color),
  ]);

  const lines = [
    formatRow(
      header.map((h) => label(h, color)),
      header
    ),
    ...displayRows.map((row, i) => formatRow(row, plainRows[i])),
  ];

  const legend: string[] = [];
  if (result.rows.some((r) => r.estimateSource === 'estimated' && r.footprintGb !== null)) {
    legend.push('~ = estimated from parameter count and quantization (model not currently loaded)');
  }
  if (result.rows.some((r) => !r.quantKnown && r.quantizationLevel !== null)) {
    legend.push('? after QUANT = quantization not reported; assumed for the estimate');
  }
  if (legend.length > 0) {
    lines.push('', ...legend.map((l) => dim(l, color)));
  }

  const remoteLinks = result.rows.filter((r) => r.source === 'remote' && r.url !== null);
  if (remoteLinks.length > 0) {
    lines.push('', label('Remote model links:', color));
    for (const r of remoteLinks) {
      lines.push(`  ${r.name} → ${dim(r.url as string, color)}`);
    }
  }

  if (result.cloudModels.length > 0) {
    lines.push(
      '',
      `${label('Cloud models (run on Ollama Cloud, no local footprint):', color)} ${result.cloudModels.join(', ')}`
    );
  }

  lines.push(
    '',
    `${label(`Baseline headroom (total − ${loadThresholds().baselineReserveGb['darwin']}GB macOS reserve):`, color)} ${result.baselineHeadroomGb.toFixed(1)}GB`,
    `${label(`Current headroom (total − wired ${result.system.wiredGb.toFixed(1)}GB, approximate):`, color)} ${result.currentHeadroomGb.toFixed(2)}GB`
  );

  return lines.join('\n');
}

export function formatCheckJson(result: CheckResult): string {
  return JSON.stringify(result, null, 2);
}

export function formatBenchResult(result: BenchResult, opts: FormatOptions = {}): string {
  const color = opts.color ?? false;
  const lines: string[] = [];

  // Grouped into identity / outcome / performance / memory-impact, with blank lines
  // between groups so the result doesn't read as one dense block.
  lines.push(`${label('Model:', color)} ${result.model}`);
  lines.push(dim(`  ${modelPageUrl(result.model)}`, color));
  lines.push('');

  lines.push(`${label('Status:', color)} ${colorizeBenchStatus(result.status, color)}`);
  if (result.sizeVramGb !== null) {
    lines.push(`${label('VRAM:', color)} ${result.sizeVramGb.toFixed(2)}GB`);
  }

  lines.push('');
  if (result.status === 'completed') {
    lines.push(`${label('Load duration:', color)} ${result.loadDurationSeconds?.toFixed(2)}s`);
    lines.push(`${label('Tokens/sec:', color)} ${result.evalTokensPerSecond?.toFixed(1)}`);
    lines.push(`${label('Total duration:', color)} ${result.totalDurationSeconds?.toFixed(2)}s`);
  } else {
    lines.push('Did not complete within timeout — likely heavy swap contention.');
  }

  const swapDeltaGb = result.memoryAfter.swapUsedGb - result.memoryBefore.swapUsedGb;
  lines.push('');
  lines.push(
    `${label('Swap used:', color)} ${result.memoryBefore.swapUsedGb.toFixed(1)}GB -> ${result.memoryAfter.swapUsedGb.toFixed(1)}GB ` +
      `(Δ ${swapDeltaGb >= 0 ? '+' : ''}${swapDeltaGb.toFixed(1)}GB)`
  );

  if (result.notes.length > 0) {
    lines.push('');
    for (const note of result.notes) {
      lines.push(warn(note, color));
    }
  }

  return lines.join('\n');
}
