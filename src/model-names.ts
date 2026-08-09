/** Model-name parsing shared across backends. Both Ollama and llama-server name
 * models `<base>:<tag>`, and two callers need the same answer to "is that colon
 * a tag separator?" — one to read the tag (quantFromTag), one to strip it
 * (check.ts's untagged, for local/remote dedup). One rule, one place. */

export function splitModelTag(name: string): { base: string; tag: string | null } {
  const colon = name.lastIndexOf(':');
  if (colon === -1) return { base: name, tag: null };
  const tag = name.slice(colon + 1);
  // Empty means a trailing colon; a slash means we're looking at a path segment.
  if (tag.length === 0 || tag.includes('/')) return { base: name, tag: null };
  return { base: name.slice(0, colon), tag };
}
