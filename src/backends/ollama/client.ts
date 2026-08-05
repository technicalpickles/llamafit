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

export async function pullModel(model: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  await execFileAsync('ollama', ['pull', model], { maxBuffer: 1024 * 1024 * 50 });
}
