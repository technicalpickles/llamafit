import { describe, expect, it } from 'vitest';
import { agentPromptFor, issueUrlFor, repoUrl } from '../src/prompts.js';

const gap = { kind: 'unsupported-platform' as const, summary: 'no SystemProbe for freebsd', evidence: { platform: 'freebsd' } };
const ctx = { bundlePath: '/tmp/llamafit-diagnostics-20260805-143000.json', repoUrl: 'https://github.com/technicalpickles/llamafit' };

describe('contribution prompts', () => {
  it('repoUrl comes from package.json and is a clean https URL', () => {
    expect(repoUrl()).toMatch(/^https:\/\/github\.com\//);
    expect(repoUrl()).not.toMatch(/\.git$|^git\+/);
  });
  it('unsupported-platform prompt names the interface, reference impl, and bundle', () => {
    const prompt = agentPromptFor(gap, ctx);
    expect(prompt).toContain('SystemProbe');
    expect(prompt).toContain('src/probes/darwin.ts');
    expect(prompt).toContain(ctx.bundlePath);
    expect(prompt).toContain('docs/adapters.md');
  });
  it('unknown-quant prompt points at data/quants.json', () => {
    const prompt = agentPromptFor({ ...gap, kind: 'unknown-quant' }, ctx);
    expect(prompt).toContain('data/quants.json');
  });
  it('issue URL encodes title and evidence', () => {
    const url = issueUrlFor(gap, { repoUrl: ctx.repoUrl });
    expect(url).toContain('https://github.com/technicalpickles/llamafit/issues/new?');
    expect(url).toContain(encodeURIComponent('[unsupported-platform] no SystemProbe for freebsd'));
    expect(decodeURIComponent(url)).toContain('"platform": "freebsd"');
  });
  it('issue body is truncated for huge evidence', () => {
    const big = { ...gap, evidence: { blob: 'x'.repeat(20000) } };
    expect(issueUrlFor(big, { repoUrl: ctx.repoUrl }).length).toBeLessThan(9000);
  });
});
