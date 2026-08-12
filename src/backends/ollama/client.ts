import { lookupQuant, type QuantTable } from '../../data.js';
import { splitModelTag } from '../../model-names.js';

// OLLAMA_HOST is documented as either `host:port` or a full URL, so only add a
// scheme when there isn't one already (otherwise `http://http://host:port`).
export const OLLAMA_BASE_URL = process.env.OLLAMA_HOST
  ? process.env.OLLAMA_HOST.startsWith('http')
    ? process.env.OLLAMA_HOST
    : `http://${process.env.OLLAMA_HOST}`
  : 'http://localhost:11434';

export interface OllamaModelDetails {
  parent_model: string;
  format: string;
  family: string;
  families: string[] | null;
  parameter_size: string;
  quantization_level: string;
  context_length?: number;
  embedding_length?: number;
}

export interface OllamaTagsModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details: OllamaModelDetails;
  capabilities: string[];
  remote_host?: string;
  remote_model?: string;
}

export interface OllamaTagsResponse {
  models: OllamaTagsModel[];
}

export interface OllamaPsModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  details: OllamaModelDetails;
  expires_at: string;
  size_vram: number;
  context_length: number;
}

export interface OllamaPsResponse {
  models: OllamaPsModel[];
}

export interface OllamaGenerateResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  done_reason?: string;
  eval_count?: number;
  eval_duration?: number;
  load_duration?: number;
  total_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
}

export function isCloudModel(model: OllamaTagsModel): boolean {
  return typeof model.remote_host === 'string' && model.remote_host.length > 0;
}

/** Ollama signals "no quantization reported" two ways: an empty string and the
 * literal string 'unknown'. Both must collapse to null so the row renders `?`
 * and the estimator uses its fallback — treating 'unknown' as a quant *name*
 * raises an unknown-quant gap whose agent prompt asks for a bytes-per-param
 * value for the concept "unknown", which has none. Add to this set if another
 * backend invents its own sentinel ('none', 'N/A'). */
const NOT_REPORTED_QUANTS: ReadonlySet<string> = new Set(['', 'unknown']);

export function normalizeQuant(raw: string | undefined | null): string | null {
  const trimmed = (raw ?? '').trim();
  return NOT_REPORTED_QUANTS.has(trimmed.toLowerCase()) ? null : trimmed;
}

/** Ollama pulls HF repos as `hf.co/<owner>/<repo>:<quant>`, so the tag names the
 * quantization when the manifest doesn't report one. Gated on the tag actually
 * matching a known entry or alias, which is what makes it safe to try on every
 * name: `gemma3:12b` and `…-mlx:4bit` simply don't match and fall through. */
export function quantFromTag(name: string, table: QuantTable): string | null {
  const { tag } = splitModelTag(name);
  if (tag === null) return null;
  const { id, known } = lookupQuant(table, tag);
  return known ? id : null;
}

/** Official models live at ollama.com/library/<name>; community uploads are namespaced
 * as ollama.com/<user>/<name>, distinguishable by the presence of a `/` in the name. */
export function modelPageUrl(name: string): string {
  const base = name.includes(':') ? name.slice(0, name.lastIndexOf(':')) : name;
  return base.includes('/') ? `https://ollama.com/${base}` : `https://ollama.com/library/${base}`;
}

/** Returns billions of parameters, or null if unparseable/empty. */
export function parseParameterSize(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const suffixMatch = trimmed.match(/^([\d.]+)\s*([BbMmKk])$/);
  if (suffixMatch) {
    const value = parseFloat(suffixMatch[1]);
    const suffix = suffixMatch[2].toUpperCase();
    if (suffix === 'B') return value;
    if (suffix === 'M') return value / 1000;
    return value / 1_000_000; // K
  }

  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) / 1e9;
  }

  return null;
}

async function ollamaRequest(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}${path}`, init);
  } catch (err) {
    throw new Error(
      `Could not reach Ollama server at ${OLLAMA_BASE_URL} — is 'ollama serve' running? (${(err as Error).message})`
    );
  }
  if (!res.ok) {
    throw new Error(`Ollama server returned ${res.status} for ${path}`);
  }
  return res;
}

async function ollamaFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await ollamaRequest(path, init);
  return res.json() as Promise<T>;
}

export async function fetchTags(): Promise<OllamaTagsResponse> {
  return ollamaFetch<OllamaTagsResponse>('/api/tags');
}

export async function fetchPs(): Promise<OllamaPsResponse> {
  return ollamaFetch<OllamaPsResponse>('/api/ps');
}

/** Returns null if the request times out (a meaningful result, not an error). */
export async function generate(
  model: string,
  prompt: string,
  timeoutMs = 90_000
): Promise<OllamaGenerateResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Ollama server returned ${res.status} for /api/generate`);
    }
    return (await res.json()) as OllamaGenerateResponse;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return null;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function unloadModel(model: string): Promise<void> {
  await ollamaRequest('/api/generate', {
    method: 'POST',
    body: JSON.stringify({ model, keep_alive: 0 }),
  });
}

type PullExec = (cmd: string, args: string[]) => Promise<unknown>;

async function realPullExec(cmd: string, args: string[]): Promise<unknown> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  return execFileAsync(cmd, args, { maxBuffer: 1024 * 1024 * 50 });
}

/** `ollama pull` and llama-server's HF pull disagree on how to name a Hugging Face
 * repo: Ollama wants `hf.co/<owner>/<repo>`, llama-server takes the bare
 * `<owner>/<repo>`. A bare repoId copied from llama-server's remote candidates (or
 * llamafit check's llama-server table) and pasted into `bench` while Ollama is the
 * resolved backend fails with the CLI's raw "pull model manifest: file does not
 * exist" — accurate but useless unless you already know about the prefix mismatch.
 * Recognize that specific failure shape and point at the fix. */
function hintPullError(model: string, err: Error): Error {
  const looksLikeRepoId = model.includes('/') && !model.startsWith('hf.co/');
  if (!looksLikeRepoId || !/manifest/i.test(err.message)) return err;
  return new Error(
    `${err.message}\n'${model}' looks like a Hugging Face repo id — Ollama pulls those as 'hf.co/${model}'. ` +
      `If you copied this name from llama-server's remote candidates, try that prefix, or re-run with --backend llama-server.`
  );
}

export function createPullModel(exec: PullExec = realPullExec) {
  return async function pullModel(model: string): Promise<void> {
    try {
      await exec('ollama', ['pull', model]);
    } catch (err) {
      throw hintPullError(model, err as Error);
    }
  };
}

export const pullModel = createPullModel();
