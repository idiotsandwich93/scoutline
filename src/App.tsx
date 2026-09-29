import { useEffect, useMemo, useRef, useState } from 'react';
import { inferMapping, mergeArtists, parseCsv, rowsToArtists, type ArtistField, type ParsedCsv } from './lib/csv';
import { formatMusicMetadata, outreachTokens, parseBeatNameResponse, previewOutreachTemplate, validateMusicMetadata, validateOutreachTemplate, type MusicMetadataInput, type OutreachTemplateInput } from './lib/musicTools';
import { buildProducerAgreement, validateProducerAgreement, type AgreementKind, type ProducerAgreementInput } from './lib/producerAgreement';
import { instagramFilterIsActive, validateFinderRanges, withTimeout } from './lib/finder';
import { loadState, persistState } from './lib/store';
import type { AppState, Artist, Automation, Campaign, Confidence, ConnectionService, ConnectionStatus, NavKey, Pack, SpotifyArtistResult } from './shared/types';

const nav: { key: NavKey; label: string; icon: string; group?: boolean }[] = [
  { key: 'home', label: 'Overview', icon: '⌂' },
  { key: 'finder', label: 'Finder', icon: '⌕' },
  { key: 'contacts', label: 'Contacts', icon: '♙' },
  { key: 'inbox', label: 'Inbox', icon: '▤' },
  { key: 'emails', label: 'Campaigns', icon: '✉' },
  { key: 'files', label: 'Files', icon: '♪', group: true },
  { key: 'packs', label: 'Packs', icon: '◇' },
  { key: 'automations', label: 'Automations', icon: '✦' },
  { key: 'youtube', label: 'YouTube', icon: '▶', group: true },
  { key: 'tools', label: 'Tools', icon: '⚒' },
  { key: 'settings', label: 'Settings', icon: '⚙', group: true },
];

const fieldLabels: Record<ArtistField, string> = {
  name: 'Artist name', spotifyId: 'Spotify ID', chartmetricId: 'Chartmetric ID', viberateId: 'Viberate ID',
  spotifyUrl: 'Spotify URL', instagramUrl: 'Instagram URL', email: 'Email', monthlyListeners: 'Monthly listeners',
  instagramFollowers: 'Instagram followers', location: 'Location', genres: 'Genres', label: 'Label', ignore: 'Ignore',
};

const outreachServices: ConnectionService[] = ['Instagram', 'Gmail', 'Spotify', 'YouTube'];
const aiServices: ConnectionService[] = ['Codex', 'Claude', 'Gemini'];
const dataServices: ConnectionService[] = ['Chartmetric', 'Last.fm'];

const number = (value: number) => Intl.NumberFormat('en-US', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
const timeAgo = (value?: string) => {
  if (!value) return 'Never';
  const seconds = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
};

const readableError = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : fallback;
  return message.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '');
};

function confidenceLabel(confidence: Confidence) {
  return { verified: 'Verified', high: 'High confidence', review: 'Review needed', unverified: 'Unverified' }[confidence];
}

function Avatar({ artist, large = false }: { artist: Artist; large?: boolean }) {
  const initials = artist.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  return <div className={`avatar ${large ? 'avatar-large' : ''}`}>{artist.image ? <img src={artist.image} alt="" /> : initials}</div>;
}

function Pill({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: string }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) {
  return <div className="page-header">
    <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>
    {action && <div className="page-actions">{action}</div>}
  </div>;
}

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [active, setActive] = useState<NavKey>('home');
  const [contactsImportRequest, setContactsImportRequest] = useState(0);
  const [toast, setToast] = useState('');
  const applyingRemoteState = useRef(false);

  useEffect(() => { void loadState().then(setState); }, []);
  useEffect(() => window.scoutline?.onStateChanged((next) => { applyingRemoteState.current = true; setState(next); }), []);
  useEffect(() => {
    if (!state) return;
    if (applyingRemoteState.current) { applyingRemoteState.current = false; return; }
    const timer = window.setTimeout(() => void persistState(state), 180);
    return () => window.clearTimeout(timer);
  }, [state]);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2800);
  };
  const update = (recipe: (current: AppState) => AppState) => setState((current) => current ? recipe(current) : current);

  if (!state) return <div className="loading"><div className="logo-mark">S</div><span>Loading Scoutline…</span></div>;

  const page = {
    home: <Overview state={state} navigate={(key, action) => { setActive(key); if (key === 'contacts' && action === 'import') setContactsImportRequest((value) => value + 1); }} />,
    finder: <Finder state={state} update={update} notify={notify} />,
    contacts: <Contacts state={state} update={update} notify={notify} importRequest={contactsImportRequest} />,
    inbox: <Inbox state={state} update={update} notify={notify} />,
    emails: <Campaigns state={state} update={update} notify={notify} />,
    files: <Files state={state} update={update} notify={notify} />,
    packs: <Packs state={state} update={update} notify={notify} />,
    automations: <Automations state={state} update={update} notify={notify} />,
    youtube: <YouTube state={state} update={update} notify={notify} />,
    tools: <Tools state={state} notify={notify} />,
    settings: <Settings state={state} update={update} notify={notify} />,
  }[active];

  const unread = state.conversations.filter((conversation) => conversation.messages.some((message) => message.direction === 'incoming' && !message.read)).length;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="logo-mark">S</div><div><strong>Scoutline</strong><small>Artist operations</small></div></div>
      <nav>
        {nav.map((item) => <div key={item.key} className={item.group ? 'nav-group' : ''}>
          <button data-testid={`nav-${item.key}`} className={active === item.key ? 'nav-item active' : 'nav-item'} onClick={() => setActive(item.key)}>
            <span className="nav-icon">{item.icon}</span><span>{item.label}</span>
            {item.key === 'inbox' && unread > 0 && <span className="nav-count">{unread}</span>}
          </button>
        </div>)}
      </nav>
      <div className="sidebar-footer">
        <div className="provider-dot" />
        <div><strong>{state.settings.aiProvider}</strong><small>{state.settings.aiModel}</small></div>
      </div>
    </aside>
    <main className="main"><div className="titlebar-drag" />{page}</main>
    {toast && <div className="toast">✓ {toast}</div>}
  </div>;
}

function Overview({ state, navigate }: { state: AppState; navigate: (key: NavKey, action?: 'import') => void }) {
  const unread = state.conversations.reduce((total, thread) => total + thread.messages.filter((message) => message.direction === 'incoming' && !message.read).length, 0);
  const verified = state.artists.filter((artist) => ['verified', 'high'].includes(artist.confidence)).length;
  const queued = state.campaigns.reduce((total, campaign) => total + campaign.queued, 0);
  return <section className="page page-wide">
    <PageHeader eyebrow="Local workspace" title="Good afternoon" description="Your scouting, outreach, and A&R command center." action={<button className="primary" onClick={() => navigate('finder')}>Start scouting</button>} />
    <div className="stats-grid">
      <Stat label="Prospects" value={state.artists.length} note={`${verified} identity verified`} />
      <Stat label="Waiting to send" value={queued} note="Across active campaigns" />
      <Stat label="Replies" value={unread} note="Only Scoutline contacts" accent />
      <Stat label="AI usage" value={state.settings.aiCallsThisMonth} note="No Scoutline usage caps" />
    </div>
    <div className="dashboard-grid">
      <div className="panel span-2">
        <div className="panel-heading"><div><h2>Pipeline</h2><p>Every prospect, from discovery through reply.</p></div></div>
        <div className="pipeline">
          {[
            ['Discovered', state.finderQueue.length],
            ['Prospects', state.artists.filter((a) => a.status === 'Prospect').length],
            ['Connections', state.artists.filter((a) => a.status === 'Connection').length],
            ['Replies', unread],
          ].map(([label, value], index) => <div className="pipeline-stage" key={String(label)}><span>{index + 1}</span><strong>{value}</strong><small>{label}</small></div>)}
        </div>
      </div>
      <div className="panel">
        <div className="panel-heading"><div><h2>Identity health</h2><p>Scoutline never silently guesses.</p></div></div>
        <div className="identity-ring"><strong>{state.artists.length ? Math.round(verified / state.artists.length * 100) : 0}%</strong><span>verified</span></div>
        <button className="secondary full" onClick={() => navigate('contacts')}>Review identities</button>
      </div>
      <div className="panel span-2">
        <div className="panel-heading"><div><h2>Recent activity</h2><p>Recorded locally with the campaign history.</p></div></div>
        <div className="activity-list">
          {state.activities.slice(0, 5).map((activity) => <div className="activity" key={activity.id}><div className="activity-icon">✓</div><div><strong>{activity.type}</strong><p>{activity.detail}</p></div><time>{timeAgo(activity.createdAt)}</time></div>)}
        </div>
      </div>
      <div className="panel">
        <div className="panel-heading"><div><h2>Quick actions</h2><p>Continue without breaking flow.</p></div></div>
        <div className="quick-actions">
          <button onClick={() => navigate('finder')}><span>⌕</span><div><strong>Find artists</strong><small>Discover and verify</small></div></button>
          <button onClick={() => navigate('contacts', 'import')}><span>⇧</span><div><strong>Import CSV</strong><small>Chartmetric or Viberate</small></div></button>
          <button onClick={() => navigate('inbox')}><span>▤</span><div><strong>Open inbox</strong><small>{unread} unread replies</small></div></button>
        </div>
      </div>
    </div>
  </section>;
}

function Stat({ label, value, note, accent = false }: { label: string; value: string | number; note: string; accent?: boolean }) {
  return <div className={`stat ${accent ? 'stat-accent' : ''}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

function Finder({ state, update, notify }: { state: AppState; update: (recipe: (state: AppState) => AppState) => void; notify: (message: string) => void }) {
  const [seed, setSeed] = useState('');
  const [searchResults, setSearchResults] = useState<SpotifyArtistResult[]>([]);
  const [selectedSeed, setSelectedSeed] = useState<SpotifyArtistResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [finding, setFinding] = useState(false);
  const [finderError, setFinderError] = useState('');
  const [finderNotice, setFinderNotice] = useState('');
  const [minListeners, setMinListeners] = useState('10000');
  const [maxListeners, setMaxListeners] = useState('250000');
  const [minInstagramFollowers, setMinInstagramFollowers] = useState('0');
  const [maxInstagramFollowers, setMaxInstagramFollowers] = useState('100000');
  const [popularIn, setPopularIn] = useState('');
  const [emailOnly, setEmailOnly] = useState(false);
  const [dmArtist, setDmArtist] = useState<Artist | null>(null);
  const artist = state.finderQueue[0];

  useEffect(() => {
    if (!window.scoutline || seed.trim().length < 2 || selectedSeed?.name === seed) { setSearchResults([]); return; }
    const timer = window.setTimeout(async () => {
      setSearching(true); setFinderError('');
      try { setSearchResults(await withTimeout(window.scoutline!.spotifySearchArtists(seed), 25_000, 'Spotify artist search timed out. Please try again.')); }
      catch (error) { setFinderError(readableError(error, 'Spotify search failed.')); setSearchResults([]); }
      finally { setSearching(false); }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [seed, selectedSeed]);

  const findArtists = async () => {
    if (!selectedSeed || !window.scoutline) { setFinderError('Choose an artist from the live Spotify results first.'); return; }
    setFinding(true); setFinderError('');
    setFinderNotice('');
    try {
      const minimum = minListeners.trim() === '' ? 0 : Number(minListeners); const maximum = maxListeners.trim() === '' ? Number.MAX_SAFE_INTEGER : Number(maxListeners);
      const minimumInstagram = minInstagramFollowers.trim() === '' ? 0 : Number(minInstagramFollowers); const maximumInstagram = maxInstagramFollowers.trim() === '' ? Number.MAX_SAFE_INTEGER : Number(maxInstagramFollowers);
      const rangeError = validateFinderRanges({ minimumListeners: minimum, maximumListeners: maximum, minimumInstagramFollowers: minimumInstagram, maximumInstagramFollowers: maximumInstagram });
      if (rangeError) { setFinderError(rangeError); return; }
      const discovered = await withTimeout(window.scoutline.spotifyFindSimilar(selectedSeed.id, { seedName: selectedSeed.name, minimumListeners: minimum, maximumListeners: maximum, minimumInstagramFollowers: minimumInstagram, maximumInstagramFollowers: maximumInstagram, popularIn: popularIn.trim() || undefined, publicEmailRequired: emailOnly }), 120_000, 'Artist discovery stopped after two minutes. Your existing results were kept; try the search again.');
      const locationQuery = popularIn.trim().toLowerCase();
      const instagramFilterEnabled = instagramFilterIsActive(minimumInstagram, maximumInstagram);
      const filtered = discovered.filter((candidate) => candidate.monthlyListeners > 0 && candidate.monthlyListeners >= minimum && candidate.monthlyListeners <= maximum && (!instagramFilterEnabled || (candidate.instagramFollowers >= minimumInstagram && candidate.instagramFollowers <= maximumInstagram)) && (!emailOnly || Boolean(candidate.email)) && (!locationQuery || candidate.popularLocations?.some((location) => location.toLowerCase().includes(locationQuery))));
      if (!filtered.length) setFinderNotice(`No artists in this catalog matched ${number(minimum)}–${number(maximum)} monthly listeners, ${number(minimumInstagram)}–${number(maximumInstagram)} Instagram followers${popularIn.trim() ? `, popular in ${popularIn.trim()}` : ''}${emailOnly ? ', and a public email' : ''}. Your current results were kept.`);
      else {
        update((current) => ({ ...current, finderQueue: filtered, activities: [{ id: crypto.randomUUID(), type: 'Spotify discovery completed', detail: `${filtered.length} candidates found from ${selectedSeed.name}.`, createdAt: new Date().toISOString() }, ...current.activities] }));
        notify(`${filtered.length} matching artists loaded`);
      }
    } catch (error) { setFinderError(readableError(error, 'Spotify discovery failed.')); }
    finally { setFinding(false); }
  };

  const remove = (type: string) => {
    if (!artist) return;
    update((current) => ({ ...current, finderQueue: current.finderQueue.slice(1), activities: [{ id: crypto.randomUUID(), artistId: artist.id, type, detail: `${artist.name} was classified in Finder.`, createdAt: new Date().toISOString() }, ...current.activities] }));
    notify(type === 'Saved prospect' ? `${artist.name} saved` : 'Moved to the next artist');
  };
  const save = () => {
    if (!artist) return;
    update((current) => ({ ...current, artists: current.artists.some((a) => a.id === artist.id) ? current.artists : [...current.artists, artist], finderQueue: current.finderQueue.slice(1), activities: [{ id: crypto.randomUUID(), artistId: artist.id, type: 'Saved prospect', detail: `${artist.name} was saved from Finder.`, createdAt: new Date().toISOString() }, ...current.activities] }));
    notify(`${artist.name} saved as a prospect`);
  };

  return <section className="page page-wide finder-page">
    <PageHeader eyebrow="Discovery" title="Contact Finder" description="Find, verify, and qualify artists before outreach." action={<Pill tone="green">No daily limits</Pill>} />
    <div className="filter-panel">
      <label className="field field-wide spotify-search"><span>Find artists similar to</span><input placeholder="Search Spotify artists…" value={seed} onChange={(event) => { setSeed(event.target.value); setSelectedSeed(null); }} />{searching && <i className="search-spinner" />}{searchResults.length > 0 && <div className="spotify-results">{searchResults.map((result) => <button type="button" key={result.id} onClick={() => { setSelectedSeed(result); setSeed(result.name); setSearchResults([]); }}><span className="result-image">{result.image ? <img src={result.image} alt="" /> : result.name[0]}</span><span><strong>{result.name}</strong><small>{result.followers ? `${number(result.followers)} Spotify followers` : 'Spotify artist'}</small></span><b>Spotify</b></button>)}</div>}</label>
      <label className="field"><span>Monthly listeners from</span><input type="number" value={minListeners} onChange={(event) => setMinListeners(event.target.value)} /></label>
      <label className="field"><span>to</span><input data-testid="maximum-listeners" type="number" value={maxListeners} onChange={(event) => setMaxListeners(event.target.value)} /></label>
      <label className="field"><span>Popular in (optional)</span><input value={popularIn} onChange={(event) => setPopularIn(event.target.value)} placeholder="City or country" /></label>
      <div className="instagram-filter"><span>Instagram followers</span><div className="dual-range"><input aria-label="Minimum Instagram followers" type="range" min="0" max="100000" step="100" value={Math.min(Number(minInstagramFollowers) || 0, 100000)} onChange={(event) => setMinInstagramFollowers(String(Math.min(Number(event.target.value), Number(maxInstagramFollowers) || 0)))} /><input aria-label="Maximum Instagram followers" type="range" min="0" max="100000" step="100" value={Math.min(Number(maxInstagramFollowers) || 0, 100000)} onChange={(event) => setMaxInstagramFollowers(String(Math.max(Number(event.target.value), Number(minInstagramFollowers) || 0)))} /></div><div className="range-numbers"><input data-testid="minimum-instagram-followers" type="number" min="0" value={minInstagramFollowers} onChange={(event) => setMinInstagramFollowers(event.target.value)} /><i>to</i><input data-testid="maximum-instagram-followers" type="number" min="0" value={maxInstagramFollowers} onChange={(event) => setMaxInstagramFollowers(event.target.value)} /></div></div>
      <div className="finder-submit"><label className="toggle-line"><input data-testid="public-email-toggle" type="checkbox" checked={emailOnly} onChange={(event) => setEmailOnly(event.target.checked)} /><span className="toggle" /><span>Public email required</span></label><button data-testid="find-artists" className="primary" disabled={!selectedSeed || finding} onClick={() => void findArtists()}>{finding ? 'Finding…' : 'Find artists'}</button></div>
    </div>
    {finderError && <div className="connection-error">{finderError}</div>}
    {finderNotice && <div className="finder-notice">{finderNotice}</div>}
    <div className="finder-layout">
      {artist ? <div className="artist-card">
        <div className="artist-hero"><Avatar artist={artist} large /><div><div className="eyebrow">Live Spotify prospect</div><h2>{artist.name}</h2><p>{artist.genres.length ? artist.genres.join(' · ') : artist.popularLocations?.length ? `Popular in ${artist.popularLocations.slice(0, 3).join(' · ')}` : 'Spotify genres unavailable'}</p></div></div>
        {artist.spotifyId ? <iframe className="spotify-embed" title={`${artist.name} on Spotify`} src={`https://open.spotify.com/embed/artist/${artist.spotifyId}?utm_source=generator&theme=0`} allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy" /> : <div className="release-card"><div className="album-art">♫</div><div><small>Latest {artist.latestReleaseType}</small><strong>{artist.latestRelease}</strong></div></div>}
        <div className="metrics-row"><div><strong>{artist.monthlyListeners ? number(artist.monthlyListeners) : 'Unavailable'}</strong><span>Spotify monthly listeners</span></div><div><strong>{artist.instagramFollowers ? number(artist.instagramFollowers) : 'Unavailable'}</strong><span>Instagram followers</span></div><div><strong>{artist.email ? 'Found' : 'Not found'}</strong><span>Public email</span></div></div>
        <div className="social-row"><button className="pill" onClick={() => artist.spotifyUrl && void window.scoutline?.openExternal(artist.spotifyUrl)}>Spotify ↗</button>{artist.instagramHandle && <button className="pill" onClick={() => artist.instagramUrl && void window.scoutline?.openExternal(artist.instagramUrl)}>Instagram {artist.instagramHandle} ↗</button>}{artist.email && <Pill>Email</Pill>}</div>
        <div className="artist-actions"><button className="danger ghost" onClick={() => remove('Skipped artist')}>×<small>Skip artist</small></button><button className="ghost" onClick={() => remove('Not similar')}>≠<small>Not similar</small></button><button className="save-button" onClick={save}>＋<small>Save prospect</small></button></div>
      </div> : <div className="empty-state artist-card"><span>⌕</span><h2>No artists loaded yet</h2><p>Search for an artist above, select the right result, then click Find artists.</p></div>}
      <div className="verification-panel">
        {artist ? <>
          <div className="confidence-header"><div><div className="eyebrow">Identity verification</div><h2>{confidenceLabel(artist.confidence)}</h2></div><div className={`score score-${artist.confidence}`}>{artist.confidenceScore}</div></div>
          <div className="confidence-bar"><i style={{ width: `${artist.confidenceScore}%` }} /></div>
          <p className="muted">Scoutline used these sources to connect the Spotify artist to the contact profiles.</p>
          <div className="evidence-list">{artist.evidence.map((evidence, index) => <div className="evidence" key={`${evidence.label}-${index}`}><span className={`evidence-dot ${evidence.strength}`} /><div><strong>{evidence.label}</strong><p>{evidence.value}</p><small>{evidence.source}</small></div><Pill tone={evidence.strength === 'decisive' ? 'green' : 'neutral'}>{evidence.strength}</Pill></div>)}</div>
          {artist.confidenceScore < state.settings.requireReviewBelow && <div className="review-warning">This identity will be held for review before automated outreach.</div>}
          <button className="primary full" onClick={() => setDmArtist(artist)}>Preview personalized DM</button>
        </> : <><div className="empty-state"><span>⌕</span><h2>No artist selected</h2><p>Your discovery queue is empty.</p></div></>}
      </div>
    </div>
    {dmArtist && <DmModal artist={dmArtist} state={state} update={update} close={() => setDmArtist(null)} notify={notify} />}
  </section>;
}

function DmModal({ artist, state, update, close, notify }: { artist: Artist; state: AppState; update: (recipe: (state: AppState) => AppState) => void; close: () => void; notify: (message: string) => void }) {
  const campaign = state.campaigns.find((item) => item.channel === 'Instagram');
  const [template, setTemplate] = useState(campaign?.template || 'Hey <release name> was so good 🔥 Do you have more like this coming? 🙏');
  const generated = template.replaceAll('<release name>', artist.latestRelease || 'your latest release').replaceAll('<artist name>', artist.name);
  const [message, setMessage] = useState(generated);
  const [autoCopy, setAutoCopy] = useState(true);
  const [sending, setSending] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [aiGenerated, setAiGenerated] = useState(false);
  const [error, setError] = useState('');
  const recordContact = (now: string, sent: boolean) => {
    update((current) => ({
      ...current,
      artists: current.artists.some((item) => item.id === artist.id) ? current.artists.map((item) => item.id === artist.id ? { ...item, contactedCount: item.contactedCount + 1, lastContactedAt: now } : item) : [...current.artists, { ...artist, contactedCount: 1, lastContactedAt: now }],
      conversations: sent ? (current.conversations.some((conversation) => conversation.artistId === artist.id && conversation.channel === 'Instagram') ? current.conversations.map((conversation) => conversation.artistId === artist.id && conversation.channel === 'Instagram' ? { ...conversation, updatedAt: now, messages: [...conversation.messages, { id: crypto.randomUUID(), direction: 'outgoing', body: message, createdAt: now, read: true }] } : conversation) : [...current.conversations, { id: crypto.randomUUID(), artistId: artist.id, channel: 'Instagram', updatedAt: now, messages: [{ id: crypto.randomUUID(), direction: 'outgoing', body: message, createdAt: now, read: true }] }]) : current.conversations,
      activities: [{ id: crypto.randomUUID(), artistId: artist.id, type: sent ? 'Instagram DM sent' : 'Marked contacted', detail: `${artist.name} ${sent ? 'received an Instagram DM' : 'was marked as contacted'}.`, createdAt: now }, ...current.activities],
    }));
  };
  const send = async () => {
    if (!artist.instagramHandle && !artist.instagramUrl) { setError('This artist does not have a verified Instagram account.'); return; }
    setSending(true); setError('');
    try {
      const result = await window.scoutline?.sendOutreach({ channel: 'Instagram', recipient: artist.instagramHandle || artist.instagramUrl!, body: message });
      if (!result) throw new Error('Scoutline could not reach the Instagram sender.');
      recordContact(result.sentAt, true);
      if (autoCopy) await navigator.clipboard?.writeText(message);
      notify('Instagram DM sent'); close();
    } catch (reason) { setError(readableError(reason, 'Instagram DM failed.')); }
    finally { setSending(false); }
  };
  const regenerate = async () => {
    if (!window.scoutline) return;
    setGenerating(true); setError('');
    try {
      const facts = [`Artist: ${artist.name}`, artist.latestRelease ? `Latest verified Spotify release: ${artist.latestRelease}` : '', artist.location ? `Location: ${artist.location}` : '', artist.genres.length ? `Genres: ${artist.genres.join(', ')}` : ''].filter(Boolean).join('\n');
      const result = await window.scoutline.runAi({ provider: state.settings.aiProvider, task: 'personalize_outreach', prompt: `Write one short, natural Instagram cold DM using this reusable direction:\n${template}\n\nUse only these verified facts:\n${facts}\n\nKeep it under 45 words. Do not invent praise, listening claims, names, or facts.` });
      setMessage(result.text);
      setAiGenerated(true);
      update((current) => ({ ...current, settings: { ...current.settings, aiCallsThisMonth: current.settings.aiCallsThisMonth + 1, estimatedTokens: current.settings.estimatedTokens + Math.ceil((facts.length + template.length + result.text.length) / 4) } }));
    } catch (reason) { setError(readableError(reason, `${state.settings.aiProvider} generation failed.`)); }
    finally { setGenerating(false); }
  };
  return <div className="modal-backdrop"><div className="modal dm-modal">
    <div className="modal-header"><div><h2>DM on Instagram</h2><p>{artist.name} · {artist.instagramHandle}</p></div><button onClick={close}>×</button></div>
    <div className="modal-body">
      <label className="field"><span>DM template</span><textarea value={template} onChange={(event) => { setTemplate(event.target.value); setMessage(event.target.value.replaceAll('<release name>', artist.latestRelease || 'your latest release').replaceAll('<artist name>', artist.name)); }} /></label>
      <div className="generated-label"><div><span>Generated DM</span><small>Latest Spotify release: {artist.latestRelease || 'not available'} · {artist.latestReleaseType || 'Spotify'}</small></div><Pill tone="green">{aiGenerated ? `${state.settings.aiProvider} rewrite` : 'Cached facts · 0 AI calls'}</Pill></div>
      <textarea className="generated-message" value={message} onChange={(event) => setMessage(event.target.value)} />
      {error && <div className="connection-error">{error}</div>}
      <div className="modal-options"><button className="secondary" disabled={generating} onClick={() => void regenerate()}>{generating ? `${state.settings.aiProvider} is writing…` : `↻ Rewrite with ${state.settings.aiProvider}`}</button><button className="secondary" onClick={() => { setMessage(generated); setAiGenerated(false); }}>Reset template</button><label className="toggle-line"><input type="checkbox" checked={autoCopy} onChange={(event) => setAutoCopy(event.target.checked)} /><span className="toggle" /> Auto copy</label></div>
    </div>
    <div className="modal-footer"><button className="secondary" onClick={close}>Cancel</button><button className="secondary" onClick={() => { recordContact(new Date().toISOString(), false); notify('Marked as contacted'); close(); }}>Mark as contacted</button><button className="primary" disabled={sending || !message.trim()} onClick={() => void send()}>{sending ? 'Sending…' : 'Send Instagram DM'}</button></div>
  </div></div>;
}

function Contacts({ state, update, notify, importRequest }: { state: AppState; update: (recipe: (state: AppState) => AppState) => void; notify: (message: string) => void; importRequest: number }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'All' | Artist['status']>('All');
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Artist | null>(null);
  const [dmArtist, setDmArtist] = useState<Artist | null>(null);
  const [emailArtist, setEmailArtist] = useState<Artist | null>(null);
  useEffect(() => { if (importRequest > 0) setImporting(true); }, [importRequest]);
  const filtered = state.artists.filter((artist) => (status === 'All' || artist.status === status) && artist.name.toLowerCase().includes(search.toLowerCase()));
  return <section className="page page-wide">
    <PageHeader eyebrow="CRM" title="Contacts" description="Verified artist identities, relationships, and complete outreach history." action={<><button className="secondary" onClick={() => setImporting(true)}>Import CSV</button><button className="primary" onClick={() => setCreating(true)}>New contact</button></>} />
    <div className="toolbar"><label className="search"><span>⌕</span><input placeholder="Search artists" value={search} onChange={(event) => setSearch(event.target.value)} /></label><div className="tabs">{(['All', 'Prospect', 'Connection', 'Inactive'] as const).map((item) => <button key={item} onClick={() => setStatus(item)} className={status === item ? 'active' : ''}>{item}<span>{item === 'All' ? state.artists.length : state.artists.filter((artist) => artist.status === item).length}</span></button>)}</div></div>
    <div className="table-wrap"><table><thead><tr><th>Artist</th><th>Identity</th><th>Reach</th><th>Contact</th><th>Status</th><th>Last contacted</th><th /></tr></thead><tbody>
      {filtered.map((artist) => <tr key={artist.id} onClick={() => setSelected(artist)}><td><div className="artist-cell"><Avatar artist={artist} /><div><strong>{artist.name}</strong><small>{artist.location || 'Location unavailable'}</small></div></div></td><td><Pill tone={artist.confidence === 'verified' || artist.confidence === 'high' ? 'green' : artist.confidence === 'review' ? 'amber' : 'neutral'}>{artist.confidenceScore}% {confidenceLabel(artist.confidence)}</Pill></td><td><strong>{number(artist.monthlyListeners)}</strong><small className="cell-note">monthly listeners</small></td><td><div className="contact-icons"><button title="Send Instagram DM" disabled={!artist.instagramHandle && !artist.instagramUrl} className={artist.instagramUrl ? 'available' : ''} onClick={(event) => { event.stopPropagation(); setDmArtist(artist); }}>◎</button><button title="Send email" disabled={!artist.email} className={artist.email ? 'available' : ''} onClick={(event) => { event.stopPropagation(); setEmailArtist(artist); }}>✉</button></div></td><td><Pill tone={artist.status === 'Connection' ? 'purple' : 'neutral'}>{artist.status}</Pill></td><td>{timeAgo(artist.lastContactedAt)}</td><td>›</td></tr>)}
    </tbody></table>{filtered.length === 0 && <div className="table-empty">No matching contacts.</div>}</div>
    {importing && <ImportModal state={state} update={update} close={() => setImporting(false)} notify={notify} />}
    {creating && <NewContactModal update={update} close={() => setCreating(false)} notify={notify} />}
    {selected && <ContactDrawer artist={state.artists.find((artist) => artist.id === selected.id) || selected} update={update} close={() => setSelected(null)} />}
    {dmArtist && <DmModal artist={dmArtist} state={state} update={update} close={() => setDmArtist(null)} notify={notify} />}
    {emailArtist && <EmailModal artist={emailArtist} state={state} update={update} close={() => setEmailArtist(null)} notify={notify} />}
  </section>;
}

function EmailModal({ artist, state, update, close, notify }: { artist: Artist; state: AppState; update: (recipe: (state: AppState) => AppState) => void; close: () => void; notify: (message: string) => void }) {
  const campaign = state.campaigns.find((item) => item.channel === 'Email');
  const [subject, setSubject] = useState((campaign?.subject || 'Quick note for <artist name>').replaceAll(/<artist name>/gi, artist.name));
  const [body, setBody] = useState((campaign?.template || 'Hey <artist name>,\n\n<release name> was so good. Do you have more like this coming?\n\nBest,\nProducer').replaceAll(/<artist name>/gi, artist.name).replaceAll(/<release name>/gi, artist.latestRelease || 'Your latest release'));
  const [packId, setPackId] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const send = async () => {
    if (!artist.email || !window.scoutline) { setError('This artist does not have a verified public email.'); return; }
    const pack = state.packs.find((item) => item.id === packId);
    const attachments = pack ? state.assets.filter((asset) => pack.assetIds.includes(asset.id) && asset.path).map((asset) => asset.path!) : [];
    setSending(true); setError('');
    try {
      const result = await window.scoutline.sendOutreach({ channel: 'Email', recipient: artist.email, subject, body, attachments });
      update((current) => ({
        ...current,
        artists: current.artists.map((item) => item.id === artist.id ? { ...item, contactedCount: item.contactedCount + 1, lastContactedAt: result.sentAt } : item),
        conversations: current.conversations.some((conversation) => conversation.artistId === artist.id && conversation.channel === 'Email') ? current.conversations.map((conversation) => conversation.artistId === artist.id && conversation.channel === 'Email' ? { ...conversation, subject, updatedAt: result.sentAt, messages: [...conversation.messages, { id: crypto.randomUUID(), direction: 'outgoing', body, createdAt: result.sentAt, read: true }] } : conversation) : [...current.conversations, { id: crypto.randomUUID(), artistId: artist.id, channel: 'Email', subject, updatedAt: result.sentAt, messages: [{ id: crypto.randomUUID(), direction: 'outgoing', body, createdAt: result.sentAt, read: true }] }],
        packs: pack ? current.packs.map((item) => item.id === pack.id ? { ...item, timesSent: item.timesSent + 1 } : item) : current.packs,
        activities: [{ id: crypto.randomUUID(), artistId: artist.id, type: 'Email sent', detail: `Email sent to ${artist.name}${pack ? ` with ${pack.name}` : ''}.`, createdAt: result.sentAt }, ...current.activities],
      }));
      notify('Email sent'); close();
    } catch (reason) { setError(readableError(reason, 'Email failed.')); }
    finally { setSending(false); }
  };
  return <div className="modal-backdrop"><div data-testid="email-modal" className="modal"><div className="modal-header"><div><h2>Email {artist.name}</h2><p>{artist.email}</p></div><button onClick={close}>×</button></div><div className="modal-body tool-workspace"><label className="field"><span>Subject</span><input value={subject} onChange={(event) => setSubject(event.target.value)} /></label><label className="field"><span>Message</span><textarea value={body} onChange={(event) => setBody(event.target.value)} /></label><label className="field"><span>Attach pack (optional)</span><select value={packId} onChange={(event) => setPackId(event.target.value)}><option value="">No attachment</option>{state.packs.map((pack) => <option key={pack.id} value={pack.id}>{pack.name}</option>)}</select></label>{error && <div className="connection-error">{error}</div>}</div><div className="modal-footer"><button className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={sending || !subject.trim() || !body.trim()} onClick={() => void send()}>{sending ? 'Sending…' : 'Send email'}</button></div></div></div>;
}

function NewContactModal({ update, close, notify }: { update: (recipe: (state: AppState) => AppState) => void; close: () => void; notify: (message: string) => void }) {
  const [name, setName] = useState('');
  const [spotifyUrl, setSpotifyUrl] = useState('');
  const [instagramUrl, setInstagramUrl] = useState('');
  const [email, setEmail] = useState('');
  const [listeners, setListeners] = useState('');
  const [location, setLocation] = useState('');
  const save = () => {
    const instagramHandle = instagramUrl ? `@${instagramUrl.split('/').filter(Boolean).at(-1)?.replace(/^@/, '')}` : undefined;
    const artist: Artist = { id: crypto.randomUUID(), name: name.trim(), status: 'Prospect', spotifyUrl: spotifyUrl.trim() || undefined, instagramUrl: instagramUrl.trim() || undefined, instagramHandle, email: email.trim() || undefined, monthlyListeners: Number(listeners) || 0, instagramFollowers: 0, location: location.trim() || undefined, genres: [], confidence: instagramUrl || email ? 'review' : 'unverified', confidenceScore: instagramUrl || email ? 60 : 0, evidence: [], source: 'Manual contact', createdAt: new Date().toISOString(), contactedCount: 0, lists: [] };
    update((current) => ({ ...current, artists: [...current.artists, artist], activities: [{ id: crypto.randomUUID(), artistId: artist.id, type: 'Contact created', detail: `${artist.name} was added manually.`, createdAt: artist.createdAt }, ...current.activities] }));
    notify(`${artist.name} added`); close();
  };
  return <div className="modal-backdrop"><div data-testid="new-contact-modal" className="modal"><div className="modal-header"><div><h2>New contact</h2><p>Add an artist directly to the CRM.</p></div><button onClick={close}>×</button></div><div className="modal-body tool-workspace"><label className="field"><span>Artist name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label><div className="two-fields"><label className="field"><span>Spotify URL</span><input value={spotifyUrl} onChange={(event) => setSpotifyUrl(event.target.value)} /></label><label className="field"><span>Instagram URL</span><input value={instagramUrl} onChange={(event) => setInstagramUrl(event.target.value)} /></label><label className="field"><span>Public email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label className="field"><span>Monthly listeners</span><input type="number" value={listeners} onChange={(event) => setListeners(event.target.value)} /></label></div><label className="field"><span>Location</span><input value={location} onChange={(event) => setLocation(event.target.value)} /></label></div><div className="modal-footer"><button className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={!name.trim()} onClick={save}>Save contact</button></div></div></div>;
}

function ContactDrawer({ artist, update, close }: { artist: Artist; update: (recipe: (state: AppState) => AppState) => void; close: () => void }) {
  return <div className="drawer-backdrop" onClick={close}><aside className="drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-head"><button onClick={close}>×</button></div><div className="contact-profile"><Avatar artist={artist} large /><h2>{artist.name}</h2><p>{artist.genres.join(' · ') || 'Genres not available'}</p><Pill tone={artist.confidenceScore >= 90 ? 'green' : 'amber'}>{artist.confidenceScore}% identity confidence</Pill></div><div className="drawer-section"><h3>Contact details</h3><dl><div><dt>Instagram</dt><dd>{artist.instagramHandle || 'Not verified'}</dd></div><div><dt>Email</dt><dd>{artist.email || 'Not found'}</dd></div><div><dt>Spotify listeners</dt><dd>{number(artist.monthlyListeners)}</dd></div><div><dt>Source</dt><dd>{artist.source}</dd></div></dl></div><div className="drawer-section"><h3>Evidence</h3>{artist.evidence.length ? artist.evidence.map((item, index) => <div className="mini-evidence" key={index}><span className={`evidence-dot ${item.strength}`} /><div><strong>{item.value}</strong><small>{item.source}</small></div></div>) : <p className="muted">Identity verification has not run yet.</p>}</div><div className="drawer-section"><h3>Relationship</h3><select value={artist.status} onChange={(event) => update((state) => ({ ...state, artists: state.artists.map((item) => item.id === artist.id ? { ...item, status: event.target.value as Artist['status'] } : item) }))}><option>Prospect</option><option>Connection</option><option>Inactive</option></select></div></aside></div>;
}

function ImportModal({ state, update, close, notify }: { state: AppState; update: (recipe: (state: AppState) => AppState) => void; close: () => void; notify: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<Record<number, ArtistField>>({});
  const load = async (file: File) => { const result = parseCsv(await file.text()); setFileName(file.name); setParsed(result); setMapping(inferMapping(result.headers)); };
  const commit = () => {
    if (!parsed) return;
    const source = /viberate/i.test(fileName) ? 'Viberate CSV' : /chartmetric/i.test(fileName) ? 'Chartmetric CSV' : `CSV · ${fileName}`;
    const incoming = rowsToArtists(parsed, mapping, source);
    const result = mergeArtists(state.artists, incoming);
    update((current) => ({ ...current, artists: result.artists, activities: [{ id: crypto.randomUUID(), type: 'CSV imported', detail: `${fileName}: ${result.added} added, ${result.merged} merged.`, createdAt: new Date().toISOString() }, ...current.activities] }));
    notify(`${result.added} added · ${result.merged} merged`); close();
  };
  return <div className="modal-backdrop"><div className="modal import-modal"><div className="modal-header"><div><h2>Import artist list</h2><p>Chartmetric, Viberate, or a custom CSV</p></div><button onClick={close}>×</button></div><div className="modal-body">
    {!parsed ? <button className="dropzone" onClick={() => input.current?.click()}><span>⇧</span><strong>Choose a CSV file</strong><small>Scoutline will detect common Chartmetric and Viberate fields automatically.</small></button> : <><div className="import-summary"><div><strong>{fileName}</strong><span>{parsed.rows.length} rows · {parsed.headers.length} columns</span></div><Pill tone="green">Ready to map</Pill></div><div className="mapping-list"><div className="mapping-heading"><span>CSV column</span><span>Scoutline field</span><span>Sample</span></div>{parsed.headers.map((header, index) => <div className="mapping-row" key={`${header}-${index}`}><strong>{header}</strong><select value={mapping[index] || 'ignore'} onChange={(event) => setMapping({ ...mapping, [index]: event.target.value as ArtistField })}>{Object.entries(fieldLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><span>{parsed.rows[0]?.[index] || '—'}</span></div>)}</div></>}
    <input ref={input} hidden type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void load(file); }} />
  </div><div className="modal-footer"><button className="secondary" onClick={close}>Cancel</button>{parsed && <button className="primary" disabled={!Object.values(mapping).includes('name')} onClick={commit}>Import and merge</button>}</div></div></div>;
}

function Inbox({ state, update, notify }: { state: AppState; update: (recipe: (state: AppState) => AppState) => void; notify: (message: string) => void }) {
  const [channel, setChannel] = useState<'All' | 'Instagram' | 'Email'>('All');
  const visible = state.conversations.filter((conversation) => channel === 'All' || conversation.channel === channel).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const [selectedId, setSelectedId] = useState(visible[0]?.id || '');
  const selected = state.conversations.find((conversation) => conversation.id === selectedId) || visible[0];
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const artist = selected ? state.artists.find((item) => item.id === selected.artistId) : undefined;
  const openThread = (id: string) => {
    setSelectedId(id);
    update((current) => ({ ...current, conversations: current.conversations.map((conversation) => conversation.id === id ? { ...conversation, messages: conversation.messages.map((message) => ({ ...message, read: true })) } : conversation) }));
  };
  const sync = async () => {
    if (!window.scoutline) return;
    const reached = state.artists.filter((candidate) => candidate.contactedCount > 0 || state.conversations.some((conversation) => conversation.artistId === candidate.id && conversation.messages.some((message) => message.direction === 'outgoing')));
    if (!reached.length) { setSyncError('There are no contacted artists to sync yet.'); return; }
    setSyncing(true); setSyncError('');
    try {
      const result = await window.scoutline.syncInbox(reached.map((candidate) => ({ artistId: candidate.id, email: candidate.email, instagramHandle: candidate.instagramHandle })));
      const currentMessageIds = new Set(state.conversations.flatMap((conversation) => conversation.messages.map((message) => message.id)));
      const newMessages = result.messages.filter((message) => !currentMessageIds.has(message.id));
      const added = newMessages.length;
      const firstReplies = new Set(newMessages.filter((message) => !state.conversations.some((conversation) => conversation.artistId === message.artistId && conversation.channel === message.channel && conversation.messages.some((item) => item.direction === 'incoming'))).map((message) => `${message.channel}:${message.artistId}`));
      update((current) => {
        const knownMessageIds = new Set(current.conversations.flatMap((conversation) => conversation.messages.map((message) => message.id)));
        const conversations = [...current.conversations];
        const newlyRepliedArtists = new Set<string>();
        for (const incoming of newMessages) {
          if (knownMessageIds.has(incoming.id)) continue;
          knownMessageIds.add(incoming.id); newlyRepliedArtists.add(incoming.artistId);
          const existingIndex = conversations.findIndex((conversation) => conversation.artistId === incoming.artistId && conversation.channel === incoming.channel);
          const message = { id: incoming.id, direction: 'incoming' as const, body: incoming.body, createdAt: incoming.createdAt, read: false };
          if (existingIndex >= 0) conversations[existingIndex] = { ...conversations[existingIndex], subject: incoming.subject || conversations[existingIndex].subject, updatedAt: incoming.createdAt, messages: [...conversations[existingIndex].messages, message].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
          else conversations.push({ id: crypto.randomUUID(), artistId: incoming.artistId, channel: incoming.channel, subject: incoming.subject, updatedAt: incoming.createdAt, messages: [message] });
        }
        return {
          ...current,
          artists: current.artists.map((candidate) => newlyRepliedArtists.has(candidate.id) ? { ...candidate, status: 'Connection' } : candidate),
          conversations,
          campaigns: current.campaigns.map((campaign) => ({ ...campaign, replied: campaign.replied + (campaign.artistIds || []).filter((artistId) => firstReplies.has(`${campaign.channel}:${artistId}`)).length })),
          activities: added ? [{ id: crypto.randomUUID(), type: 'Inbox synced', detail: `${added} new artist ${added === 1 ? 'reply' : 'replies'} imported from ${result.syncedChannels.join(' and ')}.`, createdAt: new Date().toISOString() }, ...current.activities] : current.activities,
        };
      });
      setSyncError(result.warnings.join(' '));
      notify(added ? `${added} new ${added === 1 ? 'reply' : 'replies'}` : 'Inbox is up to date');
    } catch (reason) { setSyncError(readableError(reason, 'Inbox sync failed.')); }
    finally { setSyncing(false); }
  };
  const send = async () => {
    if (!selected || !artist || !reply.trim()) return;
    const recipient = selected.channel === 'Email' ? artist.email : artist.instagramHandle || artist.instagramUrl;
    if (!recipient) { setSendError(`No verified ${selected.channel === 'Email' ? 'email address' : 'Instagram account'} for ${artist.name}.`); return; }
    setSending(true); setSendError('');
    try {
      const body = reply.trim();
      const replySubject = selected.subject ? (/^re:/i.test(selected.subject) ? selected.subject : `Re: ${selected.subject}`) : `Re: ${artist.name}`;
      const result = await window.scoutline?.sendOutreach({ channel: selected.channel, recipient, body, subject: replySubject });
      if (!result) throw new Error('Scoutline could not reach the sender.');
      update((current) => ({ ...current, conversations: current.conversations.map((conversation) => conversation.id === selected.id ? { ...conversation, updatedAt: result.sentAt, messages: [...conversation.messages, { id: crypto.randomUUID(), direction: 'outgoing', body, createdAt: result.sentAt, read: true }] } : conversation) }));
      setReply(''); notify('Reply sent');
    } catch (reason) { setSendError(readableError(reason, 'Reply failed.')); }
    finally { setSending(false); }
  };
  return <section className="page page-flush"><PageHeader eyebrow="Unified replies" title="Inbox" description="Only messages from artists contacted through Scoutline." action={<button data-testid="sync-inbox" className="primary" disabled={syncing} onClick={() => void sync()}>{syncing ? 'Syncing…' : 'Sync replies'}</button>} />{syncError && <div className="connection-error inbox-sync-error">{syncError}</div>}<div className="inbox-shell"><div className="thread-sidebar"><div className="tabs inbox-tabs">{(['All', 'Instagram', 'Email'] as const).map((item) => <button className={channel === item ? 'active' : ''} onClick={() => setChannel(item)} key={item}>{item}</button>)}</div><div className="thread-list">{visible.map((thread) => { const contact = state.artists.find((item) => item.id === thread.artistId); const last = thread.messages.at(-1); const unread = thread.messages.some((message) => message.direction === 'incoming' && !message.read); return contact && <button className={`thread ${selected?.id === thread.id ? 'selected' : ''}`} key={thread.id} onClick={() => openThread(thread.id)}><Avatar artist={contact} /><div><div><strong>{contact.name}</strong><time>{timeAgo(thread.updatedAt)}</time></div><span>{thread.channel}</span><p>{last?.body}</p></div>{unread && <i />}</button>; })}</div></div><div className="conversation">{selected && artist ? <><div className="conversation-head"><div className="artist-cell"><Avatar artist={artist} /><div><strong>{artist.name}</strong><small>{selected.channel} · {artist.instagramHandle || artist.email}</small></div></div></div><div className="messages">{selected.messages.map((message) => <div className={`message ${message.direction}`} key={message.id}><small>{message.direction === 'incoming' ? artist.name : 'You'}</small><p>{message.body}</p><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div>)}</div><div className="composer"><textarea value={reply} onChange={(event) => setReply(event.target.value)} placeholder={`Reply to ${artist.name}…`} />{sendError && <div className="connection-error">{sendError}</div>}<div><span>Sends through the connected {selected.channel} account</span><button className="primary" disabled={sending || !reply.trim()} onClick={() => void send()}>{sending ? 'Sending…' : 'Send reply'}</button></div></div></> : <div className="empty-state"><span>▤</span><h2>No conversations</h2><p>Replies from Scoutline outreach will appear here.</p></div>}</div></div></section>;
}

function Campaigns({ state, update, notify }: { state: AppState; update: (recipe: (state: AppState) => AppState) => void; notify: (message: string) => void }) {
  const [editing, setEditing] = useState<Campaign | 'new' | null>(null);
  const [actionError, setActionError] = useState('');
  const save = (campaign: Campaign) => { update((current) => ({ ...current, campaigns: current.campaigns.some((item) => item.id === campaign.id) ? current.campaigns.map((item) => item.id === campaign.id ? campaign : item) : [...current.campaigns, campaign] })); setEditing(null); notify('Campaign saved'); };
  const run = async (campaign: Campaign) => {
    setActionError('');
    try { await window.scoutline?.saveState(state); await window.scoutline?.startCampaign(campaign.id); notify(campaign.status === 'Paused' ? 'Campaign resumed' : 'Campaign started'); }
    catch (reason) { setActionError(readableError(reason, 'Campaign could not start.')); }
  };
  const pause = async (campaign: Campaign) => { setActionError(''); try { await window.scoutline?.pauseCampaign(campaign.id); notify('Campaign paused'); } catch (reason) { setActionError(readableError(reason, 'Campaign could not pause.')); } };
  return <section className="page page-wide"><PageHeader eyebrow="Outreach" title="Campaigns" description="Personalized Instagram and email outreach without Scoutline-imposed limits." action={<button className="primary" onClick={() => setEditing('new')}>New campaign</button>} />{actionError && <div className="connection-error">{actionError}</div>}<div className="stats-grid stats-small"><Stat label="Sent" value={state.campaigns.reduce((t, c) => t + c.sent, 0)} note="All time" /><Stat label="Queued" value={state.campaigns.reduce((t, c) => t + c.queued, 0)} note="Waiting to send" /><Stat label="Replies" value={state.campaigns.reduce((t, c) => t + c.replied, 0)} note="Across both channels" /><Stat label="Failures" value={state.campaigns.reduce((t, c) => t + c.failed, 0)} note="Held for review" /></div><div className="cards-list">{state.campaigns.map((campaign) => <div className="campaign-card" key={campaign.id}><div className={`campaign-channel ${campaign.channel.toLowerCase()}`}>{campaign.channel === 'Email' ? '✉' : '◎'}</div><button className="campaign-main campaign-open" onClick={() => setEditing(campaign)}><div><h3>{campaign.name}</h3><Pill>{campaign.status}</Pill></div><p>{campaign.template}</p><div className="campaign-meta"><span>{campaign.queued} queued</span><span>{campaign.sent} sent</span><span>{campaign.replied} replies</span><span>{campaign.pacingSeconds}s pacing</span>{campaign.packId && <span>pack attached</span>}</div></button>{campaign.status === 'Active' ? <button className="secondary" onClick={() => void pause(campaign)}>Pause</button> : <button className="secondary" disabled={!campaign.artistIds?.length} onClick={() => void run(campaign)}>{campaign.status === 'Paused' ? 'Resume' : 'Run now'}</button>}</div>)}</div>{editing && <CampaignModal campaign={editing === 'new' ? undefined : editing} artists={state.artists} packs={state.packs} close={() => setEditing(null)} save={save} />}</section>;
}

function CampaignModal({ campaign, artists, packs, close, save }: { campaign?: Campaign; artists: Artist[]; packs: Pack[]; close: () => void; save: (campaign: Campaign) => void }) {
  const [name, setName] = useState(campaign?.name || '');
  const [channel, setChannel] = useState<Campaign['channel']>(campaign?.channel || 'Instagram');
  const [subject, setSubject] = useState(campaign?.subject || 'Quick note for <artist name>');
  const [template, setTemplate] = useState(campaign?.template || 'Hey <artist name>, <release name> was so good 🔥 Do you have more like this coming?');
  const [pacing, setPacing] = useState(String(campaign?.pacingSeconds ?? 60));
  const [artistIds, setArtistIds] = useState<string[]>(campaign?.artistIds || []);
  const [packId, setPackId] = useState(campaign?.packId || '');
  const eligible = artists.filter((artist) => channel === 'Email' ? artist.email : artist.instagramHandle || artist.instagramUrl);
  const commit = () => save({ id: campaign?.id || crypto.randomUUID(), name: name.trim(), channel, subject: channel === 'Email' ? subject : undefined, template, pacingSeconds: Math.max(0, Number(pacing) || 0), artistIds, packId: channel === 'Email' && packId ? packId : undefined, status: campaign?.status || 'Draft', sent: campaign?.sent || 0, queued: campaign?.queued || 0, replied: campaign?.replied || 0, failed: campaign?.failed || 0, createdAt: campaign?.createdAt || new Date().toISOString() });
  return <div className="modal-backdrop"><div data-testid="campaign-modal" className="modal campaign-modal"><div className="modal-header"><div><h2>{campaign ? 'Edit campaign' : 'New campaign'}</h2><p>Select recipients, message, and pacing.</p></div><button onClick={close}>×</button></div><div className="modal-body tool-workspace"><div className="two-fields"><label className="field"><span>Name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label><label className="field"><span>Channel</span><select value={channel} onChange={(event) => { setChannel(event.target.value as Campaign['channel']); setArtistIds([]); }}><option>Instagram</option><option>Email</option></select></label></div>{channel === 'Email' && <><label className="field"><span>Subject</span><input value={subject} onChange={(event) => setSubject(event.target.value)} /></label><label className="field"><span>Attach pack (optional)</span><select value={packId} onChange={(event) => setPackId(event.target.value)}><option value="">No attachment</option>{packs.map((pack) => <option key={pack.id} value={pack.id}>{pack.name} · {pack.assetIds.length} files</option>)}</select></label></>}<label className="field"><span>Message template</span><textarea value={template} onChange={(event) => setTemplate(event.target.value)} /></label><label className="field"><span>Seconds between sends</span><input type="number" min="0" value={pacing} onChange={(event) => setPacing(event.target.value)} /></label><div className="recipient-picker"><div><strong>Recipients</strong><button className="link-button" onClick={() => setArtistIds(eligible.map((artist) => artist.id))}>Select all {eligible.length}</button></div>{eligible.map((artist) => <label key={artist.id}><input type="checkbox" checked={artistIds.includes(artist.id)} onChange={() => setArtistIds((current) => current.includes(artist.id) ? current.filter((id) => id !== artist.id) : [...current, artist.id])} /><Avatar artist={artist} /><span>{artist.name}</span><small>{channel === 'Email' ? artist.email : artist.instagramHandle}</small></label>)}</div></div><div className="modal-footer"><button className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={!name.trim() || !template.trim() || !artistIds.length} onClick={commit}>Save campaign</button></div></div></div>;
}

function Files({ state, update, notify }: { state: AppState; update: (recipe: (state: AppState) => AppState) => void; notify: (message: string) => void }) {
  const [menu, setMenu] = useState('');
  const add = async () => {
    const paths = window.scoutline ? await window.scoutline.selectFiles() : [];
    if (!paths.length) return;
    const fileInfo = await window.scoutline?.fileInfo(paths) || [];
    const sizes = new Map(fileInfo.map((item) => [item.path, item.size]));
    const added = paths.map((path) => { const extension = path.split('.').at(-1)?.toLowerCase() || ''; const kind = ['wav', 'mp3', 'aif', 'aiff', 'flac', 'm4a'].includes(extension) ? 'Audio' as const : ['png', 'jpg', 'jpeg', 'webp', 'gif', 'tiff'].includes(extension) ? 'Artwork' as const : 'Document' as const; const bytes = sizes.get(path) || 0; const size = bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; return { id: crypto.randomUUID(), name: path.split('/').at(-1) || path, path, kind, tags: [], size, createdAt: new Date().toISOString() }; });
    update((current) => ({ ...current, assets: [...current.assets, ...added] })); notify(`${added.length} files imported`);
  };
  return <section className="page page-wide"><PageHeader eyebrow="Asset library" title="Files" description="Local assets for outreach, packs, and YouTube uploads." action={<button className="primary" onClick={() => void add()}>Import files</button>} /><div className="asset-grid">{state.assets.map((asset) => <div className="asset-card" key={asset.id}><div className={`asset-preview ${asset.kind.toLowerCase()}`}>{asset.kind === 'Audio' ? '♫' : asset.kind === 'Artwork' ? '▧' : '▤'}</div><div><Pill>{asset.kind}</Pill><h3>{asset.name}</h3><p>{asset.size}</p><div className="tag-row">{asset.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div></div><div className="menu-wrap"><button className="more" onClick={() => setMenu(menu === asset.id ? '' : asset.id)}>•••</button>{menu === asset.id && <div className="context-menu"><button disabled={!asset.path} onClick={() => { if (asset.path) void window.scoutline?.openPath(asset.path); setMenu(''); }}>Open file</button><button className="danger-text" onClick={() => { update((current) => ({ ...current, assets: current.assets.filter((item) => item.id !== asset.id), packs: current.packs.map((pack) => ({ ...pack, assetIds: pack.assetIds.filter((id) => id !== asset.id) })) })); setMenu(''); }}>Remove</button></div>}</div></div>)}</div></section>;
}

function Packs({ state, update, notify }: { state: AppState; update: (recipe: (state: AppState) => AppState) => void; notify: (message: string) => void }) {
  const [editing, setEditing] = useState<Pack | 'new' | null>(null);
  const save = (pack: Pack) => { update((current) => ({ ...current, packs: current.packs.some((item) => item.id === pack.id) ? current.packs.map((item) => item.id === pack.id ? pack : item) : [...current.packs, pack] })); setEditing(null); notify('Pack saved'); };
  return <section className="page page-wide"><PageHeader eyebrow="Reusable delivery" title="Packs" description="Group files once, then deliver the right pack without repeats." action={<button className="primary" onClick={() => setEditing('new')}>New pack</button>} /><div className="pack-grid">{state.packs.map((pack) => <div className="pack-card" key={pack.id}><div className="pack-stack"><i /><i /><i><span>◇</span></i></div><h3>{pack.name}</h3><p>{pack.assetIds.length} files · sent {pack.timesSent} times</p><div className="tag-row">{pack.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div><button className="secondary full" onClick={() => setEditing(pack)}>Open pack</button></div>)}</div>{editing && <PackModal pack={editing === 'new' ? undefined : editing} assets={state.assets} close={() => setEditing(null)} save={save} />}</section>;
}

function PackModal({ pack, assets, close, save }: { pack?: Pack; assets: AppState['assets']; close: () => void; save: (pack: Pack) => void }) {
  const [name, setName] = useState(pack?.name || '');
  const [tags, setTags] = useState(pack?.tags.join(', ') || '');
  const [assetIds, setAssetIds] = useState<string[]>(pack?.assetIds || []);
  const commit = () => save({ id: pack?.id || crypto.randomUUID(), name: name.trim(), tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), assetIds, timesSent: pack?.timesSent || 0 });
  return <div className="modal-backdrop"><div data-testid="pack-modal" className="modal"><div className="modal-header"><div><h2>{pack ? 'Edit pack' : 'New pack'}</h2><p>Select the local files delivered together.</p></div><button onClick={close}>×</button></div><div className="modal-body tool-workspace"><label className="field"><span>Pack name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label><label className="field"><span>Tags</span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="dark, melodic, friday" /></label><div className="asset-picker">{assets.map((asset) => <label key={asset.id}><input type="checkbox" checked={assetIds.includes(asset.id)} onChange={() => setAssetIds((current) => current.includes(asset.id) ? current.filter((id) => id !== asset.id) : [...current, asset.id])} /><span>{asset.name}</span><small>{asset.kind}</small></label>)}{assets.length === 0 && <p className="muted">Import files before creating a pack.</p>}</div></div><div className="modal-footer"><button className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={!name.trim()} onClick={commit}>Save pack</button></div></div></div>;
}

function Automations({ state, update, notify }: { state: AppState; update: (recipe: (state: AppState) => AppState) => void; notify: (message: string) => void }) {
  const [editing, setEditing] = useState<Automation | null | 'new'>(null);
  const [menu, setMenu] = useState('');
  const [runError, setRunError] = useState('');
  const save = (automation: Automation) => {
    update((current) => ({ ...current, automations: current.automations.some((item) => item.id === automation.id) ? current.automations.map((item) => item.id === automation.id ? automation : item) : [...current.automations, automation] }));
    setEditing(null); notify('Automation saved');
  };
  const duplicate = (automation: Automation) => {
    update((current) => ({ ...current, automations: [...current.automations, { ...automation, id: crypto.randomUUID(), name: `${automation.name} copy`, enabled: false, lastRun: undefined }] }));
    setMenu(''); notify('Automation duplicated');
  };
  const remove = (automation: Automation) => {
    update((current) => ({ ...current, automations: current.automations.filter((item) => item.id !== automation.id) }));
    setMenu(''); notify('Automation deleted');
  };
  const runNow = async (automation: Automation) => {
    setRunError(''); setMenu('');
    try { await window.scoutline?.saveState(state); await window.scoutline?.runAutomation(automation.id); notify(`${automation.name} queued`); }
    catch (reason) { setRunError(readableError(reason, 'Automation could not run.')); }
  };
  return <section className="page page-wide">
    <PageHeader eyebrow="Background workflows" title="Automations" description="Create and manage triggers, actions, and schedules." action={<button data-testid="new-automation" className="primary" onClick={() => setEditing('new')}>New automation</button>} />
    {runError && <div className="connection-error">{runError}</div>}
    <div className="automation-list">{state.automations.map((automation) => <div className="automation-card" key={automation.id}>
      <label className="toggle-line"><input type="checkbox" checked={automation.enabled} onChange={() => update((current) => ({ ...current, automations: current.automations.map((item) => item.id === automation.id ? { ...item, enabled: !item.enabled } : item) }))} /><span className="toggle" /></label>
      <div className="automation-icon">✦</div>
      <button className="automation-main automation-open" onClick={() => setEditing(automation)}><div><h3>{automation.name}</h3><Pill tone={automation.enabled ? 'green' : 'neutral'}>{automation.enabled ? 'Active' : 'Off'}</Pill></div><div className="workflow-line"><span><small>WHEN</small>{automation.trigger}</span><b>→</b><span><small>THEN</small>{automation.action}</span><b>→</b><span><small>SCHEDULE</small>{automation.schedule}</span></div>{automation.lastRun && <small>Last ran {timeAgo(automation.lastRun)}</small>}{automation.lastError && <small className="automation-error">{automation.lastError}</small>}</button>
      <div className="menu-wrap"><button className="more" onClick={() => setMenu(menu === automation.id ? '' : automation.id)}>•••</button>{menu === automation.id && <div className="context-menu"><button onClick={() => void runNow(automation)}>Run now</button><button onClick={() => { setEditing(automation); setMenu(''); }}>Edit</button><button onClick={() => duplicate(automation)}>Duplicate</button><button className="danger-text" onClick={() => remove(automation)}>Delete</button></div>}</div>
    </div>)}</div>
    {editing && <AutomationModal automation={editing === 'new' ? undefined : editing} packs={state.packs} close={() => setEditing(null)} save={save} />}
  </section>;
}

function AutomationModal({ automation, packs, close, save }: { automation?: Automation; packs: Pack[]; close: () => void; save: (automation: Automation) => void }) {
  const [name, setName] = useState(automation?.name || '');
  const [trigger, setTrigger] = useState(automation?.trigger || 'Status changes to Connection');
  const [action, setAction] = useState(automation?.action || 'Send welcome email');
  const [schedule, setSchedule] = useState(automation?.schedule || 'After 1 minute');
  const [subject, setSubject] = useState(automation?.subject || 'Great connecting, <artist name>');
  const [message, setMessage] = useState(automation?.message || 'Hey <artist name>,\n\nGreat connecting with you.\n\nBest,\nProducer');
  const [packId, setPackId] = useState(automation?.packId || '');
  const [targetStatus, setTargetStatus] = useState<Artist['status']>(automation?.targetStatus || 'Connection');
  const changeAction = (next: string) => {
    setAction(next);
    if (/welcome email/i.test(next)) { setSubject('Great connecting, <artist name>'); setMessage('Hey <artist name>,\n\nGreat connecting with you.\n\nBest,\nProducer'); }
    else if (/pack/i.test(next)) { setSubject('<pack name>'); setMessage('Hey <artist name>,\n\nHere is the selected pack. Let me know what stands out.\n\nBest,\nProducer'); }
    else if (/follow-up/i.test(next)) setMessage('Hey <artist name>, just following up on my last message. Would you mind if I send you a link with some quick info?');
    else if (/review task/i.test(next)) setMessage('Review <artist name> and decide the next outreach step.');
  };
  const commit = () => save({ id: automation?.id || crypto.randomUUID(), name: name.trim(), trigger, action, schedule, subject: /email|pack/i.test(action) ? subject : undefined, message: /email|pack|follow-up|review task/i.test(action) ? message : undefined, packId: /pack/i.test(action) && packId ? packId : undefined, targetStatus: /Change contact status/i.test(action) ? targetStatus : undefined, enabled: automation?.enabled || false, lastRun: automation?.lastRun, lastError: automation?.lastError });
  return <div className="modal-backdrop"><div data-testid="automation-modal" className="modal automation-modal"><div className="modal-header"><div><h2>{automation ? 'Edit automation' : 'New automation'}</h2><p>Define exactly when this workflow should run.</p></div><button onClick={close}>×</button></div><div className="modal-body automation-builder"><label className="field"><span>Name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Automation name" /></label><div className="builder-step"><b>WHEN</b><label className="field"><span>Trigger</span><select value={trigger} onChange={(event) => setTrigger(event.target.value)}><option>Status changes to Connection</option><option>New prospect is saved</option><option>Reply is received</option><option>Every Friday</option><option>Contact has not replied</option></select></label></div><div className="builder-step"><b>THEN</b><label className="field"><span>Action</span><select value={action} onChange={(event) => changeAction(event.target.value)}><option>Send welcome email</option><option>Send newest tagged pack</option><option>Send Instagram follow-up</option><option>Change contact status</option><option>Create a review task</option></select></label></div>{/Send welcome email|Send newest tagged pack/i.test(action) && <label className="field"><span>Email subject</span><input value={subject} onChange={(event) => setSubject(event.target.value)} /></label>}{/Send newest tagged pack/i.test(action) && <label className="field"><span>Pack</span><select value={packId} onChange={(event) => setPackId(event.target.value)}><option value="">Newest pack</option>{packs.map((pack) => <option value={pack.id} key={pack.id}>{pack.name}</option>)}</select></label>}{/Send welcome email|Send newest tagged pack|Instagram follow-up|review task/i.test(action) && <label className="field"><span>{/review task/i.test(action) ? 'Task text' : 'Message'}</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} /></label>}{/Change contact status/i.test(action) && <label className="field"><span>New status</span><select value={targetStatus} onChange={(event) => setTargetStatus(event.target.value as Artist['status'])}><option>Prospect</option><option>Connection</option><option>Inactive</option></select></label>}<div className="builder-step"><b>SCHEDULE</b><label className="field"><span>Timing</span><select value={schedule} onChange={(event) => setSchedule(event.target.value)}><option>After 1 minute</option><option>After 1 day</option><option>After 7 days</option><option>10:30 AM ET</option><option>Immediately after audit</option></select></label></div></div><div className="modal-footer"><button className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={!name.trim()} onClick={commit}>Save automation</button></div></div></div>;
}

function YouTube({ state, update, notify }: { state: AppState; update: (recipe: (state: AppState) => AppState) => void; notify: (message: string) => void }) {
  const audio = state.assets.filter((asset) => asset.kind === 'Audio' && asset.path); const art = state.assets.filter((asset) => asset.kind === 'Artwork' && asset.path);
  const [audioId, setAudioId] = useState('');
  const [artId, setArtId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('type beat, instrumental, producer');
  const [visibility, setVisibility] = useState<'Public' | 'Unlisted' | 'Private'>('Public');
  const [publish, setPublish] = useState<'Immediately' | 'Schedule'>('Immediately');
  const [publishAt, setPublishAt] = useState('');
  const [preview, setPreview] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const selectedAudio = audio.find((asset) => asset.id === audioId);
  const selectedArt = art.find((asset) => asset.id === artId);
  useEffect(() => {
    setPreview('');
    if (selectedArt?.path) void window.scoutline?.filePreview(selectedArt.path).then(setPreview).catch(() => setPreview(''));
  }, [selectedArt?.path]);
  const validate = () => {
    if (!selectedAudio?.path) return 'Select an imported audio file.';
    if (!selectedArt?.path) return 'Select imported artwork.';
    if (!title.trim()) return 'Enter a YouTube title.';
    if (publish === 'Schedule' && (!publishAt || new Date(publishAt).getTime() <= Date.now())) return 'Choose a future publish time.';
    return '';
  };
  const review = () => { const problem = validate(); if (problem) { setError(problem); return; } setError(''); setReviewing(true); };
  const upload = async () => {
    const problem = validate(); if (problem || !selectedAudio?.path || !selectedArt?.path || !window.scoutline) { setError(problem || 'Selected files are unavailable.'); return; }
    setUploading(true); setError('');
    try {
      const result = await window.scoutline.uploadYouTube({ audioPath: selectedAudio.path, artworkPath: selectedArt.path, title: title.trim(), description: description.trim(), tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), visibility, publishAt: publish === 'Schedule' ? new Date(publishAt).toISOString() : undefined });
      setVideoUrl(result.videoUrl || ''); setReviewing(false);
      update((current) => ({ ...current, activities: [{ id: crypto.randomUUID(), type: publish === 'Schedule' ? 'YouTube upload scheduled' : 'YouTube upload published', detail: `${title.trim()} was submitted through the connected YouTube account.`, createdAt: result.uploadedAt }, ...current.activities] }));
      notify(publish === 'Schedule' ? 'YouTube upload scheduled' : 'YouTube upload complete');
    } catch (reason) { setError(readableError(reason, 'YouTube upload failed.')); }
    finally { setUploading(false); }
  };
  return <section className="page page-wide"><PageHeader eyebrow="Publishing" title="YouTube Uploader" description="Render audio and artwork into a video, then upload through your connected YouTube session." />{error && <div className="connection-error">{error}</div>}{videoUrl && <div className="finder-notice">Upload confirmed. <button className="link-button" onClick={() => void window.scoutline?.openExternal(videoUrl)}>Open video</button></div>}<div className="youtube-layout"><div className="panel"><h2>Media</h2><label className="field"><span>Audio</span><select value={audioId} onChange={(event) => { setAudioId(event.target.value); const asset = audio.find((item) => item.id === event.target.value); if (asset && !title) setTitle(asset.name.replace(/\.[^.]+$/, '')); }}><option value="">Select a beat…</option>{audio.map((asset) => <option value={asset.id} key={asset.id}>{asset.name}</option>)}</select></label><label className="field"><span>Artwork</span><select value={artId} onChange={(event) => setArtId(event.target.value)}><option value="">Select artwork…</option>{art.map((asset) => <option value={asset.id} key={asset.id}>{asset.name}</option>)}</select></label><div className={`upload-preview ${preview ? 'has-artwork' : ''}`}>{preview ? <><img src={preview} alt="Selected upload artwork" /><span>▶</span><p>{selectedAudio?.name}</p></> : <><span>▶</span><p>Select audio and artwork to preview the finished frame.</p></>}</div></div><div className="panel"><h2>Metadata</h2><label className="field"><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="[FREE] Artist Type Beat - Beat Name" /></label><label className="field"><span>Description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="License, credits, links, and contact information…" /></label><label className="field"><span>Tags</span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="type beat, instrumental, producer" /></label><div className="two-fields"><label className="field"><span>Visibility</span><select value={visibility} onChange={(event) => setVisibility(event.target.value as typeof visibility)}><option>Public</option><option>Unlisted</option><option>Private</option></select></label><label className="field"><span>Publish</span><select value={publish} onChange={(event) => setPublish(event.target.value as typeof publish)}><option>Immediately</option><option>Schedule</option></select></label></div>{publish === 'Schedule' && <label className="field"><span>Publish date and time</span><input type="datetime-local" value={publishAt} onChange={(event) => setPublishAt(event.target.value)} /></label>}<button data-testid="review-youtube-upload" className="primary full" onClick={review}>Review upload</button></div></div>{reviewing && <div className="modal-backdrop"><div data-testid="youtube-review-modal" className="modal"><div className="modal-header"><div><h2>Confirm YouTube upload</h2><p>Scoutline will render the video locally and upload it through YouTube Studio.</p></div><button disabled={uploading} onClick={() => setReviewing(false)}>×</button></div><div className="modal-body tool-workspace"><dl className="upload-review"><div><dt>Audio</dt><dd>{selectedAudio?.name}</dd></div><div><dt>Artwork</dt><dd>{selectedArt?.name}</dd></div><div><dt>Title</dt><dd>{title}</dd></div><div><dt>Visibility</dt><dd>{publish === 'Schedule' ? `Scheduled ${new Date(publishAt).toLocaleString()}` : visibility}</dd></div></dl>{uploading && <div className="finder-notice">Rendering the video and completing the YouTube Studio upload. Keep Scoutline and the dedicated Chrome window open.</div>}{error && <div className="connection-error">{error}</div>}</div><div className="modal-footer"><button className="secondary" disabled={uploading} onClick={() => setReviewing(false)}>Cancel</button><button className="primary" disabled={uploading} onClick={() => void upload()}>{uploading ? 'Rendering and uploading…' : publish === 'Schedule' ? 'Schedule upload' : 'Upload now'}</button></div></div></div>}</section>;
}

type LocalTool = 'Non-Exclusive Beat License Agreement' | 'Exclusive Beat License Agreement' | 'AI Beat Name Generator' | 'Metadata Formatter' | 'Outreach Template Builder';

function Tools({ state, notify }: { state: AppState; notify: (message: string) => void }) {
  const [activeTool, setActiveTool] = useState<LocalTool | null>(null);
  const tools: Array<[LocalTool, string, string]> = [
    ['Non-Exclusive Beat License Agreement', 'Generate a limited beat lease with usage caps, publishing, payment, samples, and remedies.', '▤'],
    ['Exclusive Beat License Agreement', 'Generate a signed-ready exclusive agreement with royalties and prior-license treatment.', '▥'],
    ['AI Beat Name Generator', 'Use your connected AI account with artist, mood, and subject controls.', '♫'],
    ['Metadata Formatter', 'Build release-ready credits, identifiers, filenames, copyright lines, and tags.', '⌘'],
    ['Outreach Template Builder', 'Validate reusable email or Instagram templates and preview every supported field.', '✦'],
  ];
  return <section className="page page-wide"><PageHeader eyebrow="Utilities" title="Tools" description="Working production and outreach utilities—not demo output." /><div className="tools-grid">{tools.map(([name, description, icon]) => <button data-testid={`tool-${name.toLowerCase().replaceAll(' ', '-')}`} className="tool-card" key={name} onClick={() => setActiveTool(name)}><span>{icon}</span><div><h3>{name}</h3><p>{description}</p></div><b>›</b></button>)}</div>{activeTool && <LocalToolModal tool={activeTool} state={state} close={() => setActiveTool(null)} notify={notify} />}</section>;
}

function LocalToolModal({ tool, state, close, notify }: { tool: LocalTool; state: AppState; close: () => void; notify: (message: string) => void }) {
  const copy = async (value: string, message = 'Copied to clipboard') => { await navigator.clipboard.writeText(value); notify(message); };
  const isAgreement = tool === 'Non-Exclusive Beat License Agreement' || tool === 'Exclusive Beat License Agreement';
  return <div className="modal-backdrop"><div data-testid="local-tool-modal" className={`modal tool-modal ${isAgreement ? 'agreement-modal' : ''}`}><div className="modal-header"><div><h2>{tool}</h2><p>{isAgreement ? 'Complete every required deal term, then export a signed-ready PDF.' : 'Runs inside Scoutline using the information you provide.'}</p></div><button onClick={close}>×</button></div><div className="modal-body tool-workspace">
    {tool === 'AI Beat Name Generator' && <BeatNameTool state={state} copy={copy} />}
    {tool === 'Non-Exclusive Beat License Agreement' && <AgreementTool kind="non-exclusive" notify={notify} copy={copy} />}
    {tool === 'Exclusive Beat License Agreement' && <AgreementTool kind="exclusive" notify={notify} copy={copy} />}
    {tool === 'Metadata Formatter' && <MetadataTool copy={copy} />}
    {tool === 'Outreach Template Builder' && <TemplateTool copy={copy} />}
  </div><div className="modal-footer"><button className="secondary" onClick={close}>Close</button></div></div></div>;
}

function BeatNameTool({ state, copy }: { state: AppState; copy: (value: string, message?: string) => Promise<void> }) {
  const [artist, setArtist] = useState('');
  const [moods, setMoods] = useState('');
  const [subject, setSubject] = useState('');
  const [names, setNames] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generate = async () => {
    if (!artist.trim() || !moods.trim() || !subject.trim()) { setError('Artist reference, moods, and subject are all required.'); return; }
    if (!window.scoutline) { setError('Scoutline AI is unavailable.'); return; }
    setBusy(true); setError(''); setNames([]);
    try {
      const result = await window.scoutline.runAi({ provider: state.settings.aiProvider, task: 'beat_names', prompt: `Generate exactly 12 original instrumental beat titles.\nArtist/style reference: ${artist.trim()}\nMoods: ${moods.trim()}\nSubject or imagery: ${subject.trim()}\nRules: one title per line; 1 to 5 words each; no numbering; no explanations; do not reuse a known song or album title; avoid generic filler such as Vibes, Type Beat, Instrumental, or Freestyle; vary the syntax and imagery.` });
      const parsed = parseBeatNameResponse(result.text);
      if (parsed.length < 6) throw new Error('The AI response did not contain enough usable names. Generate again.');
      setNames(parsed);
    } catch (reason) { setError(readableError(reason, 'Beat-name generation failed.')); }
    finally { setBusy(false); }
  };
  return <><div className="three-fields"><label className="field"><span>Sounds like the artist</span><input data-testid="beat-artist" value={artist} onChange={(event) => setArtist(event.target.value)} placeholder="Artist or producer reference" /></label><label className="field"><span>Moods</span><input data-testid="beat-moods" value={moods} onChange={(event) => setMoods(event.target.value)} placeholder="Emotional, nostalgic" /></label><label className="field"><span>Talking about</span><input data-testid="beat-subject" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="New York at 2 AM" /></label></div>{error && <div className="connection-error">{error}</div>}<button data-testid="generate-beat-names" className="primary" disabled={busy} onClick={() => void generate()}>{busy ? `Generating with ${state.settings.aiProvider}…` : `Generate with ${state.settings.aiProvider}`}</button>{names.length > 0 && <div className="generated-name-grid">{names.map((name) => <button key={name} onClick={() => void copy(name, `Copied “${name}”`)}>{name}<small>Copy</small></button>)}</div>}</>;
}

const agreementDefaults = (kind: AgreementKind): ProducerAgreementInput => ({
  kind, effectiveDate: new Date().toISOString().slice(0, 10), producerLegalName: '', producerStageName: '', producerAddress: '', producerEmail: '', artistLegalName: '', artistStageName: '', artistAddress: '', artistEmail: '', beatTitle: '', beatId: '', fee: kind === 'exclusive' ? '1000' : '100', currency: 'USD', deliverables: kind === 'exclusive' ? 'Untagged WAV, MP3, and tracked-out stems' : 'Untagged MP3 and WAV', producerCompositionShare: '50', producerMasterRoyalty: kind === 'exclusive' ? '3' : '0', containsSamples: false, sampleDisclosure: '', governingState: '', governingCounty: '', termYears: '5', copies: '10000', audioStreams: '500000', videoStreams: '250000', musicVideos: '1', radioStations: '10', paidPerformances: true, allowSync: false, priorLicenses: false, priorLicenseNotice: '',
});

function AgreementTool({ kind, notify, copy }: { kind: AgreementKind; notify: (message: string) => void; copy: (value: string, message?: string) => Promise<void> }) {
  const [input, setInput] = useState<ProducerAgreementInput>(() => agreementDefaults(kind));
  const [agreement, setAgreement] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const change = <K extends keyof ProducerAgreementInput>(key: K, value: ProducerAgreementInput[K]) => { setInput((current) => ({ ...current, [key]: value })); setAgreement(''); setErrors([]); };
  const preset = (name: 'Basic' | 'Premium' | 'Unlimited') => {
    const values = name === 'Basic'
      ? { deliverables: 'Untagged MP3', termYears: '2', copies: '2500', audioStreams: '100000', videoStreams: '50000', musicVideos: '1', radioStations: '2', paidPerformances: false, allowSync: false }
      : name === 'Premium'
        ? { deliverables: 'Untagged MP3 and WAV', termYears: '5', copies: '10000', audioStreams: '500000', videoStreams: '250000', musicVideos: '1', radioStations: '10', paidPerformances: true, allowSync: false }
        : { deliverables: 'Untagged MP3, WAV, and tracked-out stems', termYears: '10', copies: 'unlimited', audioStreams: 'unlimited', videoStreams: 'unlimited', musicVideos: 'unlimited', radioStations: 'unlimited', paidPerformances: true, allowSync: true };
    setInput((current) => ({ ...current, ...values })); setAgreement(''); setErrors([]);
  };
  const generate = () => {
    const problems = validateProducerAgreement(input);
    setErrors(problems);
    if (problems.length) { setAgreement(''); return; }
    setAgreement(buildProducerAgreement(input));
  };
  const download = async () => {
    if (!agreement || !window.scoutline) return;
    try {
      const result = await window.scoutline.saveAgreementPdf({ title: `${input.kind === 'exclusive' ? 'Exclusive' : 'Non-Exclusive'} Beat License - ${input.beatTitle}`, agreement });
      if (!result.canceled) notify(`Agreement saved to ${result.path}`);
    } catch (reason) { setErrors([readableError(reason, 'PDF export failed.')]); }
  };
  return <>
    {kind === 'non-exclusive' && <div className="license-presets"><span>Starting terms</span><button onClick={() => preset('Basic')}>Basic</button><button onClick={() => preset('Premium')}>Premium</button><button onClick={() => preset('Unlimited')}>Unlimited</button></div>}
    <ToolSection title="Agreement and beat"><div className="three-fields"><label className="field"><span>Effective date *</span><input data-agreement-field="effectiveDate" type="date" value={input.effectiveDate} onChange={(event) => change('effectiveDate', event.target.value)} /></label><label className="field"><span>Beat title *</span><input data-agreement-field="beatTitle" value={input.beatTitle} onChange={(event) => change('beatTitle', event.target.value)} /></label><label className="field"><span>Catalog / file ID</span><input value={input.beatId} onChange={(event) => change('beatId', event.target.value)} /></label><label className="field"><span>License fee *</span><input type="number" min="0" value={input.fee} onChange={(event) => change('fee', event.target.value)} /></label><label className="field"><span>Currency *</span><input value={input.currency} onChange={(event) => change('currency', event.target.value)} /></label><label className="field"><span>Deliverables *</span><input value={input.deliverables} onChange={(event) => change('deliverables', event.target.value)} /></label></div></ToolSection>
    <ToolSection title="Producer"><div className="two-fields"><label className="field"><span>Legal name *</span><input data-agreement-field="producerLegalName" value={input.producerLegalName} onChange={(event) => change('producerLegalName', event.target.value)} /></label><label className="field"><span>Stage / company name</span><input value={input.producerStageName} onChange={(event) => change('producerStageName', event.target.value)} /></label><label className="field"><span>Notice email *</span><input data-agreement-field="producerEmail" type="email" value={input.producerEmail} onChange={(event) => change('producerEmail', event.target.value)} /></label><label className="field"><span>Legal address *</span><input data-agreement-field="producerAddress" value={input.producerAddress} onChange={(event) => change('producerAddress', event.target.value)} /></label></div></ToolSection>
    <ToolSection title="Artist / licensee"><div className="two-fields"><label className="field"><span>Legal name *</span><input data-agreement-field="artistLegalName" value={input.artistLegalName} onChange={(event) => change('artistLegalName', event.target.value)} /></label><label className="field"><span>Stage / company name</span><input value={input.artistStageName} onChange={(event) => change('artistStageName', event.target.value)} /></label><label className="field"><span>Notice email *</span><input data-agreement-field="artistEmail" type="email" value={input.artistEmail} onChange={(event) => change('artistEmail', event.target.value)} /></label><label className="field"><span>Legal address *</span><input data-agreement-field="artistAddress" value={input.artistAddress} onChange={(event) => change('artistAddress', event.target.value)} /></label></div></ToolSection>
    <ToolSection title="Ownership and royalties"><div className="two-fields"><label className="field"><span>Producer share of New Song composition (%) *</span><input type="number" min="0" max="100" value={input.producerCompositionShare} onChange={(event) => change('producerCompositionShare', event.target.value)} /></label><label className="field"><span>Producer master royalty (%) *</span><input type="number" min="0" max="100" step="0.5" value={input.producerMasterRoyalty} onChange={(event) => change('producerMasterRoyalty', event.target.value)} /></label></div></ToolSection>
    {kind === 'non-exclusive' && <ToolSection title="Term and usage limits"><div className="three-fields"><label className="field"><span>Term (years) *</span><input type="number" min="1" value={input.termYears} onChange={(event) => change('termYears', event.target.value)} /></label><label className="field"><span>Copies / downloads *</span><input value={input.copies} onChange={(event) => change('copies', event.target.value)} /></label><label className="field"><span>Audio streams *</span><input value={input.audioStreams} onChange={(event) => change('audioStreams', event.target.value)} /></label><label className="field"><span>Video streams *</span><input value={input.videoStreams} onChange={(event) => change('videoStreams', event.target.value)} /></label><label className="field"><span>Music videos *</span><input value={input.musicVideos} onChange={(event) => change('musicVideos', event.target.value)} /></label><label className="field"><span>Radio stations *</span><input value={input.radioStations} onChange={(event) => change('radioStations', event.target.value)} /></label></div><div className="agreement-checks"><label><input type="checkbox" checked={input.paidPerformances} onChange={(event) => change('paidPerformances', event.target.checked)} /> Allow paid live performances</label><label><input type="checkbox" checked={input.allowSync} onChange={(event) => change('allowSync', event.target.checked)} /> Include film/TV/game/advertising sync</label></div></ToolSection>}
    {kind === 'exclusive' && <ToolSection title="Outstanding licenses"><label className="agreement-switch"><input type="checkbox" checked={input.priorLicenses} onChange={(event) => change('priorLicenses', event.target.checked)} /><span>Prior non-exclusive licenses or authorized uses exist</span></label>{input.priorLicenses && <label className="field"><span>Identify every outstanding license / authorized use *</span><textarea value={input.priorLicenseNotice} onChange={(event) => change('priorLicenseNotice', event.target.value)} placeholder="Licensee, song, and date for each existing license" /></label>}</ToolSection>}
    <ToolSection title="Samples and governing law"><label className="agreement-switch"><input type="checkbox" checked={input.containsSamples} onChange={(event) => change('containsSamples', event.target.checked)} /><span>The Beat contains a disclosed sample, interpolation, loop, or third-party performance</span></label>{input.containsSamples && <label className="field"><span>Identify the material and agreed clearance responsibility *</span><textarea value={input.sampleDisclosure} onChange={(event) => change('sampleDisclosure', event.target.value)} /></label>}<div className="two-fields"><label className="field"><span>Governing state *</span><input data-agreement-field="governingState" value={input.governingState} onChange={(event) => change('governingState', event.target.value)} /></label><label className="field"><span>County for venue *</span><input data-agreement-field="governingCounty" value={input.governingCounty} onChange={(event) => change('governingCounty', event.target.value)} /></label></div></ToolSection>
    <div className="legal-note">This generator creates a substantive agreement from the terms entered. It is not legal advice; use an entertainment lawyer for high-value, label, sampled, multi-party, or cross-border deals.</div>
    {errors.length > 0 && <div className="connection-error"><strong>Complete the agreement before export:</strong><ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
    <button data-testid="generate-agreement" className="primary" onClick={generate}>Generate complete agreement</button>
    {agreement && <><pre data-testid="agreement-output" className="tool-output agreement-output">{agreement}</pre><div className="tool-actions"><button className="secondary" onClick={() => void copy(agreement, 'Agreement copied')}>Copy agreement</button><button data-testid="download-agreement-pdf" className="primary" onClick={() => void download()}>Download PDF</button></div></>}
  </>;
}

function ToolSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="tool-section"><h3>{title}</h3>{children}</section>;
}

function MetadataTool({ copy }: { copy: (value: string, message?: string) => Promise<void> }) {
  const [input, setInput] = useState<MusicMetadataInput>({ beatTitle: '', primaryArtist: '', featuredArtists: '', producer: '', bpm: '', musicalKey: '', genre: '', mood: '', version: 'Original', releaseYear: String(new Date().getFullYear()), isrc: '', upc: '', masterOwner: '', compositionOwner: '', tags: '' });
  const [output, setOutput] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const change = (key: keyof MusicMetadataInput, value: string) => { setInput((current) => ({ ...current, [key]: value })); setOutput(''); setErrors([]); };
  const format = () => { const problems = validateMusicMetadata(input); setErrors(problems); setOutput(problems.length ? '' : formatMusicMetadata(input)); };
  return <><div className="three-fields"><label className="field"><span>Beat / track title *</span><input data-metadata-field="beatTitle" value={input.beatTitle} onChange={(event) => change('beatTitle', event.target.value)} /></label><label className="field"><span>Primary artist *</span><input data-metadata-field="primaryArtist" value={input.primaryArtist} onChange={(event) => change('primaryArtist', event.target.value)} /></label><label className="field"><span>Featured artists</span><input value={input.featuredArtists} onChange={(event) => change('featuredArtists', event.target.value)} placeholder="Comma separated" /></label><label className="field"><span>Producer credit *</span><input value={input.producer} onChange={(event) => change('producer', event.target.value)} /></label><label className="field"><span>BPM *</span><input data-metadata-field="bpm" type="number" min="20" max="300" value={input.bpm} onChange={(event) => change('bpm', event.target.value)} /></label><label className="field"><span>Musical key *</span><input data-metadata-field="musicalKey" value={input.musicalKey} onChange={(event) => change('musicalKey', event.target.value)} placeholder="C# minor" /></label><label className="field"><span>Genre</span><input value={input.genre} onChange={(event) => change('genre', event.target.value)} /></label><label className="field"><span>Mood</span><input value={input.mood} onChange={(event) => change('mood', event.target.value)} /></label><label className="field"><span>Version</span><input value={input.version} onChange={(event) => change('version', event.target.value)} /></label><label className="field"><span>Release year *</span><input value={input.releaseYear} onChange={(event) => change('releaseYear', event.target.value)} /></label><label className="field"><span>ISRC</span><input value={input.isrc} onChange={(event) => change('isrc', event.target.value)} placeholder="US-ABC-26-00001" /></label><label className="field"><span>UPC / EAN</span><input value={input.upc} onChange={(event) => change('upc', event.target.value)} /></label><label className="field"><span>Master owner</span><input value={input.masterOwner} onChange={(event) => change('masterOwner', event.target.value)} /></label><label className="field"><span>Composition / publisher</span><input value={input.compositionOwner} onChange={(event) => change('compositionOwner', event.target.value)} /></label><label className="field"><span>Search tags</span><input value={input.tags} onChange={(event) => change('tags', event.target.value)} placeholder="Comma separated" /></label></div>{errors.length > 0 && <div className="connection-error"><ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}<button data-testid="format-metadata" className="primary" onClick={format}>Build release metadata</button>{output && <><pre data-testid="metadata-output" className="tool-output">{output}</pre><button className="secondary" onClick={() => void copy(output, 'Release metadata copied')}>Copy release metadata</button></>}</>;
}

function TemplateTool({ copy }: { copy: (value: string, message?: string) => Promise<void> }) {
  const [input, setInput] = useState<OutreachTemplateInput>({ channel: 'Instagram', subject: '', body: 'Hey [artist_name], [latest_release] was so good 🔥 Do you have more like this coming?', preview: { artist_name: '', latest_release: '', producer_name: '', instagram_handle: '', pack_name: '' } });
  const changePreview = (key: keyof OutreachTemplateInput['preview'], value: string) => setInput((current) => ({ ...current, preview: { ...current.preview, [key]: value } }));
  const errors = validateOutreachTemplate(input);
  const preview = previewOutreachTemplate(input);
  const unresolved = outreachTokens.filter((token) => `${preview.subject}\n${preview.body}`.toLowerCase().includes(`[${token}]`));
  const reusable = `${input.channel === 'Email' ? `Subject: ${input.subject.trim()}\n\n` : ''}${input.body.trim()}`;
  return <><div className="two-fields"><label className="field"><span>Channel</span><select value={input.channel} onChange={(event) => setInput((current) => ({ ...current, channel: event.target.value as OutreachTemplateInput['channel'] }))}><option>Instagram</option><option>Email</option></select></label>{input.channel === 'Email' && <label className="field"><span>Subject *</span><input value={input.subject} onChange={(event) => setInput((current) => ({ ...current, subject: event.target.value }))} /></label>}</div><label className="field"><span>Reusable message *</span><textarea data-testid="template-body" value={input.body} onChange={(event) => setInput((current) => ({ ...current, body: event.target.value }))} /></label><div className="token-list"><span>Supported fields</span>{outreachTokens.map((token) => <code key={token}>[{token}]</code>)}</div><ToolSection title="Preview values"><div className="three-fields">{outreachTokens.map((token) => <label className="field" key={token}><span>{token.replaceAll('_', ' ')}</span><input data-template-preview={token} value={input.preview[token]} onChange={(event) => changePreview(token, event.target.value)} /></label>)}</div></ToolSection>{errors.length > 0 && <div className="connection-error"><ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}<div className="template-preview"><strong>{input.channel} preview</strong>{input.channel === 'Email' && <p><b>Subject:</b> {preview.subject || '—'}</p>}<p>{preview.body}</p>{unresolved.length > 0 && <small>Enter preview values for: {unresolved.join(', ')}</small>}</div><div className="tool-actions"><button className="secondary" disabled={errors.length > 0} onClick={() => void copy(reusable, 'Reusable template copied')}>Copy reusable template</button><button className="primary" disabled={errors.length > 0 || unresolved.length > 0} onClick={() => void copy(`${input.channel === 'Email' ? `Subject: ${preview.subject}\n\n` : ''}${preview.body}`, 'Personalized preview copied')}>Copy personalized preview</button></div></>;
}

function Settings({ state, update, notify }: { state: AppState; update: (recipe: (state: AppState) => AppState) => void; notify: (message: string) => void }) {
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [connecting, setConnecting] = useState<ConnectionService | 'picker' | null>(null);
  const refresh = async () => { if (window.scoutline) setConnections(await window.scoutline.getConnections()); };
  useEffect(() => { void refresh(); }, []);
  const disconnect = async (service: ConnectionService) => {
    await window.scoutline?.disconnectService(service);
    await refresh();
    if (service === state.settings.aiProvider) update((current) => ({ ...current, settings: { ...current.settings, aiModel: 'Not connected' } }));
    notify(`${service} disconnected`);
  };
  const selectedStatus = connections.find((item) => item.service === state.settings.aiProvider);
  return <section className="page settings-page">
    <PageHeader eyebrow="Your setup" title="Settings" description="Connect your accounts and choose how Scoutline handles outreach." />
    <div className="settings-section"><div><h2>AI accounts</h2><p>Use the AI subscription you already have. No API keys.</p></div><div className="setting-card">
      <div className="provider-card"><div className="logo-mark">S</div><div><strong>{state.settings.aiProvider}</strong><span>{selectedStatus?.connected ? selectedStatus.accountLabel || 'Signed in' : 'Not connected'}</span></div><Pill tone={selectedStatus?.connected ? 'green' : 'neutral'}>{selectedStatus?.connected ? 'Ready' : 'Not connected'}</Pill></div>
      <label className="field"><span>Use this AI</span><select value={state.settings.aiProvider} onChange={(event) => { const provider = event.target.value as AppState['settings']['aiProvider']; const connected = connections.some((item) => item.service === provider && item.connected); update((current) => ({ ...current, settings: { ...current.settings, aiProvider: provider, aiModel: connected ? 'Connected session' : 'Not connected' } })); }}><option>Codex</option><option>Claude</option><option>Gemini</option></select></label>
      <div className="connections ai-connections">{aiServices.map((service) => <Connection key={service} status={connections.find((item) => item.service === service) || { service, connected: false }} connect={() => setConnecting(service)} disconnect={() => void disconnect(service)} />)}</div>
      <div className="usage-note"><strong>No Scoutline usage limits</strong><p>Use is limited only by the connected account. Scoutline caches artist facts and avoids unnecessary calls.</p></div>
    </div></div>
    <div className="settings-section"><div><h2>Verification</h2><p>Choose when Scoutline should ask you to double-check an artist.</p></div><div className="setting-card"><label className="field"><span>Require review below {state.settings.requireReviewBelow}% confidence</span><input type="range" min="50" max="100" value={state.settings.requireReviewBelow} onChange={(event) => update((current) => ({ ...current, settings: { ...current.settings, requireReviewBelow: Number(event.target.value) } }))} /></label><label className="setting-line"><div><strong>Automatic sending</strong><span>Send only after identity and message audits pass.</span></div><span className="toggle-line"><input type="checkbox" checked={state.settings.automaticSending} onChange={() => update((current) => ({ ...current, settings: { ...current.settings, automaticSending: !current.settings.automaticSending } }))} /><span className="toggle" /></span></label></div></div>
    <div className="settings-section"><div><h2>Discovery data</h2><p>Chartmetric is used when connected. Otherwise Finder uses the free providers automatically.</p></div><div className="setting-card connections">{dataServices.map((service) => <Connection key={service} status={connections.find((item) => item.service === service) || { service, connected: false }} connect={() => setConnecting(service)} disconnect={() => void disconnect(service)} />)}<div className="usage-note"><strong>Free fallback is always available</strong><p>MusicBrainz, ListenBrainz, Wikidata, Spotify public artist pages, and Last.fm when connected.</p></div></div></div>
    <div className="settings-section"><div><h2>Connections</h2><p>Sign in once and Scoutline will keep these accounts connected on this Mac.</p></div><div className="setting-card connections">{outreachServices.map((service) => <Connection key={service} status={connections.find((item) => item.service === service) || { service, connected: false }} connect={() => setConnecting(service)} disconnect={() => void disconnect(service)} />)}<button className="primary" onClick={() => setConnecting('picker')}>Add connection</button></div></div>
    {connecting && <ConnectionModal initial={connecting === 'picker' ? undefined : connecting} statuses={connections} close={() => setConnecting(null)} connected={async (status) => { await refresh(); setConnecting(null); if (aiServices.includes(status.service)) update((current) => ({ ...current, settings: { ...current.settings, aiProvider: status.service as AppState['settings']['aiProvider'], aiModel: 'Connected session' } })); notify(`${status.service} connected`); }} />}
  </section>;
}

function Connection({ status, connect, disconnect }: { status: ConnectionStatus; connect: () => void; disconnect: () => void }) { return <div data-testid={`connection-${status.service}`} className="connection"><div className="connection-icon">{status.service[0]}</div><div><strong>{status.service}</strong><span>{status.connected ? status.accountLabel || 'Connected' : 'Not connected'}</span></div>{status.connected ? <button className="secondary" onClick={disconnect}>Disconnect</button> : <button data-testid={`connect-${status.service}`} className="secondary" onClick={connect}>Connect</button>}</div>; }

function ConnectionModal({ initial, statuses, close, connected }: { initial?: ConnectionService; statuses: ConnectionStatus[]; close: () => void; connected: (status: ConnectionStatus) => void }) {
  const [service, setService] = useState<ConnectionService | undefined>(initial);
  const [credential, setCredential] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = async () => {
    if (!service || !window.scoutline) return;
    setBusy(true); setError('');
    try { await connected(await window.scoutline.connectService(service, service === 'Last.fm' ? credential : undefined)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : `${service} connection failed.`); }
    finally { setBusy(false); }
  };
  const descriptions: Record<ConnectionService, { picker: string; title: string; body: string }> = {
    Instagram: { picker: 'Send DMs and keep artist replies together', title: 'Sign in to Instagram', body: 'A familiar Instagram window will open. Sign in normally, and Scoutline will bring you back when it is ready.' },
    Gmail: { picker: 'Send email and show replies from contacted artists', title: 'Sign in to Gmail', body: 'Scoutline opens a dedicated Google Chrome window. Sign in normally; no developer account, API key, or embedded browser.' },
    Spotify: { picker: 'Find artists, releases, and similar prospects', title: 'Sign in to Spotify', body: 'A familiar Spotify window will open. Sign in normally. Artist search also works without a Spotify developer account.' },
    YouTube: { picker: 'Upload and schedule beats from Scoutline', title: 'Sign in to YouTube', body: 'Scoutline opens a dedicated Google Chrome window. Sign in normally; no developer account, API key, or embedded browser.' },
    Codex: { picker: 'Use your ChatGPT subscription', title: 'Sign in to Codex', body: 'Scoutline uses the official Codex sign-in. If Codex is already signed in on this Mac, it connects immediately; otherwise the secure ChatGPT flow opens in your normal browser.' },
    Claude: { picker: 'Use your Claude subscription', title: 'Sign in to Claude', body: 'Scoutline opens Claude in a dedicated normal Chrome window. Sign in with your existing Claude account; no API key is required.' },
    Gemini: { picker: 'Use your Gemini subscription', title: 'Sign in to Gemini', body: 'Scoutline opens a dedicated Google Chrome window so Google accepts the normal account sign-in.' },
    Chartmetric: { picker: 'Use Chartmetric as Finder’s primary music-data source', title: 'Sign in to Chartmetric', body: 'Your normal Chartmetric sign-in opens in the browser through its official Codex connector. If Chartmetric is disconnected, Finder automatically returns to the free providers.' },
    'Last.fm': { picker: 'Add free similarity data to Finder', title: 'Connect Last.fm', body: 'Paste the free API key from your Last.fm application. Scoutline verifies it once and stores it securely on this Mac.' },
  };
  const allConnections = [...outreachServices, ...dataServices];
  return <div className="modal-backdrop"><div data-testid="connection-modal" className="modal connection-modal"><div className="modal-header"><div><h2>{service ? `Connect ${service}` : 'Add connection'}</h2><p>{service === 'Last.fm' ? 'Use the free key from your Last.fm application.' : 'Sign in normally. Scoutline keeps the connection on this Mac.'}</p></div><button onClick={close}>×</button></div><div className="modal-body">{!service ? <div className="connection-picker">{allConnections.map((item) => <button key={item} disabled={statuses.some((status) => status.service === item && status.connected)} onClick={() => { setService(item); setCredential(''); setError(''); }}><div className="connection-icon">{item[0]}</div><span><strong>{item}</strong><small>{descriptions[item].picker}</small></span><b>›</b></button>)}</div> : <><div className="connection-explainer"><div className="connection-icon">{service[0]}</div><div><h3>{descriptions[service].title}</h3><p>{descriptions[service].body}</p></div></div>{service === 'Last.fm' && <label className="field connection-secret"><span>Last.fm API key</span><input data-testid="lastfm-api-key" type="password" value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="Paste your free API key" autoComplete="off" /></label>}{error && <div className="connection-error">{error}</div>}</>}</div><div className="modal-footer"><button className="secondary" onClick={service && !initial ? () => { setService(undefined); setCredential(''); setError(''); } : close}>{service && !initial ? 'Back' : 'Cancel'}</button>{service && <button className="primary" disabled={busy || (service === 'Last.fm' && !credential.trim())} onClick={() => void submit()}>{busy ? (service === 'Last.fm' ? 'Checking key…' : 'Waiting for sign-in…') : service === 'Last.fm' ? 'Connect Last.fm' : `Sign in with ${service}`}</button>}</div></div></div>;
}

export default App;
