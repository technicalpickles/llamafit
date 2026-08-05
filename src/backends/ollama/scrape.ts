import * as cheerio from 'cheerio';

export interface RemoteModelCandidate {
  name: string;
  url: string;
  description: string;
  parameterSizeB: number | null;
  sizeSource: 'badge' | 'name-heuristic' | 'unknown';
}

function parseSizeBadgeText(text: string): number | null {
  const match = text.trim().match(/^([\d.]+)\s*([BbMm])$/);
  if (!match) return null;
  const value = parseFloat(match[1]);
  return match[2].toUpperCase() === 'B' ? value : value / 1000;
}

function parseSizeFromName(name: string): number | null {
  const match = name.match(/(\d+(?:\.\d+)?)[Bb]\b/);
  return match ? parseFloat(match[1]) : null;
}

export function parseSearchResults(html: string): RemoteModelCandidate[] {
  const $ = cheerio.load(html);
  const results: RemoteModelCandidate[] = [];

  $('a.group.w-full').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    const name = href.startsWith('/library/') ? href.slice('/library/'.length) : href.slice(1);
    const url = `https://ollama.com${href}`;
    const description = $(el).find('p.max-w-lg').first().text().trim();
    const badgeText = $(el).find('span.text-blue-600').first().text().trim();
    const badgeSize = badgeText.length > 0 ? parseSizeBadgeText(badgeText) : null;

    if (badgeSize !== null) {
      results.push({ name, url, description, parameterSizeB: badgeSize, sizeSource: 'badge' });
      return;
    }

    const nameSize = parseSizeFromName(name);
    results.push({
      name,
      url,
      description,
      parameterSizeB: nameSize,
      sizeSource: nameSize !== null ? 'name-heuristic' : 'unknown',
    });
  });

  return results;
}

export async function scrapeSearch(query: string): Promise<RemoteModelCandidate[]> {
  const res = await fetch(`https://ollama.com/search?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) {
    throw new Error(`ollama.com/search returned ${res.status}`);
  }
  const html = await res.text();
  return parseSearchResults(html);
}
