import { describe, expect, it } from 'vitest';
import { formatMusicMetadata, parseBeatNameResponse, previewOutreachTemplate, validateOutreachTemplate, type MusicMetadataInput } from './musicTools';

describe('production utilities', () => {
  it('formats distribution and delivery metadata without duplicating tags', () => {
    const input: MusicMetadataInput = { beatTitle: 'signal fire', primaryArtist: 'Luna Harbor', featuredArtists: 'Doley Bernays', producer: 'A. Producer', bpm: '142', musicalKey: 'C# minor', genre: 'Hip-Hop', mood: 'Cinematic', version: 'Original', releaseYear: '2026', isrc: 'US-ABC-26-00001', upc: '123456789012', masterOwner: 'Independent Records', compositionOwner: 'A. Producer Music', tags: 'cinematic, hip-hop, cinematic' };
    const output = formatMusicMetadata(input);
    expect(output).toContain('Display title: Signal Fire');
    expect(output).toContain('ISRC: USABC2600001');
    expect(output).toContain('℗ 2026 Independent Records');
    expect(output).toContain('luna-harbor-feat-doley-bernays-signal-fire-142bpm-c-minor.wav');
  });

  it('rejects unsupported outreach fields and previews supported fields', () => {
    const template = { channel: 'Email' as const, subject: 'Quick note for [artist_name]', body: 'Hey [artist_name], I heard [unknown_field].', preview: { artist_name: 'Chima Anya', latest_release: 'The Sun Is Shining', producer_name: 'A. Producer', instagram_handle: '@chima', pack_name: 'Midnight Pack' } };
    expect(validateOutreachTemplate(template)).toContain('Unknown placeholder: [unknown_field].');
    template.body = 'Hey [artist_name], [latest_release] stood out.';
    expect(previewOutreachTemplate(template).body).toBe('Hey Chima Anya, The Sun Is Shining stood out.');
  });

  it('parses numbered AI output into unique beat names', () => {
    expect(parseBeatNameResponse('1. Velvet Skyline\n2. After Hours\n3. Velvet Skyline')).toEqual(['Velvet Skyline', 'After Hours']);
  });
});
