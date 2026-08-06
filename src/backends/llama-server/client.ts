// LLAMA_SERVER_BASE_URL accepts either `host:port` or a full URL (same contract
// as OLLAMA_HOST), so only add a scheme when there isn't one already.
export const LLAMA_SERVER_BASE_URL = process.env.LLAMA_SERVER_BASE_URL
  ? process.env.LLAMA_SERVER_BASE_URL.startsWith('http')
    ? process.env.LLAMA_SERVER_BASE_URL
    : `http://${process.env.LLAMA_SERVER_BASE_URL}`
  : 'http://localhost:8080';

/** GGUF metadata on a /models entry. Present only after the model has been
 * loaded at least once this server lifetime; disappears again after unload. */
export interface LlamaServerModelMeta {
  vocab_type: number;
  n_vocab: number;
  n_ctx: number;
  n_ctx_train: number;
  n_embd: number;
  n_params: number;
  size: number;
  ftype: string;
}

export interface LlamaServerModelStatus {
  value: string; // "unloaded" | "loading" | "loaded" | "sleeping" | "downloading"
  args?: string[];
  preset?: string;
}

export interface LlamaServerModel {
  id: string;
  object: string;
  owned_by: string;
  created: number;
  status: LlamaServerModelStatus;
  source?: string;
  can_remove?: boolean;
  meta?: LlamaServerModelMeta;
}

export interface LlamaServerModelsResponse {
  data: LlamaServerModel[];
  object: string;
}

export interface LlamaServerCompletionTimings {
  cache_n: number;
  prompt_n: number;
  prompt_ms: number;
  prompt_per_second: number;
  predicted_n: number;
  predicted_ms: number;
  predicted_per_second: number;
}

export interface LlamaServerCompletionResponse {
  content: string;
  model: string;
  stop: boolean;
  timings: LlamaServerCompletionTimings;
}

export interface LlamaServerPropsResponse {
  build_info?: string;
  role?: string;
  model_path?: string;
}

interface LlamaServerErrorBody {
  error?: { message?: string; type?: string; code?: number };
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as LlamaServerErrorBody;
    return body.error?.message ? ` (${body.error.message})` : '';
  } catch {
    return '';
  }
}

async function llamaServerRequest(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${LLAMA_SERVER_BASE_URL}${path}`, init);
  } catch (err) {
    throw new Error(
      `Could not reach llama-server at ${LLAMA_SERVER_BASE_URL} — is 'llama-server' running? (${(err as Error).message})`
    );
  }
  if (!res.ok) {
    throw new Error(`llama-server returned ${res.status} for ${path}${await errorDetail(res)}`);
  }
  return res;
}

async function llamaServerFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await llamaServerRequest(path, init);
  return res.json() as Promise<T>;
}

export async function fetchModels(): Promise<LlamaServerModelsResponse> {
  return llamaServerFetch<LlamaServerModelsResponse>('/models');
}

export async function fetchProps(): Promise<LlamaServerPropsResponse> {
  return llamaServerFetch<LlamaServerPropsResponse>('/props');
}

/** Returns null if the request times out (a meaningful result, not an error).
 * Router mode auto-loads the model on first use; that latency is part of the
 * request, so timeoutMs must cover a cold load. */
export async function completion(
  model: string,
  prompt: string,
  timeoutMs = 90_000
): Promise<LlamaServerCompletionResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${LLAMA_SERVER_BASE_URL}/completion`, {
      method: 'POST',
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`llama-server returned ${res.status} for /completion${await errorDetail(res)}`);
    }
    return (await res.json()) as LlamaServerCompletionResponse;
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
  await llamaServerRequest('/models/unload', {
    method: 'POST',
    body: JSON.stringify({ model }),
  });
}
