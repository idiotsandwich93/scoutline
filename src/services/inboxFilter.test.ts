import { describe, expect, it } from 'vitest';
import type { Artist, Conversation } from '../shared/types';
import { matchScoutlineContact } from './inboxFilter';

const artist: Artist = {
  id: 'artist-1', name: 'Ember Arc', status: 'Prospect', email: 'demo@emberarc.example', instagramHandle: '@emberarc',
  monthlyListeners: 1000, instagramFollowers: 100, genres: [], confidence: 'verified', confidenceScore: 100,
  evidence: [], source: 'Test', createdAt: new Date().toISOString(), contactedCount: 1, lists: [],
};
const conversations: Conversation[] = [{ id: 'thread-1', artistId: artist.id, channel: 'Email', updatedAt: new Date().toISOString(), messages: [{ id: 'message-1', direction: 'outgoing', body: 'Hello', createdAt: new Date().toISOString(), read: true }] }];

describe('Scoutline inbox filter', () => {
  it('accepts a reply from a contact reached through Scoutline', () => {
    const matched = matchScoutlineContact({ externalId: 'gmail-1', channel: 'Email', senderEmail: 'demo@emberarc.example', body: 'Thanks!', createdAt: new Date().toISOString() }, [artist], conversations);
    expect(matched?.name).toBe('Ember Arc');
  });

  it('rejects unrelated Gmail messages', () => {
    const matched = matchScoutlineContact({ externalId: 'gmail-2', channel: 'Email', senderEmail: 'newsletter@random.example', body: 'Weekly news', createdAt: new Date().toISOString() }, [artist], conversations);
    expect(matched).toBeUndefined();
  });
});
