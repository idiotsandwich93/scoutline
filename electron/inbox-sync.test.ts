import { describe, expect, it } from 'vitest';
import { buildGmailQuery, parseGmailAtom, parseInstagramInbox } from './inbox-sync.js';

const contacts = [
  { artistId: 'artist-email', email: 'Artist@Example.com' },
  { artistId: 'artist-instagram', instagramHandle: '@realartist' },
];

describe('connected inbox normalization', () => {
  it('builds a Gmail query containing only known artist addresses', () => {
    expect(buildGmailQuery(contacts)).toBe('from:artist@example.com');
  });

  it('parses matching Gmail entries and excludes unrelated mail', () => {
    const xml = `<?xml version="1.0"?><feed>
      <entry><id>tag:gmail,1</id><issued>2026-08-24T12:00:00Z</issued><title>Re: Beats</title><summary>Yeah, send them over &amp; thanks.</summary><author><email>artist@example.com</email></author></entry>
      <entry><id>tag:gmail,2</id><issued>2026-08-24T13:00:00Z</issued><title>Newsletter</title><summary>Noise</summary><author><email>news@example.com</email></author></entry>
    </feed>`;
    expect(parseGmailAtom(xml, contacts)).toEqual([{ id: 'tag:gmail,1', artistId: 'artist-email', channel: 'Email', body: 'Yeah, send them over & thanks.', createdAt: '2026-08-24T12:00:00Z', subject: 'Re: Beats' }]);
  });

  it('keeps only incoming Instagram messages from known artist threads', () => {
    const payload = { inbox: { threads: [{ thread_id: 'thread-1', users: [{ pk: '22', username: 'realartist' }], items: [
      { item_id: 'incoming', user_id: '22', timestamp: 1_777_000_000_000_000, text: 'Let us work.' },
      { item_id: 'outgoing', user_id: '99', timestamp: 1_777_000_001_000_000, text: 'My own DM' },
    ] }] } };
    const messages = parseInstagramInbox(payload, contacts);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'instagram-incoming', artistId: 'artist-instagram', channel: 'Instagram', body: 'Let us work.' });
  });
});
