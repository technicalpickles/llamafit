import { MACOS_BASELINE_RESERVE_GB } from './estimate.js';
import type { CheckResult } from './check.js';

export function formatCheckTable(result: CheckResult): string {
  const header = ['MODEL', 'SOURCE', 'PARAMS(B)', 'QUANT', 'EST FOOTPRINT(GB)', 'BASELINE', 'CURRENT'];
  const rows = result.rows.map((r) => [
    r.name,
    r.source,
    r.parameterSizeB !== null ? r.parameterSizeB.toFixed(1) : '?',
    r.quantizationLevel ?? '?',
    r.footprintGb !== null ? r.footprintGb.toFixed(1) : '?',
    r.baselineVerdict,
    r.currentVerdict,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const formatRow = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');

  const lines = [formatRow(header), ...rows.map(formatRow)];

  if (result.cloudModels.length > 0) {
    lines.push('', `Cloud models (run on Ollama Cloud, no local footprint): ${result.cloudModels.join(', ')}`);
  }

  lines.push(
    '',
    `Baseline headroom (total − ${MACOS_BASELINE_RESERVE_GB}GB macOS reserve): ${result.baselineHeadroomGb.toFixed(1)}GB`,
    `Current headroom (live free memory right now): ${result.currentHeadroomGb.toFixed(2)}GB`
  );

  if (result.scrapeWarning) {
    lines.push('', `Warning: ${result.scrapeWarning}`);
  }

  return lines.join('\n');
}

export function formatCheckJson(result: CheckResult): string {
  return JSON.stringify(result, null, 2);
}
