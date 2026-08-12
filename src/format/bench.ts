import type { BenchResult } from '../bench.js';
import type { PullProgress } from '../backends/types.js';
import { colorizeBenchStatus, label, dim, warn } from '../colors.js';

export interface FormatOptions {
  color?: boolean;
  /** The model's page on the backend's model hub, if it has one. Ollama models live at
   * ollama.com; other backends (e.g. llama-server's local GGUFs) have no such page, so
   * this is null and formatBenchResult omits the line rather than fabricate a URL. */
  modelUrl?: string | null;
  /** The backend this CheckResult came from. formatCheckTable is called once per
   * detected backend, so when set, the bench hint below pins `--backend <id>` — otherwise
   * a copy-pasted command falls through to bench's own autodetection, which may not pick
   * the same backend this table's rows came from (see the hf.co/ prefix mismatch this
   * caused: a name pasted from the llama-server table, benched with no --backend, resolved
   * to Ollama and failed). */
  backendId?: string;
  /** Which section to render uncapped. Undefined caps both. */
  expand?: 'local' | 'remote' | 'all';
}

/** Printed in place of a duration/rate the backend didn't report, so degraded output
 * reads as "not reported" rather than `undefineds`. */
const NOT_REPORTED = 'not reported by this backend';

export function formatBenchResult(result: BenchResult, opts: FormatOptions = {}): string {
  const color = opts.color ?? false;
  const lines: string[] = [];

  // Grouped into identity / outcome / performance / memory-impact, with blank lines
  // between groups so the result doesn't read as one dense block.
  const modelUrl = opts.modelUrl ?? null;

  lines.push(`${label('Model:', color)} ${result.model}`);
  if (modelUrl !== null) {
    lines.push(dim(`  ${modelUrl}`, color));
  }
  lines.push('');

  lines.push(`${label('Status:', color)} ${colorizeBenchStatus(result.status, color)}`);
  if (result.sizeVramGb !== null) {
    lines.push(`${label('VRAM:', color)} ${result.sizeVramGb.toFixed(2)}GB`);
  }

  lines.push('');
  if (result.status === 'completed') {
    lines.push(
      `${label('Load duration:', color)} ${result.loadDurationSeconds !== null ? `${result.loadDurationSeconds.toFixed(2)}s` : NOT_REPORTED}`
    );
    lines.push(
      `${label('Tokens/sec:', color)} ${result.evalTokensPerSecond !== null ? result.evalTokensPerSecond.toFixed(1) : NOT_REPORTED}`
    );
    lines.push(
      `${label('Total duration:', color)} ${result.totalDurationSeconds !== null ? `${result.totalDurationSeconds.toFixed(2)}s` : NOT_REPORTED}`
    );
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

/** Download progress for the bench spinner: decimal GB to one decimal place,
 * matching the table/bench output conventions in this file. */
export function formatPullProgress(p: PullProgress): string {
  const gb = (bytes: number) => (bytes / 1e9).toFixed(1);
  const pct = p.totalBytes > 0 ? Math.round((p.doneBytes / p.totalBytes) * 100) : 0;
  return `${gb(p.doneBytes)}/${gb(p.totalBytes)} GB (${pct}%)`;
}
