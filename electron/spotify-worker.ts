import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

type Criteria = { artistId: string; minimumListeners: number; maximumListeners: number };
type HydrationRequest = { artists: Array<{ id: string; name?: string; image?: string }> };
type ArtistLink = { id: string; name: string; image?: string; spotifyUrl: string };
type DiscoveredArtist = ArtistLink & {
  monthlyListeners: number;
  instagramUrl?: string;
  email?: string;
  latestRelease?: string;
  latestReleaseSpotifyId?: string;
  latestReleaseImage?: string;
  websiteUrls?: string[];
  popularLocations?: string[];
  related: ArtistLink[];
  associatedArtistIds: string[];
};

const execFileAsync = promisify(execFile);

function decode(value: string): string {
  return value.replaceAll('&amp;', '&').replaceAll('&#x27;', "'").replaceAll('&quot;', '"');
}

function emailsIn(html: string): string[] {
  const emails: string[] = [];
  let searchFrom = 0;
  while (true) {
    const at = html.indexOf('@', searchFrom);
    if (at < 0) return emails;
    const left = html.slice(Math.max(0, at - 100), at).match(/[A-Z0-9._%+-]+$/i)?.[0];
    const right = html.slice(at + 1, at + 150).match(/^[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    if (left && right) emails.push(`${left}@${right}`);
    searchFrom = at + 1;
  }
}

function artistInstagramUrl(urls: string[]): string | undefined {
  return urls.find((url) => {
    try {
      const parsed = new URL(url);
      if (!/(^|\.)instagram\.com$/i.test(parsed.hostname)) return false;
      const handle = parsed.pathname.split('/').filter(Boolean).at(0)?.toLowerCase();
      return Boolean(handle && !['spotify', 'spotifyusa', 'spotifyuk', 'spotifyartists'].includes(handle));
    } catch { return false; }
  });
}

async function downloadArtistPages(artists: Array<{ id: string }>, patient = false): Promise<Map<string, string>> {
  if (!artists.length) return new Map();
  const workDirectory = await mkdtemp(path.join(tmpdir(), 'scoutline-spotify-'));
  try {
    const argumentsList = [
      '--parallel', '--parallel-max', patient ? '10' : '30', '--silent', '--show-error', '--location', '--fail', '--connect-timeout', patient ? '4' : '3', '--max-time', patient ? '10' : '7',
      '--user-agent', 'Scoutline-worker/0.6.1',
    ];
    const sessionCookie = process.env.SCOUTLINE_SPOTIFY_COOKIE;
    if (sessionCookie) argumentsList.push('--cookie', sessionCookie);
    argumentsList.push('--retry', '1', '--retry-all-errors', '--retry-delay', '1');
    for (const artist of artists) argumentsList.push('--output', path.join(workDirectory, `${artist.id}.html`), `https://open.spotify.com/artist/${artist.id}`);
    if (process.env.SCOUTLINE_SPOTIFY_DEBUG) process.stderr.write(`batch start ${artists.length}\n`);
    await execFileAsync('/usr/bin/curl', argumentsList, { maxBuffer: 2_000_000 }).catch(() => undefined);
    if (process.env.SCOUTLINE_SPOTIFY_DEBUG) process.stderr.write(`batch end ${artists.length}\n`);
    const pages = await Promise.all(artists.map(async (artist) => {
      const html = await readFile(path.join(workDirectory, `${artist.id}.html`), 'utf8').catch(() => '');
      return [artist.id, html] as const;
    }));
    return new Map(pages);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

function parseArtist(id: string, sourceHtml: string, knownName = '', knownImage?: string): DiscoveredArtist {
  const html = sourceHtml.replaceAll('\\u002F', '/').replaceAll('\\u0040', '@').replaceAll('\\/', '/');
  const encodedState = html.match(/<script id="initialState" type="text\/plain">([^<]+)<\/script>/i)?.[1];
  const initialState = encodedState ? Buffer.from(encodedState, 'base64').toString('utf8').replaceAll('\\u002F', '/').replaceAll('\\u0040', '@').replaceAll('\\/', '/') : '';
  const listenerMatch = html.match(/([\d,.]+)\s*([KMB])?\s+monthly listeners/i);
  const multiplier = listenerMatch?.[2]?.toUpperCase() === 'B' ? 1_000_000_000 : listenerMatch?.[2]?.toUpperCase() === 'M' ? 1_000_000 : listenerMatch?.[2]?.toUpperCase() === 'K' ? 1_000 : 1;
  const monthlyListeners = listenerMatch ? Math.round(Number(listenerMatch[1].replaceAll(',', '')) * multiplier) : 0;
  const related = new Map<string, ArtistLink>();
  const fansHeading = html.toLowerCase().indexOf('>fans also like<');
  if (process.env.SCOUTLINE_SPOTIFY_DEBUG) process.stderr.write(`page ${id} ${html.length} listeners:${/monthly listeners/i.test(html) ? 1 : 0} fans:${fansHeading >= 0 ? 1 : 0} challenge:${/challenge|captcha|access denied/i.test(html) ? 1 : 0}\n`);
  const fansEnd = fansHeading >= 0 ? html.toLowerCase().indexOf('<h2', fansHeading + 18) : -1;
  const fansBlock = fansHeading >= 0 ? html.slice(fansHeading, fansEnd > fansHeading ? fansEnd : fansHeading + 20_000) : '';
  const artistLinkPattern = /href="\/artist\/([A-Za-z0-9]+)"/gi;
  let link: RegExpExecArray | null;
  while ((link = artistLinkPattern.exec(fansBlock))) {
    if (link[1] === id) continue;
    const nearby = fansBlock.slice(link.index, link.index + 1_000);
    const closingAnchor = nearby.indexOf('</a>');
    const linkBlock = closingAnchor >= 0 ? nearby.slice(0, closingAnchor) : nearby;
    const spans = [...linkBlock.matchAll(/<span[^>]*>([^<]+)<\/span>/gi)];
    const name = decode(spans.at(-1)?.[1] || '').trim();
    if (!name) continue;
    const image = linkBlock.match(/<img[^>]+src="([^"]+)"/i)?.[1];
    if (!related.has(link[1])) related.set(link[1], { id: link[1], name, image, spotifyUrl: `https://open.spotify.com/artist/${link[1]}` });
  }
  const nonFansHtml = fansHeading >= 0 ? `${html.slice(0, fansHeading)}${fansEnd > fansHeading ? html.slice(fansEnd) : ''}` : html;
  const associatedArtistIds = [...new Set([...nonFansHtml.matchAll(/href="\/artist\/([A-Za-z0-9]+)"/gi)].map((match) => match[1]).filter((artistId) => artistId !== id))];
  const externalUrls: string[] = [];
  for (const externalLinks of initialState.matchAll(/"externalLinks":\{"items":(\[[^\]]*\])\}/g)) {
    try {
      const items = JSON.parse(externalLinks[1]) as Array<{ url?: string }>;
      for (const item of items) if (item.url) externalUrls.push(item.url);
    } catch { /* ignore malformed embedded metadata */ }
  }
  const instagramUrl = artistInstagramUrl([
    ...externalUrls,
    ...[...html.matchAll(/https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9._-]+/gi)].map((match) => match[0]),
  ]);
  const emails = [...emailsIn(html), ...emailsIn(initialState)];
  const email = emails.find((candidate) => !/@(?:spotify|sentry|w3|example)\./i.test(candidate));
  const websiteUrls = externalUrls.filter((url) => {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./i, '');
      return !/(?:spotify\.com|spotifycdn\.com|scdn\.co|instagram\.com|facebook\.com|twitter\.com|x\.com|wikipedia\.org|youtube\.com|tiktok\.com)$/i.test(hostname);
    } catch { return false; }
  });
  const popularLocations = [...new Set([...initialState.matchAll(/"city":"([^"]+)"/gi)].map((match) => decode(match[1]).trim()).filter(Boolean))].slice(0, 10);
  const latestIndex = html.toLowerCase().indexOf('latest release');
  const latestSection = latestIndex >= 0 ? html.slice(latestIndex, latestIndex + 16_000) : '';
  const releaseLink = latestSection.match(/<a[^>]+href="\/(?:album|track)\/([A-Za-z0-9]+)"[^>]*>[\s\S]{0,6000}?<\/a>/i);
  const latestReleaseSpotifyId = releaseLink?.[1];
  const releaseBlock = releaseLink?.[0] || '';
  const releaseTexts = [...releaseBlock.matchAll(/<(?:span|div)[^>]*>([^<>]+)<\/(?:span|div)>/gi)].map((match) => decode(match[1]).trim());
  const releaseName = releaseTexts.find((text) => text.length > 0 && text.length < 160 && !/^(latest release|play|album|single|ep|\d[\d,.]*|\d{1,2}\/\d{1,2}\/\d{2,4})$/i.test(text) && !/monthly listeners|followers/i.test(text));
  return {
    id,
    name: knownName || id,
    image: knownImage,
    spotifyUrl: `https://open.spotify.com/artist/${id}`,
    monthlyListeners,
    instagramUrl,
    email,
    websiteUrls: [...new Set(websiteUrls)].slice(0, 3),
    popularLocations,
    latestReleaseSpotifyId,
    latestRelease: releaseName,
    latestReleaseImage: releaseBlock.match(/<img[^>]+src="([^"]+)"/i)?.[1],
    related: [...related.values()].slice(0, 30),
    associatedArtistIds,
  };
}

async function loadArtists(artists: Array<{ id: string; name?: string; image?: string }>, patient = false): Promise<DiscoveredArtist[]> {
  const pages = await downloadArtistPages(artists, patient);
  if (!patient) {
    const missing = artists.filter((artist) => !(pages.get(artist.id) || '').includes('monthly listeners'));
    if (missing.length) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const recovered = await downloadArtistPages(missing, true);
      for (const [id, html] of recovered) if (html) pages.set(id, html);
    }
  }
  return artists.map((artist) => {
    const started = Date.now();
    const parsed = parseArtist(artist.id, pages.get(artist.id) || '', artist.name, artist.image);
    if (process.env.SCOUTLINE_SPOTIFY_DEBUG) process.stderr.write(`parse ${artist.id} ${Date.now() - started}ms\n`);
    return parsed;
  });
}

function distanceFromRange(listeners: number, criteria: Criteria): number {
  if (!listeners) return Number.MAX_SAFE_INTEGER;
  if (listeners < criteria.minimumListeners) return criteria.minimumListeners - listeners;
  if (listeners > criteria.maximumListeners) return listeners - criteria.maximumListeners;
  return 0;
}

async function discover(criteria: Criteria) {
  let seed: DiscoveredArtist | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    [seed] = await loadArtists([{ id: criteria.artistId }], true);
    if (seed.related.length) break;
    await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
  }
  if (!seed) throw new Error('Spotify could not load the selected artist. Please try again.');
  if (process.env.SCOUTLINE_SPOTIFY_DEBUG) process.stderr.write(`seed ${seed.related.length}\n`);
  if (!seed.related.length) throw new Error('Spotify did not return related artists. Please try again.');
  type GraphCandidate = ArtistLink & { hop: number; parents: Set<string>; roots: Set<string> };
  const candidates = new Map<string, GraphCandidate>(seed.related.map((artist) => [artist.id, { ...artist, hop: 1, parents: new Set([criteria.artistId]), roots: new Set([artist.id]) }]));
  const hydrated = new Map<string, DiscoveredArtist>();
  const expanded = new Set<string>();
  const seedAssociates = new Set(seed.associatedArtistIds);

  const independent = () => [...hydrated.values()].filter((artist) => {
    const graph = candidates.get(artist.id);
    return Boolean(graph && graph.hop >= 3 && artist.monthlyListeners > 0 && !seedAssociates.has(artist.id) && !artist.associatedArtistIds.includes(criteria.artistId));
  });

  for (let depth = 0; depth < 8; depth += 1) {
    const pending = [...candidates.values()]
      .filter((artist) => !hydrated.has(artist.id))
      .sort((left, right) => right.roots.size - left.roots.size || right.parents.size - left.parents.size || right.hop - left.hop)
      .slice(0, 90);
    const pages = await loadArtists(pending);
    for (const page of pages) hydrated.set(page.id, page);
    const matches = independent().filter((artist) => artist.monthlyListeners >= criteria.minimumListeners && artist.monthlyListeners <= criteria.maximumListeners);
    if (process.env.SCOUTLINE_SPOTIFY_DEBUG) process.stderr.write(`depth ${depth} pending ${pending.length} loaded ${pages.filter((artist) => artist.monthlyListeners > 0).length} matches ${matches.length}\n`);
    if (matches.length >= 1 || depth === 7 || candidates.size >= 1_500) break;
    const sources = pages
      .filter((artist) => artist.monthlyListeners > 0 && !expanded.has(artist.id))
      .sort((a, b) => distanceFromRange(a.monthlyListeners, criteria) - distanceFromRange(b.monthlyListeners, criteria))
      .slice(0, 60);
    for (const source of sources) {
      expanded.add(source.id);
      const sourceGraph = candidates.get(source.id);
      if (!sourceGraph) continue;
      for (const artist of source.related) {
        if (artist.id === criteria.artistId) continue;
        const existing = candidates.get(artist.id);
        if (existing) {
          existing.hop = Math.min(existing.hop, sourceGraph.hop + 1);
          existing.parents.add(source.id);
          for (const root of sourceGraph.roots) existing.roots.add(root);
        } else {
          candidates.set(artist.id, { ...artist, hop: sourceGraph.hop + 1, parents: new Set([source.id]), roots: new Set(sourceGraph.roots) });
        }
      }
    }
  }
  return independent()
    .sort((a, b) => {
      const aGraph = candidates.get(a.id)!;
      const bGraph = candidates.get(b.id)!;
      return bGraph.roots.size - aGraph.roots.size || bGraph.parents.size - aGraph.parents.size || bGraph.hop - aGraph.hop || distanceFromRange(a.monthlyListeners, criteria) - distanceFromRange(b.monthlyListeners, criteria);
    })
    .slice(0, 120)
    .map(({ related: _related, associatedArtistIds: _associatedArtistIds, ...artist }) => artist);
}

const request = JSON.parse(process.argv[2] || '{}') as Criteria | HydrationRequest;
const operation = 'artists' in request
  ? loadArtists(request.artists, true).then((artists) => artists.map(({ related: _related, ...artist }) => artist))
  : discover(request);
operation
  .then((artists) => process.stdout.write(JSON.stringify(artists)))
  .catch((error) => {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
