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

/** Quant token at the end of a .gguf filename, optionally sharded
 * (-00001-of-00002). Covers Q/IQ/TQ families, floats, MXFP4, and unsloth's
 * UD- dynamic quants. Unparseable names are skipped, never guessed. */
const QUANT_RE = /[-._]((?:UD-)?(?:I?Q|TQ)\d[A-Z0-9_]*|F16|F32|BF16|MXFP4)(?:-\d{5}-of-\d{5})?\.gguf$/i;

export function parseQuantsFromSiblings(filenames: string[]): string[] {
  const quants: string[] = [];
  for (const name of filenames) {
    // mmproj files are multimodal projectors riding along in the repo; their
    // F16/BF16 token describes the projector, not the model. Match on the
    // basename so subdirectory paths (e.g. subdir/mmproj-F16.gguf) are
    // still excluded.
    const basename = name.split('/').pop() ?? name;
    if (basename.startsWith('mmproj')) continue;
    const match = QUANT_RE.exec(name);
    if (!match) continue;
    const quant = match[1].toUpperCase();
    if (!quants.includes(quant)) quants.push(quant);
  }
  return quants;
}

export interface HfSignals {
  downloads: number | null;
  likes: number | null;
  trendingScore: number | null;
  lastModified: string | null;
}

export interface HfModelHit {
  id: string;
  gguf?: { total?: number } | null;
  siblings?: { rfilename: string }[] | null;
  downloads?: number;
  likes?: number;
  trendingScore?: number;
  lastModified?: string;
}

export interface HfCandidate {
  repoId: string;
  author: string;
  url: string;
  parameterSizeB: number | null;
  availableQuants: string[];
  signals: HfSignals;
}

export function mapHitToCandidate(hit: HfModelHit): HfCandidate {
  const total = hit.gguf?.total;
  return {
    repoId: hit.id,
    author: hit.id.split('/')[0],
    url: `${HF_BASE_URL}/${hit.id}`,
    // For MoE repos gguf.total is total params, not active — accepted
    // approximation, consistent with localModels() reporting meta.n_params.
    parameterSizeB: typeof total === 'number' ? total / 1e9 : null,
    availableQuants: parseQuantsFromSiblings((hit.siblings ?? []).map((s) => s.rfilename)),
    signals: {
      downloads: hit.downloads ?? null,
      likes: hit.likes ?? null,
      trendingScore: hit.trendingScore ?? null,
      lastModified: hit.lastModified ?? null,
    },
  };
}

export async function searchGgufModels(
  query: string,
  opts: HfDiscoveryOptions = {}
): Promise<HfCandidate[]> {
  const url = buildModelsUrl(query, opts);
  const res = await fetch(url);
  if (res.status === 429) {
    throw new Error(
      'Hugging Face API rate limit hit (anonymous: 500 requests per 5 minutes) — wait and retry'
    );
  }
  if (!res.ok) {
    throw new Error(`Hugging Face API returned ${res.status} for ${url}`);
  }
  const hits = await res.json();
  if (!Array.isArray(hits)) {
    throw new Error(`Hugging Face API returned unexpected non-array JSON for ${url}`);
  }
  return (hits as HfModelHit[]).map(mapHitToCandidate);
}
