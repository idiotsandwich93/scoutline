export interface MusicMetadataInput {
  beatTitle: string;
  primaryArtist: string;
  featuredArtists: string;
  producer: string;
  bpm: string;
  musicalKey: string;
  genre: string;
  mood: string;
  version: string;
  releaseYear: string;
  isrc: string;
  upc: string;
  masterOwner: string;
  compositionOwner: string;
  tags: string;
}

const titleCase = (value: string) => value.trim().replace(/\s+/g, ' ').replace(/\b([a-z])/g, (match) => match.toUpperCase());
const cleanTag = (value: string) => value.trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, ' ');
const safeFilePart = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

export function validateMusicMetadata(input: MusicMetadataInput): string[] {
  const errors: string[] = [];
  if (!input.beatTitle.trim()) errors.push('Beat title is required.');
  if (!input.primaryArtist.trim()) errors.push('Primary artist is required.');
  if (!input.producer.trim()) errors.push('Producer credit is required.');
  const bpm = Number(input.bpm);
  if (!Number.isInteger(bpm) || bpm < 20 || bpm > 300) errors.push('BPM must be a whole number from 20 to 300.');
  if (!input.musicalKey.trim()) errors.push('Musical key is required.');
  if (!/^\d{4}$/.test(input.releaseYear) || Number(input.releaseYear) < 1900 || Number(input.releaseYear) > 2200) errors.push('Release year must be four digits.');
  if (input.isrc.trim() && !/^[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}$/i.test(input.isrc.trim())) errors.push('ISRC must follow the CC-XXX-YY-NNNNN format.');
  if (input.upc.trim() && !/^\d{12,14}$/.test(input.upc.trim().replace(/\s+/g, ''))) errors.push('UPC/EAN must contain 12 to 14 digits.');
  return errors;
}

export function formatMusicMetadata(input: MusicMetadataInput): string {
  const errors = validateMusicMetadata(input);
  if (errors.length) throw new Error(errors.join('\n'));
  const title = titleCase(input.beatTitle);
  const artist = input.primaryArtist.trim().replace(/\s+/g, ' ');
  const featured = input.featuredArtists.split(',').map((value) => value.trim()).filter(Boolean);
  const displayArtist = featured.length ? `${artist} feat. ${featured.join(', ')}` : artist;
  const version = input.version.trim() && !/^original$/i.test(input.version.trim()) ? ` (${titleCase(input.version)} Version)` : '';
  const displayTitle = `${title}${version}`;
  const tags = [...new Set([
    ...input.tags.split(','), input.genre, input.mood, `${artist} type beat`, `${input.genre} instrumental`, input.producer,
  ].map(cleanTag).filter(Boolean))];
  const isrc = input.isrc.trim().toUpperCase().replace(/-/g, '');
  const upc = input.upc.trim().replace(/\s+/g, '');
  const filename = `${safeFilePart(displayArtist)}-${safeFilePart(displayTitle)}-${input.bpm}bpm-${safeFilePart(input.musicalKey)}.wav`;

  return `RELEASE METADATA

Display title: ${displayTitle}
Primary artist: ${artist}
Featured artist(s): ${featured.length ? featured.join('; ') : 'None'}
Display artist line: ${displayArtist}
Version: ${input.version.trim() || 'Original'}

CREDITS
Produced by: ${input.producer.trim()}
Master owner: ${input.masterOwner.trim() || 'Not supplied'}
Composition/publisher: ${input.compositionOwner.trim() || 'Not supplied'}

MUSIC DATA
Genre: ${titleCase(input.genre) || 'Not supplied'}
Mood: ${titleCase(input.mood) || 'Not supplied'}
BPM: ${input.bpm}
Key: ${input.musicalKey.trim()}
Release year: ${input.releaseYear}
Explicit content: Set during distribution review

IDENTIFIERS
ISRC: ${isrc || 'Assign through distributor/label'}
UPC/EAN: ${upc || 'Assign through distributor/label'}

DELIVERY
Master filename: ${filename}
Suggested YouTube title: ${displayArtist} - ${displayTitle} (Official Audio)
Search tags (${tags.length}): ${tags.join(', ')}

COPYRIGHT LINES
℗ ${input.releaseYear} ${input.masterOwner.trim() || artist}
© ${input.releaseYear} ${input.compositionOwner.trim() || artist}`;
}

export const outreachTokens = ['artist_name', 'latest_release', 'producer_name', 'instagram_handle', 'pack_name'] as const;

export interface OutreachTemplateInput {
  channel: 'Instagram' | 'Email';
  subject: string;
  body: string;
  preview: Record<(typeof outreachTokens)[number], string>;
}

export function validateOutreachTemplate(input: OutreachTemplateInput): string[] {
  const errors: string[] = [];
  if (input.channel === 'Email' && !input.subject.trim()) errors.push('Email subject is required.');
  if (!input.body.trim()) errors.push('Message body is required.');
  const joined = `${input.subject}\n${input.body}`;
  const usedTokens = [...joined.matchAll(/\[([a-z_]+)\]/gi)].map((match) => match[1].toLowerCase());
  const unknown = [...new Set(usedTokens.filter((token) => !outreachTokens.includes(token as (typeof outreachTokens)[number])))];
  if (unknown.length) errors.push(`Unknown placeholder${unknown.length === 1 ? '' : 's'}: ${unknown.map((token) => `[${token}]`).join(', ')}.`);
  if (!usedTokens.includes('artist_name')) errors.push('Add [artist_name] so each message addresses the correct recipient.');
  if (input.body.trim().split(/\s+/).length > (input.channel === 'Instagram' ? 120 : 500)) errors.push(`${input.channel} template is too long for the outreach workflow.`);
  return errors;
}

export function previewOutreachTemplate(input: OutreachTemplateInput): { subject: string; body: string } {
  const replace = (value: string) => outreachTokens.reduce((result, token) => result.replaceAll(new RegExp(`\\[${token}\\]`, 'gi'), input.preview[token].trim()), value);
  return { subject: replace(input.subject), body: replace(input.body) };
}

export function parseBeatNameResponse(value: string): string[] {
  const names = value.split(/\r?\n/).map((line) => line
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
    .replace(/^['“”"]|['“”"]$/g, '')
    .trim())
    .filter((line) => line.length >= 2 && line.length <= 80);
  return [...new Set(names)].slice(0, 12);
}
