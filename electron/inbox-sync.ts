import type { InboxContact, SyncedInboxMessage } from '../src/shared/types.js';

const decodeEntities = (value: string) => value
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
  .replace(/\s+/g, ' ')
  .trim();

const tag = (xml: string, name: string) => {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? decodeEntities(match[1]) : '';
};

const normalizeEmail = (value?: string) => (value || '').trim().toLowerCase();
const normalizeHandle = (value?: string) => (value || '').trim().toLowerCase().replace(/^@/, '').replace(/\/$/, '');

export function buildGmailQuery(contacts: InboxContact[]): string {
  const emails = [...new Set(contacts.map((contact) => normalizeEmail(contact.email)).filter(Boolean))];
  return emails.map((email) => `from:${email}`).join(' OR ');
}

export function parseGmailAtom(xml: string, contacts: InboxContact[]): SyncedInboxMessage[] {
  const byEmail = new Map(contacts.filter((contact) => contact.email).map((contact) => [normalizeEmail(contact.email), contact.artistId]));
  return [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].flatMap((entry) => {
    const block = entry[1];
    const email = normalizeEmail(tag(block, 'email'));
    const artistId = byEmail.get(email);
    if (!artistId) return [];
    const id = tag(block, 'id') || `gmail-${artistId}-${tag(block, 'issued') || tag(block, 'modified')}`;
    const body = tag(block, 'summary') || tag(block, 'content') || tag(block, 'title');
    if (!body) return [];
    const createdAt = tag(block, 'issued') || tag(block, 'modified') || new Date().toISOString();
    return [{ id, artistId, channel: 'Email' as const, body, createdAt, subject: tag(block, 'title') || undefined }];
  });
}

type InstagramUser = { pk?: string | number; id?: string | number; username?: string };
type InstagramItem = { item_id?: string; timestamp?: string | number; user_id?: string | number; item_type?: string; text?: string; link?: { text?: string }; voice_media?: unknown; media?: unknown };
type InstagramThread = { thread_id?: string; users?: InstagramUser[]; items?: InstagramItem[] };

export function parseInstagramInbox(payload: unknown, contacts: InboxContact[]): SyncedInboxMessage[] {
  const threads = (payload as { inbox?: { threads?: InstagramThread[] } })?.inbox?.threads || [];
  const byHandle = new Map(contacts.filter((contact) => contact.instagramHandle).map((contact) => [normalizeHandle(contact.instagramHandle), contact.artistId]));
  const messages: SyncedInboxMessage[] = [];
  for (const thread of threads) {
    const artistUser = thread.users?.find((user) => user.username && byHandle.has(normalizeHandle(user.username)));
    const artistId = artistUser?.username ? byHandle.get(normalizeHandle(artistUser.username)) : undefined;
    if (!artistId || !artistUser) continue;
    const artistUserId = String(artistUser.pk ?? artistUser.id ?? '');
    for (const item of thread.items || []) {
      if (artistUserId && String(item.user_id ?? '') !== artistUserId) continue;
      const body = item.text?.trim() || item.link?.text?.trim() || (item.voice_media ? 'Voice message' : item.media ? 'Media message' : '');
      if (!body) continue;
      const rawTimestamp = Number(item.timestamp || 0);
      const milliseconds = rawTimestamp > 10_000_000_000_000 ? Math.floor(rawTimestamp / 1_000) : rawTimestamp > 10_000_000_000 ? rawTimestamp : rawTimestamp * 1_000;
      messages.push({
        id: `instagram-${item.item_id || `${thread.thread_id}-${rawTimestamp}`}`,
        artistId,
        channel: 'Instagram',
        body,
        createdAt: milliseconds ? new Date(milliseconds).toISOString() : new Date().toISOString(),
      });
    }
  }
  return messages;
}
