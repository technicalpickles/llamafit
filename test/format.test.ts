import { describe, it, expect } from 'vitest';
import { formatCheckTable, formatCheckJson, formatPullProgress } from '../src/format.js';
import type { CheckResult } from '../src/check.js';
import { formatBenchResult } from '../src/format.js';
import type { BenchResult } from '../src/bench.js';
import type { PullProgress } from '../src/backends/types.js';
import { REMOTE_GUIDANCE } from '../src/hf/guidance.js';

const sampleResult: CheckResult = {
  rows: [
    {
      name: 'gemma3:12b',
      source: 'local',
      url: null,
      parameterSizeB: 12.2,
      quantizationLevel: 'Q4_K_M',
      footprintGb: 8.58,
      estimateSource: 'estimated',
      quantKnown: true,
      baselineVerdict: 'comfortable',
      currentVerdict: 'will-thrash',
      fit: 'pressured',
    },
  ],
  cloudModels: ['glm-5.2:cloud'],
  system: {
    totalGb: 24,
    usedGb: 23,
    wiredGb: 3.8,
    compressorGb: 9.3,
    unusedGb: 0.14,
    swapTotalGb: 12,
    swapUsedGb: 10.4,
    swapFreeGb: 1.5,
  },
  baselineHeadroomGb: 16,
  currentHeadroomGb: 0.14,
  scrapeWarning: null,
  remoteSources: [],
  remoteGuidance: null,
};

describe('formatCheckTable', () => {
  it('includes the model name and both verdicts', () => {
    const table = formatCheckTable(sampleResult);
    expect(table).toContain('gemma3:12b');
    expect(table).toContain('comfortable');
    expect(table).toContain('will-thrash');
  });

  it('lists cloud models separately with a note that they run remotely', () => {
    const table = formatCheckTable(sampleResult);
    expect(table).toContain('glm-5.2:cloud');
    expect(table.toLowerCase()).toContain('cloud');
  });

  it('keeps the scrape warning out of the table (the CLI prints it on stderr)', () => {
    const table = formatCheckTable({ ...sampleResult, scrapeWarning: 'could not reach ollama.com' });
    expect(table).not.toContain('could not reach ollama.com');
  });

  it('marks an estimate built on an unknown quantization, and explains the markers', () => {
    const table = formatCheckTable({
      ...sampleResult,
      rows: [
        {
          name: 'pd95/gptoss-mlx',
          source: 'remote',
          url: 'https://ollama.com/pd95/gptoss-mlx',
          parameterSizeB: 20,
          quantizationLevel: 'Q4_K_M',
          footprintGb: 14.06,
          estimateSource: 'estimated',
          quantKnown: false,
          baselineVerdict: 'will-thrash',
          currentVerdict: 'will-thrash',
          fit: 'will-thrash',
        },
      ],
    });
    const row = table.split('\n').find((l) => l.startsWith('pd95/gptoss-mlx'))!;
    expect(row).toContain('~14.1'); // estimated, not measured
    expect(row).toContain('Q4_K_M?'); // quantization was assumed
    expect(table).toContain('quantization not reported');
  });

  it('lists a link for each remote candidate, so an unfamiliar model is one click away', () => {
    const table = formatCheckTable({
      ...sampleResult,
      rows: [
        ...sampleResult.rows,
        {
          name: 'pd95/gptoss-mlx',
          source: 'remote',
          url: 'https://ollama.com/pd95/gptoss-mlx',
          parameterSizeB: 20,
          quantizationLevel: 'Q4_K_M',
          footprintGb: 14.06,
          estimateSource: 'estimated',
          quantKnown: false,
          baselineVerdict: 'will-thrash',
          currentVerdict: 'will-thrash',
          fit: 'will-thrash',
        },
      ],
    });
    expect(table).toContain('pd95/gptoss-mlx');
    expect(table).toContain('https://ollama.com/pd95/gptoss-mlx');
    // the local row shouldn't get a spurious link line
    expect(table.split('\n').filter((l) => l.includes('ollama.com')).length).toBe(1);
  });

  it('explains the bare "?" with a legend when a local model has no reported size (e.g. an unloaded llama-server model)', () => {
    const table = formatCheckTable({
      ...sampleResult,
      rows: [
        {
          name: 'qwen3-30b',
          source: 'local',
          url: null,
          parameterSizeB: null,
          quantizationLevel: null,
          footprintGb: null,
          estimateSource: 'estimated',
          quantKnown: false,
          baselineVerdict: 'unknown',
          currentVerdict: 'unknown',
          fit: 'unclassified',
        },
      ],
    });
    const row = table.split('\n').find((l) => l.startsWith('qwen3-30b'))!;
    // PARAMS(B), QUANT, and FOOTPRINT(GB) all fall back to a bare "?".
    expect(row.split(/\s{2,}/).filter((cell) => cell === '?')).toHaveLength(3);
    expect(table).toContain("backend couldn't report this model's size");
  });

  it('shows a measured footprint bare, with no estimate marker', () => {
    const table = formatCheckTable({
      ...sampleResult,
      rows: [
        {
          name: 'gemma3:12b',
          source: 'local',
          url: null,
          parameterSizeB: 12.2,
          quantizationLevel: 'Q4_K_M',
          footprintGb: 8.643862854,
          estimateSource: 'measured',
          quantKnown: true,
          baselineVerdict: 'comfortable',
          currentVerdict: 'comfortable',
          fit: 'comfortable',
        },
      ],
    });
    expect(table).not.toContain('~');
    expect(table).not.toContain('Q4_K_M?');
    const row = table.split('\n').find((l) => l.startsWith('gemma3:12b'))!;
    expect(row).toContain('8.6');
  });
});

describe('bench hint', () => {
  it('points a newcomer at `llamafit bench <model>` using a real model name from the table', () => {
    const table = formatCheckTable(sampleResult);
    expect(table).toContain('llamafit bench gemma3:12b');
  });

  it('omits the hint when there are no models to benchmark', () => {
    const table = formatCheckTable({ ...sampleResult, rows: [] });
    expect(table).not.toContain('llamafit bench');
  });

  it('skips a row check could not classify (unknown verdict) in favor of one it could', () => {
    const unknownRow = {
      ...sampleResult.rows[0],
      name: 'qwen3-30b',
      parameterSizeB: null,
      quantizationLevel: null,
      footprintGb: null,
      baselineVerdict: 'unknown' as const,
      currentVerdict: 'unknown' as const,
    };
    const table = formatCheckTable({ ...sampleResult, rows: [unknownRow, ...sampleResult.rows] });
    expect(table).toContain('llamafit bench gemma3:12b');
    expect(table).not.toContain('llamafit bench qwen3-30b');
  });

  it('falls back to the first row when every row is unclassified', () => {
    const unknownRow = {
      ...sampleResult.rows[0],
      name: 'qwen3-30b',
      baselineVerdict: 'unknown' as const,
      currentVerdict: 'unknown' as const,
    };
    const table = formatCheckTable({ ...sampleResult, rows: [unknownRow] });
    expect(table).toContain('llamafit bench qwen3-30b');
  });

  it('includes --backend when the table is scoped to one backend, so a copy-pasted command can\'t autodetect its way to the wrong one', () => {
    const table = formatCheckTable(sampleResult, { backendId: 'llama-server' });
    expect(table).toContain('llamafit bench gemma3:12b --backend llama-server');
  });

  it('omits --backend when no backendId is given (single-backend runs, existing callers)', () => {
    const table = formatCheckTable(sampleResult);
    expect(table).not.toContain('--backend');
  });
});

describe('remote sources footer', () => {
  it('names each source with the query it ran', () => {
    const result: CheckResult = {
      ...sampleResult,
      remoteSources: [
        { id: 'ollama.com', query: 'mlx', ok: true },
        { id: 'huggingface', query: '', ok: true },
      ],
    };
    const out = formatCheckTable(result);
    expect(out).toContain('Remote sources: ollama.com search "mlx" · huggingface (default list)');
  });

  it('marks a failed source inline', () => {
    const result: CheckResult = {
      ...sampleResult,
      remoteSources: [
        { id: 'ollama.com', query: 'mlx', ok: true },
        { id: 'huggingface', query: '', ok: false, error: 'HTTP 429' },
      ],
    };
    expect(formatCheckTable(result)).toContain('huggingface failed: HTTP 429');
  });

  it('omits the line when there are no source reports', () => {
    expect(formatCheckTable({ ...sampleResult, remoteSources: [] })).not.toContain('Remote sources:');
  });
});

describe('remote candidate rendering', () => {
  it('appends a truncated quant list to remote link lines', () => {
    const result: CheckResult = {
      ...sampleResult,
      rows: [
        {
          name: 'pd95/gptoss-mlx',
          source: 'remote',
          url: 'https://ollama.com/pd95/gptoss-mlx',
          parameterSizeB: 20,
          quantizationLevel: 'Q4_K_M',
          footprintGb: 14.06,
          estimateSource: 'estimated',
          quantKnown: false,
          baselineVerdict: 'will-thrash',
          currentVerdict: 'will-thrash',
          fit: 'will-thrash',
          availableQuants: ['Q4_K_M', 'Q5_K_M', 'Q8_0', 'F16', 'BF16', 'IQ4_XS'],
        },
      ],
      remoteGuidance: null,
    };
    const out = formatCheckTable(result);
    expect(out).toContain('quants: Q4_K_M, Q5_K_M, Q8_0, F16, +2 more');
  });

  it('omits the quant note when a remote row has none', () => {
    const result: CheckResult = {
      ...sampleResult,
      rows: [
        {
          name: 'mxbai-embed-large',
          source: 'remote',
          url: 'https://ollama.com/library/mxbai-embed-large',
          parameterSizeB: 0.3,
          quantizationLevel: 'Q4_K_M',
          footprintGb: 0.2,
          estimateSource: 'estimated',
          quantKnown: false,
          baselineVerdict: 'comfortable',
          currentVerdict: 'comfortable',
          fit: 'comfortable',
        },
      ],
      remoteGuidance: null,
    };
    const out = formatCheckTable(result);
    expect(out).not.toContain('quants:');
  });

  it('prints a guidance footer only when remoteGuidance is set', () => {
    const withGuidance: CheckResult = { ...sampleResult, remoteGuidance: REMOTE_GUIDANCE };
    const withoutGuidance: CheckResult = { ...sampleResult, remoteGuidance: null };
    expect(formatCheckTable(withGuidance)).toContain('see remoteGuidance in --json');
    expect(formatCheckTable(withoutGuidance)).not.toContain('remoteGuidance');
  });
});

describe('formatCheckJson', () => {
  it('round-trips the result as valid JSON', () => {
    const json = formatCheckJson(sampleResult);
    const parsed = JSON.parse(json);
    expect(parsed.rows[0].name).toBe('gemma3:12b');
  });
});

describe('formatCheckTable color', () => {
  it('omits ANSI escape codes by default', () => {
    const table = formatCheckTable(sampleResult);
    expect(table).not.toContain('\x1b[');
  });

  it('colors verdicts without breaking column alignment when color is enabled', () => {
    const table = formatCheckTable(sampleResult, { color: true });
    expect(table).toContain('\x1b[');
    expect(table).toContain('comfortable');
    expect(table).toContain('will-thrash');
    // Every data row and the header should still line up to the same visible width.
    const dataLine = table.split('\n').find((l) => l.startsWith('gemma3:12b'))!;
    const headerLine = table.split('\n')[0];
    expect(stripAnsi(dataLine).indexOf('comfortable')).toBe(stripAnsi(headerLine).indexOf('BASELINE'));
  });
});

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('formatBenchResult', () => {
  const memoryBefore = {
    totalGb: 24, usedGb: 3, wiredGb: 3, compressorGb: 6, unusedGb: 15,
    swapTotalGb: 0, swapUsedGb: 0, swapFreeGb: 0,
  };
  const memoryAfter = { ...memoryBefore, usedGb: 23, unusedGb: 0.1, swapUsedGb: 22.6 };

  it('reports tokens/sec and durations for a completed run', () => {
    const result: BenchResult = {
      model: 'gemma3:12b',
      status: 'completed',
      sizeVramGb: 8.64,
      evalTokensPerSecond: 15.5,
      loadDurationSeconds: 12.88,
      totalDurationSeconds: 24.06,
      memoryBefore,
      memoryAfter,
      notes: [],
    };
    const output = formatBenchResult(result);
    expect(output).toContain('gemma3:12b');
    expect(output).toContain('15.5');
    expect(output).toContain('completed');
  });

  it('reports a plain-language timeout message without fabricating numbers', () => {
    const result: BenchResult = {
      model: 'gemma3:27b',
      status: 'timed-out',
      sizeVramGb: 16.91,
      evalTokensPerSecond: null,
      loadDurationSeconds: null,
      totalDurationSeconds: null,
      memoryBefore,
      memoryAfter,
      notes: [],
    };
    const output = formatBenchResult(result);
    expect(output).toContain('timed-out');
    expect(output.toLowerCase()).toContain('swap');
  });

  it('shows the swap delta between before and after', () => {
    const result: BenchResult = {
      model: 'gemma3:27b',
      status: 'timed-out',
      sizeVramGb: 16.91,
      evalTokensPerSecond: null,
      loadDurationSeconds: null,
      totalDurationSeconds: null,
      memoryBefore,
      memoryAfter,
      notes: [],
    };
    const output = formatBenchResult(result);
    expect(output).toContain('22.6');
  });

  it('prints degradation notes only when present', () => {
    const withoutNotes: BenchResult = {
      model: 'gemma3:12b',
      status: 'completed',
      sizeVramGb: null,
      evalTokensPerSecond: 15.5,
      loadDurationSeconds: 12.88,
      totalDurationSeconds: 24.06,
      memoryBefore,
      memoryAfter,
      notes: [],
    };
    expect(formatBenchResult(withoutNotes)).not.toContain('⚠');

    const withNotes: BenchResult = {
      ...withoutNotes,
      notes: ["Fixture can't report per-model VRAM; footprint shown is the system-memory delta only"],
    };
    const output = formatBenchResult(withNotes);
    expect(output).toContain("Fixture can't report per-model VRAM");
  });

  it('prints a real fallback instead of "undefined" for durations/rate the backend never reports', () => {
    // llama-server always returns null loadDurationSeconds by design; a completed run
    // can just as well have null evalTokensPerSecond/totalDurationSeconds too.
    const result: BenchResult = {
      model: 'qwen3-30b',
      status: 'completed',
      sizeVramGb: null,
      evalTokensPerSecond: null,
      loadDurationSeconds: null,
      totalDurationSeconds: null,
      memoryBefore,
      memoryAfter,
      notes: [],
    };
    const output = formatBenchResult(result);
    expect(output).not.toContain('undefined');
    expect(output).toContain('Load duration: not reported by this backend');
    expect(output).toContain('Tokens/sec: not reported by this backend');
    expect(output).toContain('Total duration: not reported by this backend');
  });

  it('omits the model-page line when no modelUrl is given (e.g. a backend with no model hub)', () => {
    const result: BenchResult = {
      model: 'qwen3-30b',
      status: 'completed',
      sizeVramGb: 5.1,
      evalTokensPerSecond: 15.5,
      loadDurationSeconds: 12.88,
      totalDurationSeconds: 24.06,
      memoryBefore,
      memoryAfter,
      notes: [],
    };
    expect(formatBenchResult(result)).not.toContain('http');
    expect(formatBenchResult(result, { modelUrl: null })).not.toContain('http');

    const withUrl = formatBenchResult(result, { modelUrl: 'https://ollama.com/library/qwen3' });
    expect(withUrl).toContain('https://ollama.com/library/qwen3');
  });
});

describe('formatPullProgress', () => {
  it('renders done/total in decimal GB with a percentage', () => {
    expect(formatPullProgress({ doneBytes: 1_200_000_000, totalBytes: 2_700_000_000 })).toBe(
      '1.2/2.7 GB (44%)'
    );
  });

  it('shows 0% instead of dividing by zero when total is unknown', () => {
    expect(formatPullProgress({ doneBytes: 0, totalBytes: 0 })).toBe('0.0/0.0 GB (0%)');
  });
});
