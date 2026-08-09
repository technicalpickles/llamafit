import type { PullProgress } from '../types.js';
import { sseEvents } from './sse.js';

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

interface DownloadFileProgress {
  done: number;
  total: number;
}

/** Bridges llama-server's async download API to pull()'s synchronous contract.
 * Subscribes to /models/sse BEFORE POSTing so a download that finishes quickly
 * can't complete before anyone is listening, then consumes events until
 * download_finished/download_failed. A stream that ends without a terminal
 * event (server shutdown, dropped connection) is an error — never a hang or a
 * silent success. No overall timeout: multi-GB downloads are legitimately slow. */
export async function pullModel(
  model: string,
  onProgress?: (p: PullProgress) => void
): Promise<string> {
  const sseRes = await llamaServerRequest('/models/sse');
  if (!sseRes.body) {
    throw new Error(`llama-server returned no body for /models/sse`);
  }
  // Progress arrives per file URL and models can download several files in
  // parallel; keep the latest per-file numbers and report the sums.
  const files: Record<string, DownloadFileProgress> = {};
  try {
    await llamaServerRequest('/models', { method: 'POST', body: JSON.stringify({ model }) });
    for await (const ev of sseEvents(sseRes.body)) {
      if (ev.model !== model) continue;
      if (ev.event === 'download_progress') {
        // The real payload wraps the per-file map in a `progress` key:
        // { progress: { <url>: {done, total} } }. Guard for it being absent
        // rather than assuming shape — captured live against llama-server
        // b10280, 2026-08-06.
        const progress = (ev.data as { progress?: Record<string, DownloadFileProgress> } | undefined)
          ?.progress;
        if (!progress) continue;
        Object.assign(files, progress);
        let doneBytes = 0;
        let totalBytes = 0;
        for (const file of Object.values(files)) {
          // Skip malformed entries rather than let a shape drift downstream
          // into a silent NaN (or, worse, string-concatenated garbage)
          // spinner — the exact failure mode of the `progress`-wrapper bug
          // fixed one level up.
          if (!Number.isFinite(file.done) || !Number.isFinite(file.total)) continue;
          doneBytes += file.done;
          totalBytes += file.total;
        }
        onProgress?.({ doneBytes, totalBytes });
      } else if (ev.event === 'download_failed') {
        throw new Error(`llama-server failed to download '${model}'`);
      } else if (ev.event === 'download_finished') {
        // Per the API docs, a GET /models after completion triggers the
        // router's model-list update so the new model shows up. But for a
        // nonexistent repo/quant, the router reports download_finished
        // (never download_failed) and then silently never adds the model —
        // captured live against llama-server b10280, 2026-08-06. Verify the
        // model actually landed before declaring success.
        //
        // A repo request with no quant suffix that has multiple GGUF files
        // doesn't necessarily land under the requested id either: the router
        // auto-picks a quant and registers the model as `<model>:<quant>` —
        // also captured live, same version/date. Accept that resolved id and
        // hand it back so callers use the id that actually exists for
        // subsequent generate/unload calls.
        const result = await fetchModels();
        const found = result.data.find((m) => m.id === model || m.id.startsWith(`${model}:`));
        if (!found) {
          throw new Error(
            `llama-server reported the download of '${model}' finished, but it never appeared in the model list — does that repo/quant exist?`
          );
        }
        return found.id;
      }
    }
    throw new Error(
      `llama-server event stream ended before '${model}' finished downloading`
    );
  } finally {
    // sseEvents cancels the stream when the for-await exits, but the POST can
    // throw before iteration ever starts — cancel here too (idempotent).
    await sseRes.body.cancel().catch(() => {});
  }
}
