import type { Artist } from '../shared/types';

export type ArtistField =
  | 'name'
  | 'spotifyId'
  | 'chartmetricId'
  | 'viberateId'
  | 'spotifyUrl'
  | 'instagramUrl'
  | 'email'
  | 'monthlyListeners'
  | 'instagramFollowers'
  | 'location'
  | 'genres'
  | 'label'
  | 'ignore';

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

const aliases: Record<Exclude<ArtistField, 'ignore'>, string[]> = {
  name: ['artist', 'artist name', 'artist_name', 'name'],
  spotifyId: ['spotify id', 'spotify_id', 'spotify artist id', 'spotify_artist_id'],
  chartmetricId: ['chartmetric id', 'chartmetric_id', 'cm artist id', 'cm_artist_id'],
  viberateId: ['viberate id', 'viberate_id'],
  spotifyUrl: ['spotify url', 'spotify_url', 'spotify'],
  instagramUrl: ['instagram url', 'instagram_url', 'instagram', 'instagram profile'],
  email: ['email', 'email address', 'contact email'],
  monthlyListeners: ['monthly listeners', 'monthly_listeners', 'spotify monthly listeners', 'spotify_monthly_listeners'],
  instagramFollowers: ['instagram followers', 'instagram_followers', 'ig followers', 'ig_followers'],
  location: ['location', 'city', 'hometown', 'country'],
  genres: ['genre', 'genres'],
  label: ['label', 'record label', 'record_label'],
};

function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const character = line[i];
    if (character === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

export function parseCsv(text: string): ParsedCsv {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const logicalLines: string[] = [];
  let buffer = '';
  let quoted = false;
  for (const character of normalized) {
    if (character === '"') quoted = !quoted;
    if (character === '\n' && !quoted) {
      if (buffer.trim()) logicalLines.push(buffer);
      buffer = '';
    } else {
      buffer += character;
    }
  }
  if (buffer.trim()) logicalLines.push(buffer);
  if (!logicalLines.length) return { headers: [], rows: [] };
  return { headers: splitRow(logicalLines[0]), rows: logicalLines.slice(1).map(splitRow) };
}

export function inferMapping(headers: string[]): Record<number, ArtistField> {
  return Object.fromEntries(headers.map((header, index) => {
    const normalized = header.trim().toLowerCase();
    const match = (Object.entries(aliases) as [Exclude<ArtistField, 'ignore'>, string[]][])
      .find(([, values]) => values.includes(normalized));
    return [index, match?.[0] ?? 'ignore'];
  }));
}

const numberValue = (value?: string) => Number((value || '0').replace(/[^0-9.-]/g, '')) || 0;
const handleFromUrl = (url?: string) => {
  if (!url) return undefined;
  if (url.startsWith('@')) return url;
  const match = url.match(/instagram\.com\/([^/?#]+)/i);
  return match ? `@${match[1]}` : undefined;
};

export function rowsToArtists(parsed: ParsedCsv, mapping: Record<number, ArtistField>, source: string): Artist[] {
  return parsed.rows.flatMap((row, rowIndex) => {
    const value = (field: ArtistField) => {
      const found = Object.entries(mapping).find(([, mapped]) => mapped === field);
      return found ? row[Number(found[0])]?.trim() : undefined;
    };
    const name = value('name');
    if (!name) return [];
    const instagramUrl = value('instagramUrl');
    const hasDirectInstagram = Boolean(instagramUrl);
    return [{
      id: `import-${Date.now()}-${rowIndex}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      status: 'Prospect' as const,
      spotifyId: value('spotifyId'),
      chartmetricId: value('chartmetricId'),
      viberateId: value('viberateId'),
      spotifyUrl: value('spotifyUrl'),
      instagramUrl,
      instagramHandle: handleFromUrl(instagramUrl),
      email: value('email'),
      monthlyListeners: numberValue(value('monthlyListeners')),
      instagramFollowers: numberValue(value('instagramFollowers')),
      location: value('location'),
      genres: (value('genres') || '').split(/[|;]/).map((genre) => genre.trim()).filter(Boolean),
      label: value('label'),
      confidence: hasDirectInstagram ? 'high' as const : 'unverified' as const,
      confidenceScore: hasDirectInstagram ? 90 : 0,
      evidence: hasDirectInstagram ? [{ label: 'Instagram', source: `${source} import`, value: instagramUrl || '', strength: 'decisive' as const }] : [],
      source,
      createdAt: new Date().toISOString(),
      contactedCount: 0,
      lists: [],
    }];
  });
}

const normalized = (value?: string) => (value || '').trim().toLowerCase().replace(/^@/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export function mergeArtists(existing: Artist[], incoming: Artist[]): { artists: Artist[]; added: number; merged: number } {
  const artists = [...existing];
  let added = 0;
  let merged = 0;
  for (const artist of incoming) {
    const index = artists.findIndex((current) =>
      Boolean(artist.spotifyId && current.spotifyId === artist.spotifyId)
      || Boolean(artist.chartmetricId && current.chartmetricId === artist.chartmetricId)
      || Boolean(artist.viberateId && current.viberateId === artist.viberateId)
      || Boolean(artist.email && normalized(current.email) === normalized(artist.email))
      || Boolean(artist.instagramHandle && normalized(current.instagramHandle) === normalized(artist.instagramHandle))
      || normalized(current.name) === normalized(artist.name));
    if (index === -1) {
      artists.push(artist);
      added += 1;
    } else {
      const current = artists[index];
      const incomingValues = Object.fromEntries(Object.entries(artist).filter(([, value]) => value !== undefined && value !== '')) as Partial<Artist>;
      artists[index] = { ...current, ...incomingValues, id: current.id, evidence: [...artist.evidence, ...current.evidence] };
      merged += 1;
    }
  }
  return { artists, added, merged };
}
