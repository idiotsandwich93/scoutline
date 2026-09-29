import type { Artist } from '../shared/types';

export type AiTask = 'resolve_identity' | 'personalize_outreach' | 'audit_message' | 'classify_reply' | 'draft_reply';

export interface CompactArtistFacts {
  name: string;
  latestRelease?: string;
  latestReleaseType?: string;
  location?: string;
  genres: string[];
  monthlyListeners: number;
  instagramFollowers: number;
  verifiedEvidence: string[];
}

export interface AiRequest {
  task: AiTask;
  artist: CompactArtistFacts;
  instruction: string;
  latestMessage?: string;
}

export interface AiResult {
  text: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AiProvider {
  readonly id: 'Codex' | 'Claude' | 'Gemini';
  isAvailable(): Promise<boolean>;
  run(request: AiRequest): Promise<AiResult>;
}

export function compactFacts(artist: Artist): CompactArtistFacts {
  return {
    name: artist.name,
    latestRelease: artist.latestRelease,
    latestReleaseType: artist.latestReleaseType,
    location: artist.location,
    genres: artist.genres,
    monthlyListeners: artist.monthlyListeners,
    instagramFollowers: artist.instagramFollowers,
    verifiedEvidence: artist.evidence
      .filter((evidence) => evidence.strength !== 'weak')
      .map((evidence) => `${evidence.label}: ${evidence.value} (${evidence.source})`),
  };
}

export function identityNeedsAi(artist: Artist): boolean {
  const hasDecisiveDirectLink = artist.evidence.some((evidence) =>
    evidence.strength === 'decisive' && /spotify artist profile|official website|chartmetric|viberate/i.test(evidence.source));
  return !hasDecisiveDirectLink && artist.confidenceScore < 90;
}
