export interface FreeDiscoveryCandidate {
  name: string;
  musicBrainzId?: string;
  score: number;
  hop: 1 | 2;
  sources: Array<'ListenBrainz' | 'Last.fm' | 'MusicBrainz'>;
  roots: number;
}

type FetchLike = typeof fetch;

type MusicBrainzSearchResponse = {
  artists?: Array<{ id?: string; name?: string; score?: number; disambiguation?: string }>;
};

type MusicBrainzArtistResponse = {
  tags?: Array<{ name?: string; count?: number }>;
};

type ListenBrainzRadioEntry = {
  similar_artist_mbid?: string;
  similar_artist_name?: string;
  total_listen_count?: number;
};

type ListenBrainzSimilarArtist = {
  artist_mbid?: string;
  name?: string;
  score?: number;
};

type ListenBrainzArtistMetadata = {
  artist_mbid?: string;
  mbid?: string;
  rels?: Record<string, string | string[]>;
};

type WikidataEntityResponse = {
  entities?: Record<string, {
    claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>>;
  }>;
};

type LastFmSimilarResponse = {
  similarartists?: {
    artist?: Array<{ name?: string; mbid?: string; match?: string }>;
  };
  error?: number;
  message?: string;
};

const userAgent = 'Scoutline/0.6.1 (personal desktop artist-discovery app)';

function normalizedName(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function getJson<T>(fetcher: FetchLike, url: string, timeoutMilliseconds = 9_000): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetcher(url, {
      headers: { Accept: 'application/json', 'User-Agent': userAgent },
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
    if (response.ok) return await response.json() as T;
    if ((response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) && attempt === 0) {
      const resetSeconds = Math.max(1, Number(response.headers.get('x-ratelimit-reset-in') || response.headers.get('retry-after')) || 2);
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, resetSeconds) * 1_000));
      continue;
    }
    throw new Error(`Discovery provider returned ${response.status}.`);
  }
  throw new Error('Discovery provider did not respond.');
}

export function parseListenBrainzArtists(payload: unknown, seedMusicBrainzId?: string): Array<{ name: string; musicBrainzId?: string; listens: number }> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const artists = new Map<string, { name: string; musicBrainzId?: string; listens: number }>();
  for (const value of Object.values(payload as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const rawEntry of value) {
      const entry = rawEntry as ListenBrainzRadioEntry;
      const name = entry.similar_artist_name?.trim();
      const musicBrainzId = entry.similar_artist_mbid?.trim();
      if (!name || (seedMusicBrainzId && musicBrainzId === seedMusicBrainzId)) continue;
      const key = musicBrainzId || normalizedName(name);
      const listens = Math.max(0, Number(entry.total_listen_count) || 0);
      const existing = artists.get(key);
      if (!existing || listens > existing.listens) artists.set(key, { name, musicBrainzId, listens });
    }
  }
  return [...artists.values()];
}

export function parseLastFmArtists(payload: LastFmSimilarResponse): Array<{ name: string; musicBrainzId?: string; similarity: number }> {
  if (payload.error) throw new Error(payload.message || 'Last.fm rejected the API key.');
  return (payload.similarartists?.artist || []).flatMap((artist) => {
    const name = artist.name?.trim();
    if (!name) return [];
    return [{ name, musicBrainzId: artist.mbid?.trim() || undefined, similarity: Math.max(0, Number(artist.match) || 0) }];
  });
}

async function resolveMusicBrainzArtist(seedName: string, fetcher: FetchLike): Promise<{ id: string; name: string } | undefined> {
  const query = encodeURIComponent(`artist:"${seedName.replaceAll('"', '')}"`);
  const payload = await getJson<MusicBrainzSearchResponse>(fetcher, `https://musicbrainz.org/ws/2/artist/?query=${query}&fmt=json&limit=5`);
  const exact = payload.artists?.find((artist) => normalizedName(artist.name || '') === normalizedName(seedName));
  const artist = exact || payload.artists?.at(0);
  return artist?.id && artist.name ? { id: artist.id, name: artist.name } : undefined;
}

const genericMusicTags = new Set(['music', 'pop', 'rock', 'rap', 'hip hop', 'hip-hop', 'r&b', 'dance', 'electronic', 'electronica', 'funk', 'soul', 'male vocalists', 'female vocalists']);

async function musicBrainzTagArtists(musicBrainzId: string, fetcher: FetchLike): Promise<Array<{ name: string; musicBrainzId: string; relevance: number; tag: string }>> {
  const seed = await getJson<MusicBrainzArtistResponse>(fetcher, `https://musicbrainz.org/ws/2/artist/${encodeURIComponent(musicBrainzId)}?inc=tags&fmt=json`);
  const rankedTags = (seed.tags || [])
    .flatMap((tag) => tag.name?.trim() ? [{ name: tag.name.trim(), count: Math.max(0, Number(tag.count) || 0) }] : [])
    .filter((tag) => tag.count >= 2 && !genericMusicTags.has(normalizedName(tag.name)))
    .sort((left, right) => right.count - left.count)
    .slice(0, 3);
  if (!rankedTags.length) return [];
  const artists: Array<{ name: string; musicBrainzId: string; relevance: number; tag: string }> = [];
  for (let index = 0; index < rankedTags.length; index += 1) {
    if (index) await new Promise((resolve) => setTimeout(resolve, 1_200));
    const tag = rankedTags[index];
    const query = encodeURIComponent(`tag:"${tag.name.replaceAll('"', '')}"`);
    const payload = await getJson<MusicBrainzSearchResponse>(fetcher, `https://musicbrainz.org/ws/2/artist/?query=${query}&fmt=json&limit=100`).catch(() => undefined);
    if (!payload) continue;
    for (const artist of payload.artists || []) {
      if (!artist.id || !artist.name || artist.id === musicBrainzId) continue;
      artists.push({ name: artist.name, musicBrainzId: artist.id, relevance: Math.max(0, Number(artist.score) || 0) + tag.count * 3, tag: tag.name });
    }
  }
  return artists;
}

async function listenBrainzSimilar(musicBrainzId: string, fetcher: FetchLike, mode: 'easy' | 'medium' | 'hard', popularityEnd: number): Promise<Array<{ name: string; musicBrainzId?: string; listens: number }>> {
  const url = `https://api.listenbrainz.org/1/lb-radio/artist/${encodeURIComponent(musicBrainzId)}?mode=${mode}&max_similar_artists=60&max_recordings_per_artist=1&pop_begin=0&pop_end=${popularityEnd}`;
  return parseListenBrainzArtists(await getJson<unknown>(fetcher, url), musicBrainzId);
}

async function listenBrainzDatasetSimilar(musicBrainzId: string, fetcher: FetchLike): Promise<Array<{ name: string; musicBrainzId?: string; similarity: number }>> {
  const parameters = new URLSearchParams({
    artist_mbids: musicBrainzId,
    algorithm: 'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30',
  });
  const payload = await getJson<ListenBrainzSimilarArtist[]>(fetcher, `https://labs.api.listenbrainz.org/similar-artists/json?${parameters}`, 12_000);
  return payload.flatMap((artist) => {
    const name = artist.name?.trim();
    if (!name || artist.artist_mbid === musicBrainzId) return [];
    return [{ name, musicBrainzId: artist.artist_mbid?.trim() || undefined, similarity: Math.max(0, Number(artist.score) || 0) }];
  });
}

async function lastFmSimilar(artistName: string, apiKey: string, fetcher: FetchLike, limit = 100): Promise<Array<{ name: string; musicBrainzId?: string; similarity: number }>> {
  const parameters = new URLSearchParams({ method: 'artist.getSimilar', artist: artistName, api_key: apiKey, format: 'json', autocorrect: '1', limit: String(limit) });
  return parseLastFmArtists(await getJson<LastFmSimilarResponse>(fetcher, `https://ws.audioscrobbler.com/2.0/?${parameters}`));
}

async function inBatches<T, R>(items: T[], size: number, operation: (item: T) => Promise<R>): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = [];
  for (let index = 0; index < items.length; index += size) results.push(...await Promise.allSettled(items.slice(index, index + size).map(operation)));
  return results;
}

export async function validateLastFmApiKey(apiKey: string, fetcher: FetchLike = fetch): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error('Enter the Last.fm API key.');
  const artists = await lastFmSimilar('Radiohead', trimmed, fetcher, 1);
  if (!artists.length) throw new Error('Last.fm accepted the request but returned no data. Check the API key.');
}

export async function resolveSpotifyIdsFromWikidata(musicBrainzIds: string[], fetcher: FetchLike = fetch): Promise<Map<string, string>> {
  const unique = [...new Set(musicBrainzIds.filter((value) => /^[0-9a-f-]{36}$/i.test(value)))].slice(0, 100);
  if (!unique.length) return new Map();
  const values = unique.map((value) => `"${value}"`).join(' ');
  const query = `SELECT ?mbid ?spotify WHERE { VALUES ?mbid { ${values} } ?item wdt:P434 ?mbid ; wdt:P1902 ?spotify . }`;
  const parameters = new URLSearchParams({ format: 'json', query });
  const payload = await getJson<{ results?: { bindings?: Array<{ mbid?: { value?: string }; spotify?: { value?: string } }> } }>(fetcher, `https://query.wikidata.org/sparql?${parameters}`, 8_000);
  return new Map((payload.results?.bindings || []).flatMap((binding) => {
    const musicBrainzId = binding.mbid?.value;
    const spotifyId = binding.spotify?.value;
    return musicBrainzId && spotifyId ? [[musicBrainzId, spotifyId] as const] : [];
  }));
}

export async function resolveSpotifyIdsFromListenBrainz(musicBrainzIds: string[], fetcher: FetchLike = fetch): Promise<Map<string, string>> {
  const unique = [...new Set(musicBrainzIds.filter((value) => /^[0-9a-f-]{36}$/i.test(value)))].slice(0, 500);
  if (!unique.length) return new Map();
  const musicBrainzIdByWikidataId = new Map<string, string>();
  const metadataRequests: Array<Promise<ListenBrainzArtistMetadata[]>> = [];
  for (let index = 0; index < unique.length; index += 50) {
    const metadataParameters = new URLSearchParams({ artist_mbids: unique.slice(index, index + 50).join(','), inc: 'artist' });
    metadataRequests.push(getJson<ListenBrainzArtistMetadata[]>(fetcher, `https://api.listenbrainz.org/1/metadata/artist/?${metadataParameters}`, 12_000));
  }
  for (const request of await Promise.allSettled(metadataRequests)) {
    if (request.status !== 'fulfilled') continue;
    const metadata = request.value;
    for (const artist of metadata) {
      const musicBrainzId = artist.artist_mbid || artist.mbid;
      if (!musicBrainzId) continue;
      const relationValues = Object.values(artist.rels || {}).flatMap((value) => Array.isArray(value) ? value : [value]);
      for (const relation of relationValues) {
        const wikidataId = relation.match(/wikidata\.org\/wiki\/(Q\d+)/i)?.[1]?.toUpperCase();
        if (wikidataId) musicBrainzIdByWikidataId.set(wikidataId, musicBrainzId);
      }
    }
  }
  const wikidataIds = [...musicBrainzIdByWikidataId.keys()];
  const spotifyIds = new Map<string, string>();
  const entityRequests: Array<Promise<WikidataEntityResponse>> = [];
  for (let index = 0; index < wikidataIds.length; index += 40) {
    const entityParameters = new URLSearchParams({ action: 'wbgetentities', ids: wikidataIds.slice(index, index + 40).join('|'), props: 'claims', format: 'json', origin: '*' });
    entityRequests.push(getJson<WikidataEntityResponse>(fetcher, `https://www.wikidata.org/w/api.php?${entityParameters}`, 10_000));
  }
  for (const request of await Promise.allSettled(entityRequests)) {
    if (request.status !== 'fulfilled') continue;
    const payload = request.value;
    for (const [wikidataId, entity] of Object.entries(payload.entities || {})) {
      const musicBrainzId = musicBrainzIdByWikidataId.get(wikidataId.toUpperCase());
      const spotifyId = entity.claims?.P1902?.map((claim) => claim.mainsnak?.datavalue?.value).find((value): value is string => typeof value === 'string' && /^[A-Za-z0-9]+$/.test(value));
      if (musicBrainzId && spotifyId) spotifyIds.set(musicBrainzId, spotifyId);
    }
  }
  return spotifyIds;
}

export async function discoverFreeCandidates(seedName: string, lastFmApiKey?: string, fetcher: FetchLike = fetch): Promise<FreeDiscoveryCandidate[]> {
  const seed = seedName.trim();
  if (!seed) throw new Error('Choose a seed artist first.');
  type DiscoverySource = 'ListenBrainz' | 'Last.fm' | 'MusicBrainz';
  type Accumulator = { name: string; musicBrainzId?: string; hop: 1 | 2; sources: Set<DiscoverySource>; roots: Set<string>; weight: number };
  const candidates = new Map<string, Accumulator>();
  const add = (name: string, musicBrainzId: string | undefined, hop: 1 | 2, source: DiscoverySource, root: string, weight: number) => {
    if (!name.trim() || normalizedName(name) === normalizedName(seed)) return;
    const key = musicBrainzId || normalizedName(name);
    const existing = candidates.get(key) || { name: name.trim(), musicBrainzId, hop, sources: new Set(), roots: new Set(), weight: 0 };
    existing.hop = Math.min(existing.hop, hop) as 1 | 2;
    existing.sources.add(source);
    existing.roots.add(root);
    existing.weight += Math.max(0, weight);
    if (!existing.musicBrainzId && musicBrainzId) existing.musicBrainzId = musicBrainzId;
    candidates.set(key, existing);
  };

  const musicBrainzSeed = await resolveMusicBrainzArtist(seed, fetcher).catch(() => undefined);
  let listenBrainzFirstHop: Array<{ name: string; musicBrainzId?: string; similarity: number }> = [];
  if (musicBrainzSeed) {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const taggedArtists = await musicBrainzTagArtists(musicBrainzSeed.id, fetcher).catch(() => []);
    for (const artist of taggedArtists) add(artist.name, artist.musicBrainzId, 1, 'MusicBrainz', `tag:${normalizedName(artist.tag)}`, artist.relevance);
    listenBrainzFirstHop = await listenBrainzDatasetSimilar(musicBrainzSeed.id, fetcher).catch(() => []);
    if (!listenBrainzFirstHop.length) {
      const radioFallback = await listenBrainzSimilar(musicBrainzSeed.id, fetcher, 'easy', 100).catch(() => []);
      listenBrainzFirstHop = radioFallback.map((artist) => ({ ...artist, similarity: Math.log10(artist.listens + 1) * 100 }));
    }
    for (const artist of listenBrainzFirstHop) add(artist.name, artist.musicBrainzId, 1, 'ListenBrainz', musicBrainzSeed.id, artist.similarity);
    const expansionSeeds = [...new Map(listenBrainzFirstHop.filter((artist) => artist.musicBrainzId).map((artist) => [artist.musicBrainzId!, artist])).values()].filter((_artist, index) => index % 6 === 0).slice(0, 4);
    const expanded = await inBatches(expansionSeeds, 4, (artist) => listenBrainzDatasetSimilar(artist.musicBrainzId!, fetcher));
    expanded.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      const root = expansionSeeds[index]?.musicBrainzId || `lb-${index}`;
      const rootWeight = expansionSeeds[index]?.similarity || 0;
      for (const artist of result.value) add(artist.name, artist.musicBrainzId, 2, 'ListenBrainz', root, (rootWeight / 100) + (artist.similarity / 100));
    });
  }

  const key = lastFmApiKey?.trim();
  if (key) {
    const firstHop = await lastFmSimilar(seed, key, fetcher).catch(() => []);
    for (const artist of firstHop) add(artist.name, artist.musicBrainzId, 1, 'Last.fm', 'lastfm-seed', artist.similarity * 10);
    const expansionSeeds = firstHop.slice(0, 8);
    const expanded = await inBatches(expansionSeeds, 4, (artist) => lastFmSimilar(artist.name, key, fetcher, 60));
    expanded.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      const root = `lastfm-${normalizedName(expansionSeeds[index]?.name || String(index))}`;
      for (const artist of result.value) add(artist.name, artist.musicBrainzId, 2, 'Last.fm', root, 4 + artist.similarity * 8);
    });
  }

  if (!candidates.size) throw new Error('The free discovery sources did not return similar artists for this seed.');
  const ranked = [...candidates.values()]
    .map((candidate): FreeDiscoveryCandidate => ({
      name: candidate.name,
      musicBrainzId: candidate.musicBrainzId,
      hop: candidate.hop,
      sources: [...candidate.sources],
      roots: candidate.roots.size,
      score: candidate.roots.size * 100 + candidate.sources.size * 25 + candidate.hop * 15 + candidate.weight,
    }))
    .sort((left, right) => right.sources.length - left.sources.length || right.score - left.score);
  const direct = ranked.filter((candidate) => candidate.hop === 1).slice(0, 300);
  const adjacent = ranked.filter((candidate) => candidate.hop === 2).sort((left, right) => right.roots - left.roots || right.score - left.score).slice(0, 200);
  return [...direct, ...adjacent];
}
