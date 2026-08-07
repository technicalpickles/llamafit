/** Shared Hugging Face Hub discovery client. llama-server consumes it today;
 * the ollama backend is a tracked fast-follow (as a second source alongside
 * its ollama.com scrape). Query shapes here were live-verified — see the
 * "API facts verified live" section of
 * docs/superpowers/specs/2026-08-07-llama-server-remote-candidates-design.md. */

export const HF_BASE_URL = 'https://huggingface.co';

export interface HfDiscoveryOptions {
  maxParameterSizeB?: number;
  limit?: number;
}

export function buildModelsUrl(query: string, opts: HfDiscoveryOptions = {}): string {
  const params = new URLSearchParams();
  if (query.length > 0) params.set('search', query);
  params.set('filter', 'gguf');
  params.set('pipeline_tag', 'text-generation');
  if (opts.maxParameterSizeB !== undefined) {
    // Raw integer form only — num_parameters=max:16000000000. Decimal "B"
    // suffixes were never live-verified against the API.
    params.set('num_parameters', `max:${Math.floor(opts.maxParameterSizeB * 1e9)}`);
  }
  // trendingScore, not the web UI's "trending" (that spelling returns HTTP 400).
  params.set('sort', 'trendingScore');
  params.set('limit', String(opts.limit ?? 10));
  // expand[] REPLACES the default field set, so everything needed downstream
  // must be requested explicitly.
  for (const field of ['gguf', 'siblings', 'downloads', 'likes', 'lastModified', 'trendingScore']) {
    params.append('expand[]', field);
  }
  return `${HF_BASE_URL}/api/models?${params.toString()}`;
}
