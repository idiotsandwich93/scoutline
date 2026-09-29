import type { Artist, Conversation } from '../shared/types';

const normalizeEmail = (value?: string) => (value || '').trim().toLowerCase();
const normalizeHandle = (value?: string) => (value || '').trim().toLowerCase().replace(/^@/, '');

export interface IncomingEnvelope {
  externalId: string;
  channel: 'Instagram' | 'Email';
  senderEmail?: string;
  senderHandle?: string;
  body: string;
  createdAt: string;
}

export function matchScoutlineContact(envelope: IncomingEnvelope, artists: Artist[], conversations: Conversation[]): Artist | undefined {
  const artist = artists.find((candidate) => envelope.channel === 'Email'
    ? Boolean(envelope.senderEmail && normalizeEmail(candidate.email) === normalizeEmail(envelope.senderEmail))
    : Boolean(envelope.senderHandle && normalizeHandle(candidate.instagramHandle) === normalizeHandle(envelope.senderHandle)));
  if (!artist) return undefined;

  const wasReachedThroughScoutline = artist.contactedCount > 0 || conversations.some((conversation) =>
    conversation.artistId === artist.id && conversation.channel === envelope.channel
    && conversation.messages.some((message) => message.direction === 'outgoing'));
  return wasReachedThroughScoutline ? artist : undefined;
}
