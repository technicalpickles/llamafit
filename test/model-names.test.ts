import { describe, it, expect } from 'vitest';
import { splitModelTag } from '../src/model-names.js';

describe('splitModelTag', () => {
  it('splits a normal tagged name', () => {
    expect(splitModelTag('gemma3:12b')).toEqual({ base: 'gemma3', tag: '12b' });
    expect(splitModelTag('hf.co/o/r:Q4_K_M')).toEqual({ base: 'hf.co/o/r', tag: 'Q4_K_M' });
  });

  it('reports no tag when there is no colon', () => {
    expect(splitModelTag('mistrallite')).toEqual({ base: 'mistrallite', tag: null });
  });

  it('does not treat a colon followed by a path as a tag', () => {
    // A slash after the last colon means we're looking at a path segment.
    expect(splitModelTag('hf.co/owner:weird/repo')).toEqual({
      base: 'hf.co/owner:weird/repo',
      tag: null,
    });
  });

  it('reports no tag for a trailing colon', () => {
    expect(splitModelTag('gemma3:')).toEqual({ base: 'gemma3:', tag: null });
  });
});
