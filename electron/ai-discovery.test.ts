import { describe, expect, it } from 'vitest';
import { parseArtistNameList } from './ai-discovery.js';

describe('AI discovery name parsing', () => {
  it('accepts plain and numbered artist names without explanation text', () => {
    expect(parseArtistNameList('1. Chima Anya\n- Little Simz\nChima Anya\nArtists:')).toEqual(['Chima Anya', 'Little Simz']);
  });
});
