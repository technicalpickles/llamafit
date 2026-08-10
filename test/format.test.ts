import { describe, it, expect } from 'vitest';
import { formatCheckTable, formatCheckJson, formatPullProgress } from '../src/format.js';
import type { CheckResult, CheckRow } from '../src/check.js';
import { formatBenchResult } from '../src/format.js';
import type { BenchResult } from '../src/bench.js';
import type { PullProgress } from '../src/backends/types.js';
import { REMOTE_GUIDANCE } from '../src/hf/guidance.js';
import { SECTION_CAP } from '../src/format/check.js';

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
  recommendations: { runNow: 'gemma3:12b', runNowBigger: null, worthPulling: null },
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
    const row = table.split('\n').find((l) => l.includes('pd95/gptoss-mlx'))!;
    expect(row).toContain('~14.1'); // estimated, not measured
    expect(row).toContain('Q4_K_M?'); // quantization was assumed
    expect(table).toContain('not reported by the backend');
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
    const row = table.split('\n').find((l) => l.includes('qwen3-30b'))!;
    // FOOTPRINT and QUANT both fall back to a bare "?" (there's no separate
    // PARAMS(B) column in the section rendering).
    expect(row.split(/\s{2,}/).filter((cell) => cell === '?')).toHaveLength(2);
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
    const row = table.split('\n').find((l) => l.includes('gemma3:12b'))!;
    expect(row).toContain('8.6');
  });
});

describe('bench hint', () => {
  it('points a newcomer at `llamafit bench <model>` using a real model name from the table', () => {
    const table = formatCheckTable(sampleResult);
    expect(table).toContain('llamafit bench gemma3:12b');
  });

  it('omits the hint when there are no models to benchmark', () => {
    const table = formatCheckTable({
      ...sampleResult,
      rows: [],
      recommendations: { runNow: null, runNowBigger: null, worthPulling: null },
    });
    expect(table).not.toContain('llamafit bench');
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

  it('renders the PULLABLE header cleanly when there are no source reports (no dangling suffix)', () => {
    // sourceIds is empty here (remoteSources: []), so the `, ${ids}, by downloads`
    // suffix must be skipped entirely — not printed with an empty id list, and
    // not leaving a dangling ", by downloads" or stray trailing comma behind.
    const out = formatCheckTable({
      ...sampleResult,
      rows: [{ ...sampleResult.rows[0], source: 'remote', fit: 'comfortable' }],
      remoteSources: [],
    });
    const header = out.split('\n').find((l) => l.includes('PULLABLE'))!;
    expect(header).toBe('PULLABLE (1)');
    expect(out).not.toContain('by downloads');
  });
});

describe('remote candidate rendering', () => {
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

  it('colors section titles and group labels without disturbing row-cell alignment', () => {
    // Section titles (label()) and group headers (dim()) carry ANSI codes; the
    // row cells themselves don't (cells() is passed as both the display and
    // plain args to formatRow), so a colorized run's data rows must be
    // byte-identical to the uncolored run's — nothing computes width from a
    // colorized string here, but this pins that invariant so it stays true.
    const rows = [
      { ...sampleResult.rows[0], name: 'gemma3:12b', footprintGb: 8.58, fit: 'comfortable' as const },
      { ...sampleResult.rows[0], name: 'a-much-longer-model-name', footprintGb: 2.3, fit: 'comfortable' as const },
    ];
    const colored = formatCheckTable({ ...sampleResult, rows }, { color: true });
    const plain = formatCheckTable({ ...sampleResult, rows }, { color: false });
    expect(colored).toContain('\x1b[');
    // Row lines are indented four spaces under their group header; matching that
    // indent (rather than a bare substring search) avoids matching the "Run now"
    // recommendation line, which also names the model but is colorized.
    const rowLine = (out: string, name: string) =>
      out.split('\n').find((l) => new RegExp(`^ {4}${name}`).test(l))!;
    expect(rowLine(colored, 'gemma3:12b')).toBe(rowLine(plain, 'gemma3:12b'));
    expect(rowLine(colored, 'a-much-longer-model-name')).toBe(rowLine(plain, 'a-much-longer-model-name'));
  });
});

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('formatCheckTable sections', () => {
  it('leads with a one-line header carrying both headroom figures', () => {
    const out = formatCheckTable(sampleResult, { color: false });
    const first = out.split('\n')[0];
    expect(first).toContain('24.0G total');
    expect(first).toContain('16.0G safe budget');
    expect(first).toMatch(/free now/);
  });

  it('never renders cloud models', () => {
    const out = formatCheckTable(
      { ...sampleResult, cloudModels: ['glm-5.2:cloud', 'gemma4:cloud'] },
      { color: false }
    );
    expect(out).not.toContain('glm-5.2:cloud');
    expect(out).not.toContain('Cloud models');
  });

  it('renders a group header per fit group present, not a verdict column', () => {
    const out = formatCheckTable(sampleResult, { color: false });
    expect(out).not.toContain('BASELINE');
    expect(out).not.toContain('CURRENT');
    // sampleResult's row is comfortable/will-thrash → pressured
    expect(out).toMatch(/tight right now/);
  });

  it('caps a section and reports what was withheld', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      ...sampleResult.rows[0],
      name: `local-${i}`,
      footprintGb: 8 - i,
      fit: 'comfortable' as const,
      baselineVerdict: 'comfortable' as const,
      currentVerdict: 'comfortable' as const,
    }));
    const out = formatCheckTable({ ...sampleResult, rows: many }, { color: false });
    expect(out).toContain(`+${9 - SECTION_CAP} more`);
    expect(out).toContain('--local');
    expect(out).toContain('local-0');
    expect(out).not.toContain('local-8');
  });

  it('derives the overflow range from the hidden rows only, not the whole section', () => {
    // The largest row (10G) is within the cap and must not leak into the "+N
    // more" range — the hidden rows are all much smaller (1G), so a range
    // computed over every row instead of just the hidden ones would wrongly
    // show 1.0G–10.0G here.
    const rows = [10, 9, 8, 7, 6, 1].map((size, i) => ({
      ...sampleResult.rows[0],
      name: `local-${i}`,
      footprintGb: size,
      fit: 'comfortable' as const,
      baselineVerdict: 'comfortable' as const,
      currentVerdict: 'comfortable' as const,
    }));
    const out = formatCheckTable({ ...sampleResult, rows }, { color: false });
    const moreLine = out.split('\n').find((l) => l.includes('more'))!;
    expect(moreLine).toContain('1.0G–1.0G');
    expect(moreLine).not.toContain('10.0G');
  });

  it('caps by total rows across groups, not per group', () => {
    // 3 comfortable + 3 over-budget = 6 rows, each group under SECTION_CAP (5)
    // on its own. A per-group cap would show all 6 with no overflow line; the
    // section-wide cap must show exactly 5 and report 1 withheld.
    const comfortable = Array.from({ length: 3 }, (_, i) => ({
      ...sampleResult.rows[0],
      name: `comfortable-${i}`,
      footprintGb: 8 - i,
      fit: 'comfortable' as const,
      baselineVerdict: 'comfortable' as const,
      currentVerdict: 'comfortable' as const,
    }));
    const overBudget = Array.from({ length: 3 }, (_, i) => ({
      ...sampleResult.rows[0],
      name: `over-budget-${i}`,
      footprintGb: 20 - i,
      fit: 'over-budget' as const,
      baselineVerdict: 'will-thrash' as const,
      currentVerdict: 'comfortable' as const,
    }));
    const out = formatCheckTable(
      { ...sampleResult, rows: [...comfortable, ...overBudget] },
      { color: false }
    );
    const shownRows = out.split('\n').filter((l) => /^ {4}(comfortable|over-budget)-\d/.test(l));
    expect(shownRows).toHaveLength(SECTION_CAP);
    expect(out).toContain('+1 more');
  });

  it('emits no overflow line at exactly the cap', () => {
    const exactly = Array.from({ length: SECTION_CAP }, (_, i) => ({
      ...sampleResult.rows[0],
      name: `local-${i}`,
      fit: 'comfortable' as const,
      baselineVerdict: 'comfortable' as const,
      currentVerdict: 'comfortable' as const,
    }));
    const out = formatCheckTable({ ...sampleResult, rows: exactly }, { color: false });
    expect(out).not.toContain('more');
  });

  it('uncaps the section named by expand', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      ...sampleResult.rows[0],
      name: `local-${i}`,
      fit: 'comfortable' as const,
      baselineVerdict: 'comfortable' as const,
      currentVerdict: 'comfortable' as const,
    }));
    const out = formatCheckTable({ ...sampleResult, rows: many }, {
      color: false,
      expand: 'local',
    });
    expect(out).toContain('local-8');
    expect(out).not.toContain('more');
  });

  it('shows a collapsed sibling as just its tag, not the repeated base name', () => {
    const out = formatCheckTable(
      {
        ...sampleResult,
        rows: [{ ...sampleResult.rows[0], name: 'gemma3:12b', alsoTagged: ['gemma3:latest'] }],
      },
      { color: false }
    );
    expect(out).toContain(':latest');
    expect(out).not.toContain('gemma3:latest');
  });

  it('never repeats a long collapsed name — only its tag, however long the base is', () => {
    // Regression for the guardrail defect: a shared HF repo name rendered twice
    // (once as the row's own name, once inside the sibling-tag parens) padded
    // every other row in the section out past 170 columns.
    const longName = 'hf.co/yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF';
    const out = formatCheckTable(
      {
        ...sampleResult,
        rows: [
          {
            ...sampleResult.rows[0],
            name: `${longName}:Q4_K_M`,
            alsoTagged: [`${longName}:latest`],
          },
        ],
      },
      { color: false }
    );
    const occurrences = out.split(longName).length - 1;
    expect(occurrences).toBe(1);
    expect(out).toContain(':latest');
  });

  it('ranks PULLABLE rows by downloads, not footprint size', () => {
    // Sized so bySizeDesc and byDownloadsDesc disagree completely — this must
    // fail if orderRows falls back to sorting PULLABLE by footprint.
    const base = { ...sampleResult.rows[0], source: 'remote' as const, fit: 'comfortable' as const };
    const rows: CheckRow[] = [
      {
        ...base,
        name: 'big-but-unpopular',
        footprintGb: 10,
        signals: { downloads: 100, likes: 0, trendingScore: 0, lastModified: null },
      },
      {
        ...base,
        name: 'mid-mid',
        footprintGb: 5,
        signals: { downloads: 500_000, likes: 0, trendingScore: 0, lastModified: null },
      },
      {
        ...base,
        name: 'small-but-popular',
        footprintGb: 2,
        signals: { downloads: 5_000_000, likes: 0, trendingScore: 0, lastModified: null },
      },
    ];
    const out = formatCheckTable({ ...sampleResult, rows }, { color: false });
    const order = out
      .split('\n')
      .filter((l) => l.includes(' dl'))
      .map((l) => l.trim().split(/\s{2,}/)[0]);
    expect(order).toEqual(['small-but-popular', 'mid-mid', 'big-but-unpopular']);
  });

  it('renders both recommendation lines when both sides qualify', () => {
    const out = formatCheckTable(
      {
        ...sampleResult,
        recommendations: {
          runNow: 'gemma3:12b',
          runNowBigger: 'gemma3:27b',
          worthPulling: 'ornith-ai/Ornith-1.0-9B-GGUF',
        },
      },
      { color: false }
    );
    expect(out).toContain('Run now');
    expect(out).toContain('gemma3:27b');
    expect(out).toContain('Worth pulling');
    expect(out).toContain('ornith-ai/Ornith-1.0-9B-GGUF');
  });

  it('omits a recommendation line whose side is empty', () => {
    const out = formatCheckTable(
      {
        ...sampleResult,
        recommendations: { runNow: 'gemma3:12b', runNowBigger: null, worthPulling: null },
      },
      { color: false }
    );
    expect(out).toContain('Run now');
    expect(out).not.toContain('Worth pulling');
  });

  it('says so plainly when a side is empty', () => {
    const out = formatCheckTable(
      {
        ...sampleResult,
        rows: [],
        recommendations: { runNow: null, runNowBigger: null, worthPulling: null },
      },
      { color: false }
    );
    expect(out).toContain('No models pulled yet');
    expect(out).toContain('No remote candidates found');
  });

  it('still pins --backend in the bench hint', () => {
    const out = formatCheckTable(
      { ...sampleResult, recommendations: { runNow: 'gemma3:12b', runNowBigger: null, worthPulling: null } },
      { color: false, backendId: 'ollama' }
    );
    expect(out).toContain('llamafit bench gemma3:12b --backend ollama');
  });
});

describe('group labels', () => {
  // comfortable, pressured, and over-budget are already exercised elsewhere
  // (sampleResult's row is pressured; the recommendation tests hit
  // over-budget). tight, will-thrash, and unclassified had no coverage at all.

  it("labels 'tight' with the baseline safe-budget figure it's close to", () => {
    const out = formatCheckTable(
      {
        ...sampleResult,
        rows: [
          {
            ...sampleResult.rows[0],
            baselineVerdict: 'tight',
            currentVerdict: 'tight',
            fit: 'tight',
          },
        ],
      },
      { color: false }
    );
    // baselineHeadroomGb is 16 in sampleResult — the label must interpolate it,
    // not print a static string.
    expect(out).toContain('tight · close to the 16.0G safe budget');
  });

  it("labels 'will-thrash' plainly as not fitting — the highest-stakes claim in the table", () => {
    const out = formatCheckTable(
      {
        ...sampleResult,
        rows: [
          {
            ...sampleResult.rows[0],
            baselineVerdict: 'will-thrash',
            currentVerdict: 'will-thrash',
            fit: 'will-thrash',
          },
        ],
      },
      { color: false }
    );
    expect(out).toContain("won't fit");
  });

  it("labels 'unclassified' as a size the backend didn't report", () => {
    const out = formatCheckTable(
      {
        ...sampleResult,
        rows: [
          {
            ...sampleResult.rows[0],
            parameterSizeB: null,
            quantizationLevel: null,
            footprintGb: null,
            baselineVerdict: 'unknown',
            currentVerdict: 'unknown',
            fit: 'unclassified',
          },
        ],
      },
      { color: false }
    );
    expect(out).toContain("unclassified · backend didn't report a size");
  });
});

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
