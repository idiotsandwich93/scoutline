import { describe, expect, it } from 'vitest';
import { inferMapping, mergeArtists, parseCsv, rowsToArtists } from './csv';

describe('CSV imports', () => {
  it('parses quoted commas and infers common Chartmetric columns', () => {
    const parsed = parseCsv('Artist Name,Chartmetric ID,Monthly Listeners,Location\n"Mira, Vale",cm-12,"125,000","Brooklyn, NY"');
    const mapping = inferMapping(parsed.headers);
    const artists = rowsToArtists(parsed, mapping, 'Chartmetric CSV');
    expect(artists[0].name).toBe('Mira, Vale');
    expect(artists[0].chartmetricId).toBe('cm-12');
    expect(artists[0].monthlyListeners).toBe(125000);
    expect(artists[0].location).toBe('Brooklyn, NY');
  });

  it('merges duplicate identities by durable platform ID', () => {
    const first = rowsToArtists(parseCsv('name,spotify_id,email\nArtist One,spotify-1,first@example.com'), { 0: 'name', 1: 'spotifyId', 2: 'email' }, 'First CSV');
    const second = rowsToArtists(parseCsv('name,spotify_id,instagram\nArtist 1,spotify-1,https://instagram.com/artistone'), { 0: 'name', 1: 'spotifyId', 2: 'instagramUrl' }, 'Second CSV');
    const result = mergeArtists(first, second);
    expect(result.artists).toHaveLength(1);
    expect(result.merged).toBe(1);
    expect(result.artists[0].email).toBe('first@example.com');
    expect(result.artists[0].instagramHandle).toBe('@artistone');
  });
});
