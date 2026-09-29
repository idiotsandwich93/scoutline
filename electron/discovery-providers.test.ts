import { describe, expect, it } from 'vitest';
import { parseLastFmArtists, parseListenBrainzArtists, resolveSpotifyIdsFromListenBrainz, resolveSpotifyIdsFromWikidata, validateLastFmApiKey } from './discovery-providers';

describe('free discovery providers', () => {
  it('deduplicates ListenBrainz artists and removes the seed', () => {
    const artists = parseListenBrainzArtists({
      seed: [{ similar_artist_mbid: 'seed', similar_artist_name: 'Seed', total_listen_count: 9 }],
      one: [{ similar_artist_mbid: 'one', similar_artist_name: 'Artist One', total_listen_count: 3 }],
      duplicate: [{ similar_artist_mbid: 'one', similar_artist_name: 'Artist One', total_listen_count: 12 }],
    }, 'seed');
    expect(artists).toEqual([{ name: 'Artist One', musicBrainzId: 'one', listens: 12 }]);
  });

  it('parses Last.fm similarity values', () => {
    expect(parseLastFmArtists({ similarartists: { artist: [{ name: 'Artist Two', mbid: 'two', match: '0.82' }] } })).toEqual([
      { name: 'Artist Two', musicBrainzId: 'two', similarity: 0.82 },
    ]);
  });

  it('rejects a Last.fm API error during connection', async () => {
    const fetcher = async () => new Response(JSON.stringify({ error: 10, message: 'Invalid API key' }), { status: 200, headers: { 'content-type': 'application/json' } });
    await expect(validateLastFmApiKey('bad-key', fetcher as typeof fetch)).rejects.toThrow('Invalid API key');
  });

  it('maps MusicBrainz identities to Spotify IDs through Wikidata', async () => {
    const fetcher = async () => new Response(JSON.stringify({ results: { bindings: [{ mbid: { value: '11111111-1111-1111-1111-111111111111' }, spotify: { value: 'spotify-id' } }] } }), { status: 200 });
    const result = await resolveSpotifyIdsFromWikidata(['11111111-1111-1111-1111-111111111111'], fetcher as typeof fetch);
    expect(result.get('11111111-1111-1111-1111-111111111111')).toBe('spotify-id');
  });

  it('bulk maps MusicBrainz identities through ListenBrainz metadata and Wikidata entities', async () => {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('api.listenbrainz.org/1/metadata/artist')) return new Response(JSON.stringify([{
        artist_mbid: '22222222-2222-2222-2222-222222222222',
        rels: { wikidata: 'https://www.wikidata.org/wiki/Q42' },
      }]), { status: 200 });
      return new Response(JSON.stringify({ entities: { Q42: { claims: { P1902: [{ mainsnak: { datavalue: { value: 'spotifybulk123' } } }] } } } }), { status: 200 });
    };
    const result = await resolveSpotifyIdsFromListenBrainz(['22222222-2222-2222-2222-222222222222'], fetcher as typeof fetch);
    expect(result.get('22222222-2222-2222-2222-222222222222')).toBe('spotifybulk123');
  });
});
