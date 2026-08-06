import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir, homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBundle, writeDiagnosticsBundle } from '../src/diagnostics.js';

const input = {
  version: '0.1.0',
  platform: { platform: 'freebsd', release: '14.0', arch: 'arm64' },
  gaps: [{ kind: 'unsupported-platform' as const, summary: 'no SystemProbe for freebsd', evidence: { platform: 'freebsd' } }],
  probeEvidence: { 'some-command': `output mentioning ${homedir()} and ${hostname()}` },
};

describe('diagnostics bundle', () => {
  it('serializes version, platform, gaps, and evidence', () => {
    const bundle = JSON.parse(buildBundle(input));
    expect(bundle.version).toBe('0.1.0');
    expect(bundle.gaps).toHaveLength(1);
    expect(bundle.probeEvidence['some-command']).toContain('output mentioning');
  });
  it('scrubs home directory and hostname', () => {
    const text = buildBundle(input);
    expect(text).not.toContain(homedir());
    if (hostname().length > 0) expect(text).not.toContain(hostname());
    expect(text).toContain('~');
  });
  it('writes a timestamped file and returns its path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llamafit-test-'));
    const path = writeDiagnosticsBundle(input, { dir, now: new Date('2026-08-05T14:30:00') });
    expect(path).toBe(join(dir, 'llamafit-diagnostics-20260805-143000.json'));
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe('0.1.0');
  });
});
