import { readFileSync } from 'node:fs';
import type { Gap, GapKind } from './gaps.js';

export interface PromptContext {
  bundlePath: string;
  repoUrl: string;
}

type PackageJson = {
  repository?: string | { url?: string };
};

const MAX_ISSUE_BODY_LENGTH = 4000;

export function repoUrl(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(raw) as PackageJson;
  const repository = pkg.repository;
  const url = typeof repository === 'string' ? repository : repository?.url;
  if (!url) throw new Error('package.json is missing a "repository" field');
  return url.replace(/^git\+/, '').replace(/\.git$/, '');
}

function unsupportedPlatformPrompt(gap: Gap, ctx: PromptContext): string {
  return `Clone ${ctx.repoUrl} and add support for my platform.
My machine produced this diagnostics bundle: ${ctx.bundlePath} — it contains the raw
command outputs (or failures) from the memory probe attempt.
Implement the SystemProbe interface for this platform. Reference implementation:
src/probes/darwin.ts. Interface contract and fixture conventions: docs/adapters.md.
Add fixtures from the bundle's raw outputs, register the probe in
src/probes/registry.ts, run the conformance tests, and open a PR.`;
}

function unknownQuantPrompt(gap: Gap, ctx: PromptContext): string {
  return `Clone ${ctx.repoUrl}. My models use a quantization llamafit doesn't know: see the
unknown-quant gap in ${ctx.bundlePath}.
Add an entry or alias for it to data/quants.json with a bytes-per-param value,
citing a source for the value in the PR body. See docs/adapters.md ("Quantization
table") for the format, then run the tests and open a PR.`;
}

function noBackendDetectedPrompt(gap: Gap, ctx: PromptContext): string {
  return `Clone ${ctx.repoUrl}. llamafit found no supported inference backend on my machine: see
the no-backend-detected gap in ${ctx.bundlePath} for what it probed.
If I'm running a backend it should know (check the bundle evidence), implement the
Backend interface for it. Reference implementation: src/backends/ollama/. Contract
and fixture conventions: docs/adapters.md. Register it in src/backends/registry.ts,
run the conformance tests, and open a PR.`;
}

function unexpectedResponsePrompt(gap: Gap, ctx: PromptContext): string {
  return `Clone ${ctx.repoUrl}. llamafit hit a response it couldn't handle: see the ${gap.kind} gap in
${ctx.bundlePath} for the raw response.
Fix the parsing (or add graceful handling) where the gap's evidence points, add a
fixture reproducing my response, run the tests, and open a PR.`;
}

const TEMPLATES: Record<GapKind, (gap: Gap, ctx: PromptContext) => string> = {
  'unsupported-platform': unsupportedPlatformPrompt,
  'unknown-quant': unknownQuantPrompt,
  'no-backend-detected': noBackendDetectedPrompt,
  'backend-response-unexpected': unexpectedResponsePrompt,
  'scrape-failed': unexpectedResponsePrompt,
};

export function agentPromptFor(gap: Gap, ctx: PromptContext): string {
  return TEMPLATES[gap.kind](gap, ctx);
}

export function issueUrlFor(gap: Gap, ctx: { repoUrl: string }): string {
  const title = `[${gap.kind}] ${gap.summary}`;
  let body = `${gap.kind}\n\n${gap.summary}\n\n\`\`\`json\n${JSON.stringify(gap.evidence, null, 2)}\n\`\`\`\n`;
  if (body.length > MAX_ISSUE_BODY_LENGTH) body = body.slice(0, MAX_ISSUE_BODY_LENGTH);
  return `${ctx.repoUrl}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
