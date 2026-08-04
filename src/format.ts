import { MACOS_BASELINE_RESERVE_GB } from './estimate.js';
import type { CheckResult } from './check.js';
import type { BenchResult } from './bench.js';

export function formatCheckTable(result: CheckResult): string {
  const header = ['MODEL', 'SOURCE', 'PARAMS(B)', 'QUANT', 'FOOTPRINT(GB)', 'BASELINE', 'CURRENT'];
  const rows = result.rows.map((r) => {
    // Measured footprints print bare; estimates get a `~`, and an estimate built on a
    // guessed quantization also gets a `?` on the quant, so false precision is visible.
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
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const formatRow = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');

  const lines = [formatRow(header), ...rows.map(formatRow)];

  const legend: string[] = [];
  if (result.rows.some((r) => r.estimateSource === 'estimated' && r.footprintGb !== null)) {
    legend.push('~ = estimated from parameter count and quantization (model not currently loaded)');
  }
  if (result.rows.some((r) => !r.quantKnown && r.quantizationLevel !== null)) {
    legend.push('? after QUANT = quantization not reported; assumed for the estimate');
  }
  if (legend.length > 0) {
    lines.push('', ...legend);
  }

  if (result.cloudModels.length > 0) {
    lines.push('', `Cloud models (run on Ollama Cloud, no local footprint): ${result.cloudModels.join(', ')}`);
  }

  lines.push(
    '',
    `Baseline headroom (total − ${MACOS_BASELINE_RESERVE_GB}GB macOS reserve): ${result.baselineHeadroomGb.toFixed(1)}GB`,
    `Current headroom (total − wired ${result.system.wiredGb.toFixed(1)}GB, approximate): ${result.currentHeadroomGb.toFixed(2)}GB`
  );

  return lines.join('\n');
}

export function formatCheckJson(result: CheckResult): string {
  return JSON.stringify(result, null, 2);
}

export function formatBenchResult(result: BenchResult): string {
  const lines: string[] = [];
  lines.push(`Model: ${result.model}`);
  lines.push(`Status: ${result.status}`);
  if (result.sizeVramGb !== null) {
    lines.push(`VRAM: ${result.sizeVramGb.toFixed(2)}GB`);
  }
  if (result.status === 'completed') {
    lines.push(`Load duration: ${result.loadDurationSeconds?.toFixed(2)}s`);
    lines.push(`Tokens/sec: ${result.evalTokensPerSecond?.toFixed(1)}`);
    lines.push(`Total duration: ${result.totalDurationSeconds?.toFixed(2)}s`);
  } else {
    lines.push('Did not complete within timeout — likely heavy swap contention.');
  }
  const swapDeltaGb = result.memoryAfter.swapUsedGb - result.memoryBefore.swapUsedGb;
  lines.push(
    `Swap used: ${result.memoryBefore.swapUsedGb.toFixed(1)}GB -> ${result.memoryAfter.swapUsedGb.toFixed(1)}GB ` +
      `(Δ ${swapDeltaGb >= 0 ? '+' : ''}${swapDeltaGb.toFixed(1)}GB)`
  );
  return lines.join('\n');
}
