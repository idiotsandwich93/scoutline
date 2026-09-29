import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { AgreementPdfRequest, AiGenerationRequest, AppState, Artist, Automation, Campaign, ConnectionService, ConnectionStatus, InboxContact, InboxSyncResult, SpotifyArtistResult, SpotifyFindCriteria, YouTubeUploadRequest } from '../src/shared/types.js';
import { buildGmailQuery, parseGmailAtom, parseInstagramInbox } from './inbox-sync.js';
import { parseArtistNameList } from './ai-discovery.js';
import { discoverFreeCandidates, resolveSpotifyIdsFromListenBrainz, resolveSpotifyIdsFromWikidata, validateLastFmApiKey } from './discovery-providers.js';
import { instagramFilterIsActive, summarizeInstagramFilter } from '../src/lib/finder.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
let database: DatabaseSync;

if (process.argv.includes('--smoke-test')) {
  const requestedSmokeProfile = process.argv.find((argument) => argument.startsWith('--smoke-profile='))?.slice('--smoke-profile='.length);
  const smokeUserData = requestedSmokeProfile ? path.join('/tmp', `scoutline-smoke-${requestedSmokeProfile.replace(/[^a-z0-9_-]/gi, '')}`) : path.join('/tmp', `scoutline-smoke-${process.pid}`);
  mkdirSync(smokeUserData, { recursive: true });
  app.setPath('userData', smokeUserData);
}

interface StoredConnection {
  accountLabel?: string;
  partition?: string;
  authMethod?: 'browser-session' | 'codex-cli' | 'chrome-session' | 'codex-mcp' | 'api-key';
  apiKey?: string;
  connectedAt: string;
}

const browserUserAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

function seal(value: StoredConnection): string {
  const serialized = JSON.stringify(value);
  if (safeStorage.isEncryptionAvailable()) {
    return JSON.stringify({ encrypted: true, value: safeStorage.encryptString(serialized).toString('base64') });
  }
  return JSON.stringify({ encrypted: false, value: Buffer.from(serialized).toString('base64') });
}

function unseal(payload: string): StoredConnection {
  const wrapper = JSON.parse(payload) as { encrypted: boolean; value: string };
  const buffer = Buffer.from(wrapper.value, 'base64');
  return JSON.parse(wrapper.encrypted ? safeStorage.decryptString(buffer) : buffer.toString('utf8')) as StoredConnection;
}

function getConnection(service: ConnectionService): StoredConnection | undefined {
  const row = database.prepare('SELECT payload FROM connections WHERE service = ?').get(service) as { payload: string } | undefined;
  return row ? unseal(row.payload) : undefined;
}

function saveConnection(service: ConnectionService, connection: StoredConnection) {
  database.prepare(`
    INSERT INTO connections (service, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(service) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).run(service, seal(connection), new Date().toISOString());
  if (service === 'Instagram') instagramProfileCache.clear();
}

function connectionStatus(service: ConnectionService): ConnectionStatus {
  const connection = getConnection(service);
  const connected = Boolean(connection?.partition || connection?.apiKey || connection?.authMethod);
  return { service, connected, accountLabel: connected ? connection?.accountLabel : undefined, detail: connected ? 'Signed in' : 'Not connected' };
}

function findCodexExecutable(): string {
  const pathCandidates = (process.env.PATH || '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, 'codex'));
  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    ...pathCandidates,
  ];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error('Install the ChatGPT or Codex desktop app, then try again.');
  return executable;
}

function runCodexCommand(argumentsList: string[], timeoutMilliseconds: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(findCodexExecutable(), argumentsList, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.on('data', (chunk: string) => { output += chunk; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Codex sign-in timed out. Please try again.')); }, timeoutMilliseconds);
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => { clearTimeout(timeout); resolve({ code: code ?? 1, output }); });
  });
}

async function connectCodexService(): Promise<ConnectionStatus> {
  let status = await runCodexCommand(['login', 'status'], 15_000);
  if (status.code !== 0 || !/logged in/i.test(status.output)) {
    const login = await runCodexCommand(['login'], 300_000);
    if (login.code !== 0) throw new Error(login.output.trim() || 'Codex sign-in did not finish.');
    status = await runCodexCommand(['login', 'status'], 15_000);
  }
  if (status.code !== 0 || !/logged in/i.test(status.output)) throw new Error('Codex could not confirm the ChatGPT sign-in.');
  saveConnection('Codex', { accountLabel: 'ChatGPT account', authMethod: 'codex-cli', connectedAt: new Date().toISOString() });
  return connectionStatus('Codex');
}

async function connectChartmetricService(): Promise<ConnectionStatus> {
  let configured = await runCodexCommand(['mcp', 'get', 'chartmetric', '--json'], 15_000);
  if (configured.code !== 0) {
    const added = await runCodexCommand(['mcp', 'add', 'chartmetric', '--url', 'https://mcp.chartmetric.com/v1/mcp'], 30_000);
    if (added.code !== 0) throw new Error(added.output.trim() || 'Chartmetric could not be added to Codex.');
    configured = await runCodexCommand(['mcp', 'get', 'chartmetric', '--json'], 15_000);
  }
  if (configured.code !== 0) throw new Error(configured.output.trim() || 'Chartmetric is not available in Codex.');
  const login = await runCodexCommand(['mcp', 'login', 'chartmetric'], 300_000);
  if (login.code !== 0) throw new Error(login.output.trim() || 'Chartmetric sign-in did not finish.');
  saveConnection('Chartmetric', { accountLabel: 'Chartmetric account', authMethod: 'codex-mcp', connectedAt: new Date().toISOString() });
  return connectionStatus('Chartmetric');
}

async function connectLastFmService(apiKey?: string): Promise<ConnectionStatus> {
  const trimmed = apiKey?.trim() || '';
  await validateLastFmApiKey(trimmed);
  saveConnection('Last.fm', { accountLabel: 'Free API connected', authMethod: 'api-key', apiKey: trimmed, connectedAt: new Date().toISOString() });
  return connectionStatus('Last.fm');
}

function runCodexPrompt(prompt: string, timeoutMilliseconds = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!getConnection('Codex')) { reject(new Error('Connect Codex in Settings before using AI.')); return; }
    const outputPath = path.join(app.getPath('temp'), `scoutline-ai-${crypto.randomUUID()}.txt`);
    const child = spawn(findCodexExecutable(), ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--output-last-message', outputPath, '-'], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let errorOutput = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { errorOutput += chunk; });
    child.stdin.end(prompt);
    const timeout = setTimeout(() => {
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else child.kill('SIGKILL');
      reject(new Error('Codex generation timed out.'));
    }, timeoutMilliseconds);
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      try {
        if (code !== 0 || !existsSync(outputPath)) throw new Error(errorOutput.trim() || 'Codex did not return a response.');
        const result = readFileSync(outputPath, 'utf8').trim();
        if (!result) throw new Error('Codex returned an empty response.');
        resolve(result);
      } catch (error) { reject(error); }
      finally { if (existsSync(outputPath)) unlinkSync(outputPath); }
    });
  });
}

const googleChromePort = 43822;

function googleChromeExecutable(): string {
  const candidates = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error('Install Google Chrome to connect Google accounts without developer credentials.');
  return executable;
}

type ChromeTarget = { id: string; title: string; url: string; webSocketDebuggerUrl?: string };

async function chromeTargets(): Promise<ChromeTarget[]> {
  try {
    const response = await fetch(`http://127.0.0.1:${googleChromePort}/json/list`, { signal: AbortSignal.timeout(2_000) });
    return response.ok ? await response.json() as ChromeTarget[] : [];
  } catch { return []; }
}

async function openGoogleChrome(url: string): Promise<void> {
  if ((await chromeTargets()).length) {
    await fetch(`http://127.0.0.1:${googleChromePort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(2_000) });
    return;
  }
  const profileDirectory = path.join(app.getPath('userData'), 'google-chrome-session');
  mkdirSync(profileDirectory, { recursive: true });
  const child = spawn(googleChromeExecutable(), [`--remote-debugging-port=${googleChromePort}`, `--user-data-dir=${profileDirectory}`, '--no-first-run', '--no-default-browser-check', url], { detached: true, stdio: 'ignore' });
  child.unref();
}

function googleServiceUrl(service: ConnectionService): string {
  if (service === 'Gmail') return 'https://mail.google.com/mail/u/0/#inbox';
  if (service === 'YouTube') return 'https://www.youtube.com/';
  if (service === 'Claude') return 'https://claude.ai/new';
  return 'https://gemini.google.com/app';
}

async function chromeEvaluate<T>(target: ChromeTarget, expression: string): Promise<T | undefined> {
  if (!target.webSocketDebuggerUrl) return undefined;
  return new Promise((resolve) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl!);
    const timeout = setTimeout(() => { socket.close(); resolve(undefined); }, 3_000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: T } } };
      if (message.id !== 1) return;
      clearTimeout(timeout); socket.close(); resolve(message.result?.result?.value);
    });
    socket.addEventListener('error', () => { clearTimeout(timeout); resolve(undefined); });
  });
}

type ChromeCommandResponse<T = unknown> = { id?: number; result?: T; error?: { message?: string } };

async function chromeCommand<T = unknown>(target: ChromeTarget, method: string, params: Record<string, unknown> = {}, timeoutMilliseconds = 10_000): Promise<T> {
  if (!target.webSocketDebuggerUrl) throw new Error('Chrome did not expose this page for automation.');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl!);
    const timeout = setTimeout(() => { socket.close(); reject(new Error(`Chrome command timed out: ${method}`)); }, timeoutMilliseconds);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as ChromeCommandResponse<T>;
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error) reject(new Error(message.error.message || `Chrome command failed: ${method}`));
      else resolve(message.result as T);
    });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error(`Chrome could not execute: ${method}`)); });
  });
}

async function googleServiceConnected(service: ConnectionService, targets: ChromeTarget[]): Promise<ChromeTarget | undefined> {
  if (service === 'Gmail') return targets.find((target) => /^https:\/\/mail\.google\.com\/mail\/u\/\d+/i.test(target.url));
  if (service === 'YouTube') {
    const target = targets.find((item) => /^https:\/\/(?:www\.)?youtube\.com\//i.test(item.url) && !/accounts\.google\.com/i.test(item.url));
    return target && await chromeEvaluate<boolean>(target, `Boolean(document.querySelector('#avatar-btn img, button#avatar-btn img, ytd-topbar-menu-button-renderer img'))`) ? target : undefined;
  }
  if (service === 'Claude') {
    const target = targets.find((item) => /^https:\/\/claude\.ai\//i.test(item.url) && !/\/login/i.test(item.url));
    return target && await chromeEvaluate<boolean>(target, `Boolean(document.querySelector('[contenteditable="true"], textarea'))`) ? target : undefined;
  }
  const target = targets.find((item) => /^https:\/\/gemini\.google\.com\/app/i.test(item.url));
  return target && await chromeEvaluate<boolean>(target, `Boolean(document.querySelector('[aria-label*="Google Account"], a[href*="SignOutOptions"], [data-ogsr-up]'))`) ? target : undefined;
}

async function connectGoogleChromeService(service: ConnectionService): Promise<ConnectionStatus> {
  await openGoogleChrome(googleServiceUrl(service));
  const expiresAt = Date.now() + 300_000;
  while (Date.now() < expiresAt) {
    const target = await googleServiceConnected(service, await chromeTargets());
    if (target) {
      const accountLabel = target.title.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || `${service} account`;
      saveConnection(service, { accountLabel, authMethod: 'chrome-session', connectedAt: new Date().toISOString() });
      return connectionStatus(service);
    }
    await wait(1_000);
  }
  throw new Error(`${service} sign-in did not finish. Keep the Chrome sign-in window open and try again.`);
}

async function waitForChromeTarget(predicate: (target: ChromeTarget) => boolean, timeoutMilliseconds = 30_000): Promise<ChromeTarget> {
  const expiresAt = Date.now() + timeoutMilliseconds;
  while (Date.now() < expiresAt) {
    const target = (await chromeTargets()).find(predicate);
    if (target) return target;
    await wait(500);
  }
  throw new Error('Google Chrome did not finish loading the requested page.');
}

async function setChromeFileInput(target: ChromeTarget, selector: string, files: string[], timeoutMilliseconds = 30_000): Promise<void> {
  const expiresAt = Date.now() + timeoutMilliseconds;
  const expression = `(() => {
    const find = (root) => {
      const direct = root.querySelector?.(${JSON.stringify(selector)});
      if (direct) return direct;
      for (const element of root.querySelectorAll?.('*') || []) {
        if (element.shadowRoot) { const nested = find(element.shadowRoot); if (nested) return nested; }
      }
      return null;
    };
    return find(document);
  })()`;
  while (Date.now() < expiresAt) {
    const result = await chromeCommand<{ result?: { objectId?: string } }>(target, 'Runtime.evaluate', { expression, objectGroup: 'scoutline-file-input' }).catch(() => undefined);
    const objectId = result?.result?.objectId;
    if (objectId) {
      await chromeCommand(target, 'DOM.setFileInputFiles', { files, objectId });
      await chromeCommand(target, 'Runtime.releaseObjectGroup', { objectGroup: 'scoutline-file-input' }).catch(() => undefined);
      return;
    }
    await wait(500);
  }
  throw new Error('The upload file picker was not available.');
}

async function sendGmailEmail(recipient: string, subject: string, body: string, attachments: string[] = []): Promise<void> {
  if (process.argv.includes('--smoke-test')) {
    if (!recipient || !subject || !body) throw new Error('Smoke email is missing required fields.');
    return;
  }
  if (!getConnection('Gmail')) throw new Error('Connect Gmail in Settings before sending email.');
  for (const attachment of attachments) if (!existsSync(attachment)) throw new Error(`Attachment is missing: ${path.basename(attachment)}`);
  const composeUrl = `https://mail.google.com/mail/u/0/?view=cm&fs=1&to=${encodeURIComponent(recipient)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  await openGoogleChrome(composeUrl);
  const target = await waitForChromeTarget((item) => /^https:\/\/mail\.google\.com\/mail\/u\/\d+/i.test(item.url));
  if (attachments.length) await setChromeFileInput(target, 'input[type="file"]', attachments);
  const expiresAt = Date.now() + 30_000;
  while (Date.now() < expiresAt) {
    const sent = await chromeEvaluate<boolean>(target, `(() => { const buttons = [...document.querySelectorAll('[role="button"]')]; const send = buttons.find((button) => /^(send|send \(⌘enter\))$/i.test((button.getAttribute('data-tooltip') || button.getAttribute('aria-label') || button.textContent || '').trim())); if (!send) return false; send.click(); return true; })()`);
    if (sent) return;
    await wait(500);
  }
  throw new Error('Gmail compose loaded, but the Send button was not available.');
}

async function sendInstagramDm(recipient: string, body: string): Promise<void> {
  if (process.argv.includes('--smoke-test')) {
    if (!recipient || !body) throw new Error('Smoke Instagram DM is missing required fields.');
    return;
  }
  const connection = getConnection('Instagram');
  if (!connection?.partition) throw new Error('Connect Instagram in Settings before sending a DM.');
  const username = recipient.replace(/^@/, '').split('/').filter(Boolean).at(-1);
  if (!username) throw new Error('This artist does not have a verified Instagram username.');
  const instagramSession = session.fromPartition(connection.partition);
  const profileResponse = await instagramSession.fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, { headers: { 'User-Agent': browserUserAgent, 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' } });
  if (!profileResponse.ok) throw new Error('Instagram could not verify this artist profile.');
  const profile = await profileResponse.json() as { data?: { user?: { id?: string } } };
  const userId = profile.data?.user?.id;
  if (!userId) throw new Error('Instagram did not return an account ID for this artist.');
  const csrf = (await instagramSession.cookies.get({ domain: '.instagram.com', name: 'csrftoken' })).at(0)?.value;
  if (!csrf) throw new Error('Instagram session expired. Reconnect Instagram in Settings.');
  const form = new URLSearchParams({ action: 'send_item', client_context: crypto.randomUUID(), mutation_token: crypto.randomUUID(), recipient_users: JSON.stringify([[userId]]), text: body });
  const response = await instagramSession.fetch('https://www.instagram.com/api/v1/direct_v2/threads/broadcast/text/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': browserUserAgent, 'x-csrftoken': csrf, 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' }, body: form.toString() });
  if (!response.ok) throw new Error(`Instagram rejected the DM (${response.status}).`);
  const result = await response.json() as { status?: string; message?: string };
  if (result.status !== 'ok') throw new Error(result.message || 'Instagram did not confirm the DM.');
}

async function syncGmailInbox(contacts: InboxContact[]): Promise<ReturnType<typeof parseGmailAtom>> {
  if (!getConnection('Gmail')) throw new Error('Gmail is not connected.');
  const eligible = contacts.filter((contact) => contact.email);
  if (!eligible.length) return [];
  await openGoogleChrome('https://mail.google.com/mail/u/0/#inbox');
  const target = await waitForChromeTarget((item) => /^https:\/\/mail\.google\.com\/mail\/u\/\d+/i.test(item.url));
  const messages: ReturnType<typeof parseGmailAtom> = [];
  for (let index = 0; index < eligible.length; index += 15) {
    const chunk = eligible.slice(index, index + 15);
    const query = buildGmailQuery(chunk);
    const feedUrl = `https://mail.google.com/mail/feed/atom/?q=${encodeURIComponent(query)}`;
    const xml = await chromeEvaluate<string>(target, `fetch(${JSON.stringify(feedUrl)}, { credentials: 'include' }).then(async (response) => ({ ok: response.ok, url: response.url, text: await response.text() })).then((result) => result.ok ? result.text : Promise.reject(new Error('Gmail feed failed')))`).catch(() => undefined);
    if (!xml || !/<feed[\s>]/i.test(xml)) throw new Error('Gmail session expired. Reconnect Gmail in Settings.');
    messages.push(...parseGmailAtom(xml, chunk));
  }
  return messages;
}

async function syncInstagramInbox(contacts: InboxContact[]): Promise<ReturnType<typeof parseInstagramInbox>> {
  const connection = getConnection('Instagram');
  if (!connection?.partition) throw new Error('Instagram is not connected.');
  const eligible = contacts.filter((contact) => contact.instagramHandle);
  if (!eligible.length) return [];
  const instagramSession = session.fromPartition(connection.partition);
  const response = await instagramSession.fetch('https://www.instagram.com/api/v1/direct_v2/inbox/?persistentBadging=true&folder=&limit=100&thread_message_limit=20', { headers: { 'User-Agent': browserUserAgent, 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' } });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Instagram session expired. Reconnect Instagram in Settings.' : `Instagram inbox sync failed (${response.status}).`);
  return parseInstagramInbox(await response.json(), eligible);
}

async function syncConnectedInboxes(contacts: InboxContact[]): Promise<InboxSyncResult> {
  const warnings: string[] = [];
  const syncedChannels: Array<'Instagram' | 'Email'> = [];
  const messages: InboxSyncResult['messages'] = [];
  const gmailConnected = Boolean(getConnection('Gmail'));
  const instagramConnected = Boolean(getConnection('Instagram'));
  if (!gmailConnected && !instagramConnected) throw new Error('Connect Gmail or Instagram in Settings before syncing replies.');
  if (gmailConnected) {
    try { messages.push(...await syncGmailInbox(contacts)); syncedChannels.push('Email'); }
    catch (error) { warnings.push(error instanceof Error ? error.message : 'Gmail sync failed.'); }
  }
  if (instagramConnected) {
    try { messages.push(...await syncInstagramInbox(contacts)); syncedChannels.push('Instagram'); }
    catch (error) { warnings.push(error instanceof Error ? error.message : 'Instagram sync failed.'); }
  }
  if (!syncedChannels.length) throw new Error(warnings.join(' '));
  return { messages: messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt)), syncedChannels, warnings };
}

function campaignRecipients(state: AppState, campaign: Campaign): Artist[] {
  return state.artists.filter((artist) => campaign.artistIds?.includes(artist.id) && (campaign.channel === 'Email' ? Boolean(artist.email) : Boolean(artist.instagramHandle || artist.instagramUrl)));
}

function startCampaign(campaignId: string) {
  const state = readAppState();
  if (!state) throw new Error('Scoutline state has not loaded yet.');
  const campaign = state.campaigns.find((item) => item.id === campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  const paused = database.prepare("SELECT COUNT(*) AS count FROM background_jobs WHERE type = 'campaign-send' AND status = 'paused' AND json_extract(payload, '$.campaignId') = ?").get(campaignId) as { count: number };
  if (paused.count > 0) {
    database.prepare("UPDATE background_jobs SET status = 'pending', run_at = ?, updated_at = ? WHERE type = 'campaign-send' AND status = 'paused' AND json_extract(payload, '$.campaignId') = ?")
      .run(Date.now(), new Date().toISOString(), campaignId);
    writeAppState({ ...state, campaigns: state.campaigns.map((item) => item.id === campaignId ? { ...item, status: 'Active' } : item) }, 'campaign_resumed');
    return;
  }
  const recipients = campaignRecipients(state, campaign);
  if (!recipients.length) throw new Error('This campaign has no eligible recipients.');
  const runId = crypto.randomUUID();
  recipients.forEach((artist, index) => insertJob({ id: `campaign-${runId}-${artist.id}`, type: 'campaign-send', payload: { campaignId, artistId: artist.id }, runAt: Date.now() + index * Math.max(0, campaign.pacingSeconds) * 1_000 }));
  writeAppState({ ...state, campaigns: state.campaigns.map((item) => item.id === campaignId ? { ...item, status: 'Active', queued: recipients.length, failed: 0 } : item) }, 'campaign_started');
}

function pauseCampaign(campaignId: string) {
  database.prepare("UPDATE background_jobs SET status = 'paused', updated_at = ? WHERE type = 'campaign-send' AND status = 'pending' AND json_extract(payload, '$.campaignId') = ?")
    .run(new Date().toISOString(), campaignId);
  const state = readAppState();
  if (state) writeAppState({ ...state, campaigns: state.campaigns.map((campaign) => campaign.id === campaignId ? { ...campaign, status: 'Paused' } : campaign) }, 'campaign_paused');
}

function automationTargets(state: AppState, automation: Automation): Artist[] {
  if (/Status changes to Connection|Every Friday/i.test(automation.trigger)) return state.artists.filter((artist) => artist.status === 'Connection');
  if (/New prospect/i.test(automation.trigger)) return state.artists.filter((artist) => artist.status === 'Prospect');
  if (/Reply is received/i.test(automation.trigger)) {
    const ids = new Set(state.conversations.filter((conversation) => conversation.messages.some((message) => message.direction === 'incoming')).map((conversation) => conversation.artistId));
    return state.artists.filter((artist) => ids.has(artist.id));
  }
  return state.artists.filter((artist) => artist.lastContactedAt && !state.conversations.some((conversation) => conversation.artistId === artist.id && conversation.messages.some((message) => message.direction === 'incoming' && new Date(message.createdAt).getTime() > new Date(artist.lastContactedAt!).getTime())));
}

function enqueueAutomation(automation: Automation, artist: Artist, eventId: string, manual = false) {
  insertJob({ id: `automation-${automation.id}-${artist.id}-${eventId}`.replace(/[^a-zA-Z0-9_-]/g, '-'), type: 'automation-action', payload: { automationId: automation.id, artistId: artist.id, manual }, runAt: Date.now() + (manual ? 0 : scheduleDelay(automation.schedule)) });
}

function runAutomationNow(automationId: string) {
  const state = readAppState();
  if (!state) throw new Error('Scoutline state has not loaded yet.');
  const automation = state.automations.find((item) => item.id === automationId);
  if (!automation) throw new Error('Automation not found.');
  const targets = automationTargets(state, automation);
  if (!targets.length) throw new Error('No contacts currently match this automation trigger.');
  const eventId = `manual-${Date.now()}`;
  for (const artist of targets) enqueueAutomation(automation, artist, eventId, true);
}

function scheduleAutomationEvents(previous: AppState | null, next: AppState) {
  if (!previous) return;
  const enabled = next.automations.filter((automation) => automation.enabled);
  for (const automation of enabled) {
    if (/New prospect is saved/i.test(automation.trigger)) {
      const oldIds = new Set(previous.artists.map((artist) => artist.id));
      for (const artist of next.artists.filter((candidate) => !oldIds.has(candidate.id) && candidate.status === 'Prospect')) enqueueAutomation(automation, artist, `new-${artist.createdAt}`);
    }
    if (/Status changes to Connection/i.test(automation.trigger)) {
      const oldStatus = new Map(previous.artists.map((artist) => [artist.id, artist.status]));
      for (const artist of next.artists.filter((candidate) => candidate.status === 'Connection' && oldStatus.get(candidate.id) !== 'Connection')) enqueueAutomation(automation, artist, `connection-${Date.now()}`);
    }
    if (/Reply is received/i.test(automation.trigger)) {
      const oldIncoming = new Set(previous.conversations.flatMap((conversation) => conversation.messages.filter((message) => message.direction === 'incoming').map((message) => message.id)));
      for (const conversation of next.conversations) for (const message of conversation.messages.filter((item) => item.direction === 'incoming' && !oldIncoming.has(item.id))) {
        const artist = next.artists.find((candidate) => candidate.id === conversation.artistId);
        if (artist) enqueueAutomation(automation, artist, `reply-${message.id}`);
      }
    }
    if (/Contact has not replied/i.test(automation.trigger)) {
      const oldOutgoing = new Set(previous.conversations.flatMap((conversation) => conversation.messages.filter((message) => message.direction === 'outgoing').map((message) => message.id)));
      for (const conversation of next.conversations) for (const message of conversation.messages.filter((item) => item.direction === 'outgoing' && !oldOutgoing.has(item.id))) {
        const artist = next.artists.find((candidate) => candidate.id === conversation.artistId);
        if (artist) enqueueAutomation(automation, artist, `outreach-${message.id}`);
      }
    }
  }
}

function scheduleWeeklyAutomations() {
  const state = readAppState();
  if (!state) return;
  const now = new Date();
  if (now.getDay() !== 5) return;
  const today = now.toISOString().slice(0, 10);
  for (const automation of state.automations.filter((item) => item.enabled && /Every Friday/i.test(item.trigger))) {
    const time = automation.schedule.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    const hour = time ? (Number(time[1]) % 12) + (/PM/i.test(time[3]) ? 12 : 0) : 10;
    const minute = time ? Number(time[2]) : 30;
    if (now.getHours() < hour || (now.getHours() === hour && now.getMinutes() < minute) || automation.lastRun?.startsWith(today)) continue;
    for (const artist of automationTargets(state, automation)) enqueueAutomation(automation, artist, `weekly-${today}`);
  }
}

async function executeCampaignJob(job: BackgroundJob) {
  const payload = JSON.parse(job.payload) as { campaignId: string; artistId: string };
  let state = readAppState();
  if (!state) throw new Error('Scoutline state is unavailable.');
  const campaign = state.campaigns.find((item) => item.id === payload.campaignId);
  const artist = state.artists.find((item) => item.id === payload.artistId);
  if (!campaign || !artist) throw new Error('Campaign or artist was removed before this send.');
  const recipient = campaign.channel === 'Email' ? artist.email : artist.instagramHandle || artist.instagramUrl;
  if (!recipient) throw new Error('Recipient is missing.');
  const body = renderTemplate(campaign.template, artist);
  const subject = renderTemplate(campaign.subject || 'Quick note for <artist name>', artist);
  const pack = campaign.packId ? state.packs.find((item) => item.id === campaign.packId) : undefined;
  const attachments = pack ? state.assets.filter((asset) => pack.assetIds.includes(asset.id) && asset.path).map((asset) => asset.path!) : [];
  if (campaign.channel === 'Instagram') await sendInstagramDm(recipient, body);
  else await sendGmailEmail(recipient, subject, body, attachments);
  const sentAt = new Date().toISOString();
  state = updateStateArtistConversation(state, artist, campaign.channel, body, sentAt);
  state = {
    ...state,
    campaigns: state.campaigns.map((item) => item.id === campaign.id ? { ...item, sent: item.sent + 1, queued: Math.max(0, item.queued - 1) } : item),
    packs: pack ? state.packs.map((item) => item.id === pack.id ? { ...item, timesSent: item.timesSent + 1 } : item) : state.packs,
    activities: [{ id: crypto.randomUUID(), artistId: artist.id, type: `${campaign.channel} outreach sent`, detail: `${campaign.name} sent to ${artist.name}.`, createdAt: sentAt }, ...state.activities],
  };
  writeAppState(state, 'campaign_send_complete');
}

async function executeAutomationJob(job: BackgroundJob) {
  const payload = JSON.parse(job.payload) as { automationId: string; artistId: string; manual?: boolean };
  let state = readAppState();
  if (!state) throw new Error('Scoutline state is unavailable.');
  const automation = state.automations.find((item) => item.id === payload.automationId);
  const artist = state.artists.find((item) => item.id === payload.artistId);
  if (!automation || !artist) throw new Error('Automation or artist was removed before it ran.');
  if (/Contact has not replied/i.test(automation.trigger)) {
    const replied = state.conversations.some((conversation) => conversation.artistId === artist.id && conversation.messages.some((message) => message.direction === 'incoming' && (!artist.lastContactedAt || message.createdAt > artist.lastContactedAt)));
    if (replied) return;
  }
  const sendsMessage = /Send welcome email|Send newest tagged pack|Instagram follow-up/i.test(automation.action);
  if (sendsMessage && !payload.manual && !state.settings.automaticSending) throw new Error('Automatic sending is disabled in Settings.');
  const now = new Date().toISOString();
  if (/Send welcome email/i.test(automation.action)) {
    if (!artist.email) throw new Error(`${artist.name} does not have an email address.`);
    const body = renderTemplate(automation.message || 'Hey <artist name>,\n\nGreat connecting with you. I wanted to keep our conversation organized here.\n\nBest,\nProducer', artist);
    await sendGmailEmail(artist.email, renderTemplate(automation.subject || 'Great connecting, <artist name>', artist), body);
    state = updateStateArtistConversation(state, artist, 'Email', body, now);
  } else if (/Send newest tagged pack/i.test(automation.action)) {
    if (!artist.email) throw new Error(`${artist.name} does not have an email address.`);
    const pack = automation.packId ? state.packs.find((item) => item.id === automation.packId) : state.packs.at(-1);
    if (!pack) throw new Error('Create a pack before using this automation.');
    const attachments = state.assets.filter((asset) => pack.assetIds.includes(asset.id) && asset.path).map((asset) => asset.path!);
    if (!attachments.length) throw new Error(`${pack.name} has no available files.`);
    const body = renderTemplate((automation.message || 'Hey <artist name>,\n\nHere is the selected pack. Let me know what stands out.\n\nBest,\nProducer').replaceAll('<pack name>', pack.name), artist);
    await sendGmailEmail(artist.email, renderTemplate((automation.subject || '<pack name>').replaceAll('<pack name>', pack.name), artist), body, attachments);
    state = updateStateArtistConversation(state, artist, 'Email', body, now);
    state = { ...state, packs: state.packs.map((item) => item.id === pack.id ? { ...item, timesSent: item.timesSent + 1 } : item) };
  } else if (/Instagram follow-up/i.test(automation.action)) {
    const recipient = artist.instagramHandle || artist.instagramUrl;
    if (!recipient) throw new Error(`${artist.name} does not have a verified Instagram account.`);
    const body = renderTemplate(automation.message || 'Hey <artist name>, just following up on my last message. Would you mind if I send you a link with some quick info?', artist);
    await sendInstagramDm(recipient, body);
    state = updateStateArtistConversation(state, artist, 'Instagram', body, now);
  } else if (/Change contact status/i.test(automation.action)) {
    state = { ...state, artists: state.artists.map((item) => item.id === artist.id ? { ...item, status: automation.targetStatus || 'Connection' } : item) };
  } else {
    state = { ...state, activities: [{ id: crypto.randomUUID(), artistId: artist.id, type: 'Review task', detail: renderTemplate(automation.message || `Review <artist name> after ${automation.trigger.toLowerCase()}.`, artist), createdAt: now }, ...state.activities] };
  }
  state = { ...state, automations: state.automations.map((item) => item.id === automation.id ? { ...item, lastRun: now, lastError: undefined } : item), activities: [{ id: crypto.randomUUID(), artistId: artist.id, type: 'Automation completed', detail: `${automation.name} ran for ${artist.name}.`, createdAt: now }, ...state.activities] };
  writeAppState(state, 'automation_complete');
}

let backgroundRunnerBusy = false;
async function runDueBackgroundJob() {
  if (backgroundRunnerBusy) return;
  backgroundRunnerBusy = true;
  try {
    scheduleWeeklyAutomations();
    const job = database.prepare("SELECT id, type, payload, status, run_at, attempts, last_error FROM background_jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT 1").get(Date.now()) as BackgroundJob | undefined;
    if (!job) return;
    database.prepare("UPDATE background_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    try {
      if (job.type === 'campaign-send') await executeCampaignJob(job);
      else await executeAutomationJob(job);
      database.prepare("UPDATE background_jobs SET status = 'complete', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Background job failed.';
      database.prepare("UPDATE background_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(message, new Date().toISOString(), job.id);
      const payload = JSON.parse(job.payload) as { campaignId?: string; automationId?: string };
      const state = readAppState();
      if (state && payload.campaignId) writeAppState({ ...state, campaigns: state.campaigns.map((campaign) => campaign.id === payload.campaignId ? { ...campaign, failed: campaign.failed + 1, queued: Math.max(0, campaign.queued - 1) } : campaign), activities: [{ id: crypto.randomUUID(), type: 'Campaign send failed', detail: message, createdAt: new Date().toISOString() }, ...state.activities] }, 'campaign_send_failed');
      else if (state && payload.automationId) writeAppState({ ...state, automations: state.automations.map((automation) => automation.id === payload.automationId ? { ...automation, lastError: message } : automation) }, 'automation_failed');
    }
    const payload = JSON.parse(job.payload) as { campaignId?: string };
    if (payload.campaignId) {
      const remaining = database.prepare("SELECT COUNT(*) AS count FROM background_jobs WHERE type = 'campaign-send' AND status IN ('pending', 'running', 'paused') AND json_extract(payload, '$.campaignId') = ?").get(payload.campaignId) as { count: number };
      const state = readAppState();
      if (state && remaining.count === 0) writeAppState({ ...state, campaigns: state.campaigns.map((campaign) => campaign.id === payload.campaignId ? { ...campaign, status: 'Complete', queued: 0 } : campaign) }, 'campaign_complete');
    }
  } finally { backgroundRunnerBusy = false; }
}

type BrowserConnection = {
  partition: string;
  loginUrl: string;
  width: number;
  height: number;
  isConnected: (window: BrowserWindow, serviceSession: Electron.Session) => Promise<boolean>;
  accountLabel: (window: BrowserWindow) => Promise<string>;
};

function browserConnection(service: ConnectionService): BrowserConnection {
  const partition = `persist:scoutline-${service.toLowerCase()}`;
  if (service === 'Instagram') return {
    partition,
    loginUrl: 'https://www.instagram.com/accounts/login/',
    width: 520,
    height: 760,
    isConnected: async (_window, serviceSession) => (await serviceSession.cookies.get({ url: 'https://www.instagram.com', name: 'sessionid' })).length > 0,
    accountLabel: async () => 'Instagram account',
  };
  if (service === 'Spotify') return {
    partition,
    loginUrl: 'https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F',
    width: 560,
    height: 760,
    isConnected: async (window, serviceSession) => {
      const cookies = await serviceSession.cookies.get({ domain: '.spotify.com' });
      if (cookies.some((cookie) => cookie.name === 'sp_dc')) return true;
      if (!window.webContents.getURL().startsWith('https://open.spotify.com')) return false;
      return window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-testid="user-widget-link"], [data-testid="user-widget-avatar"]'))`).catch(() => false);
    },
    accountLabel: async () => 'Spotify account',
  };
  throw new Error(`${service} uses the dedicated Chrome session connector.`);
}

async function connectBrowserService(service: ConnectionService): Promise<ConnectionStatus> {
  const config = browserConnection(service);
  const serviceSession = session.fromPartition(config.partition);
  return new Promise((resolve, reject) => {
    const login = new BrowserWindow({ width: config.width, height: config.height, title: `Connect ${service}`, backgroundColor: '#0b0d10', webPreferences: { partition: config.partition, contextIsolation: true, nodeIntegration: false } });
    login.webContents.setUserAgent(browserUserAgent);
    let finished = false;
    const check = async () => {
      if (finished) return;
      if (await config.isConnected(login, serviceSession)) {
        finished = true;
        clearInterval(interval);
        clearTimeout(timeout);
        saveConnection(service, { accountLabel: await config.accountLabel(login), partition: config.partition, connectedAt: new Date().toISOString() });
        login.close();
        resolve(connectionStatus(service));
      }
    };
    const interval = setInterval(() => void check(), 1200);
    const timeout = setTimeout(() => { if (!finished) { finished = true; clearInterval(interval); login.close(); reject(new Error(`${service} sign-in timed out. Please try again.`)); } }, 300_000);
    login.on('closed', () => { clearInterval(interval); clearTimeout(timeout); if (!finished) { finished = true; reject(new Error(`${service} sign-in was closed before it finished.`)); } });
    void login.loadURL(config.loginUrl, { userAgent: browserUserAgent });
  });
}

async function runClaudePrompt(prompt: string, timeoutMilliseconds = 60_000): Promise<string> {
  if (!getConnection('Claude')) throw new Error('Connect Claude in Settings before using AI.');
  await openGoogleChrome('https://claude.ai/new');
  const target = await waitForChromeTarget((item) => /^https:\/\/claude\.ai\//i.test(item.url) && !/\/login/i.test(item.url));
  const submitted = await chromeEvaluate<boolean>(target, `(() => { const editor = document.querySelector('[contenteditable="true"], textarea'); if (!editor) return false; if (editor instanceof HTMLTextAreaElement) { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(editor, ${JSON.stringify(prompt)}); editor.dispatchEvent(new Event('input', { bubbles: true })); } else { editor.focus(); document.execCommand('insertText', false, ${JSON.stringify(prompt)}); editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(prompt)} })); } const send = [...document.querySelectorAll('button')].find((button) => /send/i.test(button.getAttribute('aria-label') || button.getAttribute('data-testid') || '')); send?.click(); return Boolean(send); })()`);
  if (!submitted) throw new Error('Claude message composer was not available.');
  const expiresAt = Date.now() + timeoutMilliseconds;
  let stableText = '';
  let stableSince = 0;
  while (Date.now() < expiresAt) {
    const response = await chromeEvaluate<string>(target, `(() => { const nodes = [...document.querySelectorAll('[data-testid="assistant-message"], .font-claude-message, [data-is-streaming]')]; return nodes.at(-1)?.innerText?.trim() || ''; })()`);
    if (response && response === stableText) { if (Date.now() - stableSince > 1_500) return response; }
    else { stableText = response || ''; stableSince = Date.now(); }
    await wait(500);
  }
  throw new Error('Claude generation timed out.');
}

async function runGeminiPrompt(prompt: string, timeoutMilliseconds = 60_000): Promise<string> {
  if (!getConnection('Gemini')) throw new Error('Connect Gemini in Settings before using AI.');
  await openGoogleChrome('https://gemini.google.com/app');
  const target = await waitForChromeTarget((item) => /^https:\/\/gemini\.google\.com\/app/i.test(item.url));
  const submitted = await chromeEvaluate<boolean>(target, `(() => {
    const editor = document.querySelector('[contenteditable="true"], textarea');
    if (!editor) return false;
    if (editor instanceof HTMLTextAreaElement) { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(editor, ${JSON.stringify(prompt)}); editor.dispatchEvent(new Event('input', { bubbles: true })); }
    else { editor.focus(); document.execCommand('insertText', false, ${JSON.stringify(prompt)}); editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(prompt)} })); }
    const send = [...document.querySelectorAll('button')].find((button) => /send/i.test(button.getAttribute('aria-label') || button.getAttribute('data-test-id') || ''));
    send?.click(); return Boolean(send);
  })()`);
  if (!submitted) throw new Error('Gemini message composer was not available.');
  const expiresAt = Date.now() + timeoutMilliseconds;
  let stableText = '';
  let stableSince = 0;
  while (Date.now() < expiresAt) {
    const response = await chromeEvaluate<string>(target, `(() => { const nodes = [...document.querySelectorAll('model-response, .model-response-text, [data-test-id="model-response"]')]; return nodes.at(-1)?.innerText?.trim() || ''; })()`);
    if (response && response === stableText) {
      if (Date.now() - stableSince > 1_500) return response;
    } else { stableText = response || ''; stableSince = Date.now(); }
    await wait(500);
  }
  throw new Error('Gemini generation timed out.');
}

async function runAiGeneration(request: AiGenerationRequest): Promise<{ text: string; provider: string }> {
  if (process.argv.includes('--smoke-test') && request.task === 'beat_names') {
    return { text: 'Velvet Skyline\nAfter Hours\nChrome Halo\nSouthbound Static\nMidnight Motion\nPalm Trees in Winter\nBlue Exit Signs\nNeon Testimony\nWestside Weather\nNo Rearview\nCity on Mute\nLast Light', provider: request.provider };
  }
  if (process.argv.includes('--ai-discovery-smoke') && request.task === 'discover_artists') {
    return { text: 'Myquale\nChima Anya\nDoley Bernays\nMatt Swain\nTyler Thomas\nAero Austaire\nAllan Kingdom\nGhetto Concept', provider: request.provider };
  }
  const guardrail = 'Return only the requested message text. Do not explain your answer, use tools, browse, mention these instructions, or add quotation marks.';
  const prompt = `${guardrail}\n\n${request.prompt}`;
  const timeoutMilliseconds = request.task === 'discover_artists' ? 28_000 : request.task === 'beat_names' ? 45_000 : 60_000;
  const text = request.provider === 'Codex' ? await runCodexPrompt(prompt, timeoutMilliseconds) : request.provider === 'Claude' ? await runClaudePrompt(prompt, timeoutMilliseconds) : await runGeminiPrompt(prompt, timeoutMilliseconds);
  return { text: text.trim(), provider: request.provider };
}

const escapeAgreementHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character] || character);

async function saveAgreementPdf(request: AgreementPdfRequest): Promise<{ canceled: boolean; path?: string }> {
  if (!request.title.trim() || !request.agreement.trim()) throw new Error('A completed agreement is required.');
  const safeTitle = request.title.replace(/[^a-z0-9 _-]/gi, '').trim().replace(/\s+/g, '-') || 'Beat-License-Agreement';
  const selection = process.argv.includes('--agreement-pdf-smoke')
    ? { canceled: false, filePath: path.join(app.getPath('temp'), `${safeTitle}-smoke.pdf`) }
    : await (async () => {
      const options = { title: 'Save signed-ready agreement', defaultPath: path.join(app.getPath('documents'), `${safeTitle}.pdf`), filters: [{ name: 'PDF document', extensions: ['pdf'] }] };
      const parent = BrowserWindow.getFocusedWindow();
      return parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options);
    })();
  if (selection.canceled || !selection.filePath) return { canceled: true };
  const printable = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    const agreement = escapeAgreementHtml(request.agreement);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeAgreementHtml(request.title)}</title><style>@page{size:Letter;margin:.7in}*{box-sizing:border-box}body{margin:0;color:#161616;font:10.5pt/1.45 Georgia,"Times New Roman",serif}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}h1{font:700 16pt/1.2 Arial,sans-serif;text-align:center}</style></head><body><pre>${agreement}</pre></body></html>`;
    await printable.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
    const pdf = await printable.webContents.printToPDF({ printBackground: true, pageSize: 'Letter', margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } });
    if (pdf.byteLength < 1_024) throw new Error('The generated agreement PDF was empty.');
    writeFileSync(selection.filePath, pdf);
    return { canceled: false, path: selection.filePath };
  } finally {
    printable.destroy();
  }
}

function runProcess(executable: string, argumentsList: string[], timeoutMilliseconds: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argumentsList, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.on('data', (chunk: string) => { errorOutput += chunk; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Video rendering timed out.')); }, timeoutMilliseconds);
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => { clearTimeout(timeout); code === 0 ? resolve(output.trim()) : reject(new Error(errorOutput.trim() || output.trim() || 'Video rendering failed.')); });
  });
}

async function renderYouTubeVideo(request: YouTubeUploadRequest): Promise<string> {
  if (!existsSync(request.audioPath)) throw new Error('The selected audio file no longer exists.');
  if (!existsSync(request.artworkPath)) throw new Error('The selected artwork file no longer exists.');
  const ffmpegPath = app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg') : path.resolve(dirname, '../../node_modules/ffmpeg-static/ffmpeg');
  if (!existsSync(ffmpegPath)) throw new Error('Scoutline video renderer is missing.');
  const outputDirectory = path.join(app.getPath('userData'), 'youtube-videos');
  mkdirSync(outputDirectory, { recursive: true });
  const safeTitle = request.title.replace(/[^a-z0-9 _-]/gi, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'scoutline-video';
  const outputPath = path.join(outputDirectory, `${safeTitle}-${Date.now()}.mp4`);
  await runProcess(ffmpegPath, ['-y', '-loop', '1', '-i', request.artworkPath, '-i', request.audioPath, '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-tune', 'stillimage', '-r', '1', '-c:a', 'aac', '-b:a', '320k', '-shortest', '-movflags', '+faststart', outputPath], 30 * 60_000);
  if (!existsSync(outputPath) || statSync(outputPath).size < 1_024) throw new Error('The rendered video file was empty.');
  return outputPath;
}

async function clickYouTubeStudio(target: ChromeTarget, matcher: string): Promise<boolean> {
  return Boolean(await chromeEvaluate<boolean>(target, `(() => { const elements = [...document.querySelectorAll('button, tp-yt-paper-button, tp-yt-paper-radio-button, [role="button"], [role="radio"]')]; const item = elements.find((element) => ${matcher}); if (!item) return false; item.click(); return true; })()`));
}

async function uploadYouTubeVideo(request: YouTubeUploadRequest): Promise<{ uploadedAt: string; videoUrl?: string }> {
  if (!getConnection('YouTube')) throw new Error('Connect YouTube in Settings before uploading.');
  if (!request.title.trim()) throw new Error('A YouTube title is required.');
  const videoPath = await renderYouTubeVideo(request);
  await openGoogleChrome('https://www.youtube.com/upload');
  const target = await waitForChromeTarget((item) => /^https:\/\/studio\.youtube\.com\//i.test(item.url), 60_000);
  await setChromeFileInput(target, 'input[type="file"]', [videoPath], 60_000);
  const metadataReadyAt = Date.now() + 60_000;
  let metadataFilled = false;
  while (Date.now() < metadataReadyAt && !metadataFilled) {
    metadataFilled = Boolean(await chromeEvaluate<boolean>(target, `(() => {
      const title = document.querySelector('#title-textarea #textbox, [aria-label*="title"] [contenteditable="true"]');
      const description = document.querySelector('#description-textarea #textbox, [aria-label*="description"] [contenteditable="true"]');
      if (!title || !description) return false;
      const set = (element, value) => { element.focus(); element.textContent = value; element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); element.dispatchEvent(new Event('change', { bubbles: true })); };
      set(title, ${JSON.stringify(request.title)}); set(description, ${JSON.stringify(request.description)});
      const notKids = document.querySelector('[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"], tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'); notKids?.click();
      return true;
    })()`));
    if (!metadataFilled) await wait(500);
  }
  if (!metadataFilled) throw new Error('YouTube Studio did not load the upload details form. The rendered video was kept locally for retrying.');
  if (request.tags.length) {
    await clickYouTubeStudio(target, `/(show more|more options)/i.test((element.textContent || element.getAttribute('aria-label') || '').trim())`);
    await wait(400);
    await chromeEvaluate(target, `(() => { const input = document.querySelector('#tags-container input, input[aria-label*="tag"]'); if (!input) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(request.tags.join(', '))}); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  }
  for (let step = 0; step < 3; step += 1) {
    const expiresAt = Date.now() + 30_000;
    let clicked = false;
    while (Date.now() < expiresAt && !clicked) { clicked = await clickYouTubeStudio(target, `element.id === 'next-button' && !element.disabled`); if (!clicked) await wait(500); }
    if (!clicked) throw new Error('YouTube Studio could not advance to the visibility step. The rendered video was kept locally for retrying.');
    await wait(700);
  }
  if (request.publishAt) {
    const publish = new Date(request.publishAt);
    if (!Number.isFinite(publish.getTime()) || publish.getTime() <= Date.now()) throw new Error('Scheduled publish time must be in the future.');
    await clickYouTubeStudio(target, `element.getAttribute('name') === 'SCHEDULE' || /^schedule$/i.test((element.textContent || '').trim())`);
    await wait(500);
    const date = publish.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    const time = publish.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const scheduled = await chromeEvaluate<boolean>(target, `(() => { const dateInput = document.querySelector('input[aria-label*="date" i], #datepicker-trigger input'); const timeInput = document.querySelector('input[aria-label*="time" i], #time-of-day-container input'); if (!dateInput || !timeInput) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(dateInput, ${JSON.stringify(date)}); dateInput.dispatchEvent(new Event('input', { bubbles: true })); setter.call(timeInput, ${JSON.stringify(time)}); timeInput.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    if (!scheduled) throw new Error('YouTube Studio did not expose the scheduling fields. The rendered video was kept locally for retrying.');
  } else {
    const visibilityName = request.visibility.toUpperCase();
    const selected = await clickYouTubeStudio(target, `element.getAttribute('name') === ${JSON.stringify(visibilityName)} || (element.textContent || '').trim().toUpperCase() === ${JSON.stringify(visibilityName)}`);
    if (!selected) throw new Error('YouTube Studio did not expose the requested visibility option. The rendered video was kept locally for retrying.');
  }
  const finishMatcher = request.publishAt ? `element.id === 'done-button' || /^schedule$/i.test((element.textContent || '').trim())` : `element.id === 'done-button' || /^(save|publish)$/i.test((element.textContent || '').trim())`;
  const expiresAt = Date.now() + 120_000;
  let submitted = false;
  while (Date.now() < expiresAt && !submitted) { submitted = await clickYouTubeStudio(target, finishMatcher); if (!submitted) await wait(750); }
  if (!submitted) throw new Error('YouTube Studio did not enable the final upload button. The rendered video was kept locally for retrying.');
  const confirmationAt = Date.now() + 120_000;
  while (Date.now() < confirmationAt) {
    const result = await chromeEvaluate<{ done: boolean; url?: string }>(target, `(() => { const url = document.querySelector('#share-url, a[href*="youtu.be/"], a[href*="youtube.com/watch"]')?.href || document.querySelector('#share-url')?.textContent?.trim(); const dialog = document.querySelector('ytcp-video-upload-progress, ytcp-uploads-dialog'); const text = dialog?.textContent || ''; return { done: Boolean(url) || /(checks complete|video published|upload complete|scheduled)/i.test(text), url: url || undefined }; })()`);
    if (result?.done) return { uploadedAt: new Date().toISOString(), videoUrl: result.url };
    await wait(1_000);
  }
  throw new Error('YouTube did not confirm the upload. Check YouTube Studio before retrying; the rendered video is saved locally.');
}

type SpotifyApiArtist = { id: string; name: string; images?: { url: string }[]; external_urls?: { spotify?: string }; followers?: { total?: number }; popularity?: number; genres?: string[] };
type SpotifyPublicDetails = { monthlyListeners: number; instagramUrl?: string; email?: string; latestRelease?: string; latestReleaseSpotifyId?: string; latestReleaseImage?: string; popularLocations?: string[]; websiteUrls?: string[]; associatedArtistIds?: string[] };
type SpotifyWorkerArtist = SpotifyPublicDetails & {
  id: string;
  name: string;
  image?: string;
  spotifyUrl: string;
  websiteUrls?: string[];
  instagramFollowers?: number;
  chartmetricId?: string;
  genres?: string[];
  dataSource?: string;
};
const spotifyDiscoveryCache = new Map<string, { artists: SpotifyWorkerArtist[]; expiresAt: number }>();
let aiDiscoveryGenerationCount = 0;

async function spotifyCookieHeader(): Promise<string | undefined> {
  const cookies = await session.fromPartition('persist:scoutline-spotify').cookies.get({ domain: '.spotify.com' });
  const header = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  return header || undefined;
}

async function runSpotifyWorkerRequest(request: unknown, timeoutMilliseconds: number, timeoutMessage: string): Promise<SpotifyWorkerArtist[]> {
  const cookieHeader = await spotifyCookieHeader();
  return new Promise((resolve, reject) => {
    const workerPath = path.join(dirname, 'spotify-worker.js');
    const worker = spawn(process.execPath, [workerPath, JSON.stringify(request)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(cookieHeader ? { SCOUTLINE_SPOTIFY_COOKIE: cookieHeader } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    let errorOutput = '';
    let settled = false;
    const stopWorker = () => {
      if (worker.pid && process.platform !== 'win32') {
        try { process.kill(-worker.pid, 'SIGKILL'); return; } catch { /* worker may already be gone */ }
      }
      worker.kill('SIGKILL');
    };
    const finish = (error?: Error, artists?: SpotifyWorkerArtist[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(artists || []);
    };
    const timeout = setTimeout(() => {
      stopWorker();
      finish(new Error(timeoutMessage));
    }, timeoutMilliseconds);
    worker.stdout.setEncoding('utf8');
    worker.stderr.setEncoding('utf8');
    worker.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 5_000_000) {
        stopWorker();
        finish(new Error('Spotify returned too much discovery data. Please try a narrower search.'));
      }
    });
    worker.stderr.on('data', (chunk: string) => { errorOutput += chunk; });
    worker.on('error', (error) => finish(error));
    worker.on('close', (code) => {
      if (settled) return;
      if (code !== 0) { finish(new Error(errorOutput || 'Spotify discovery could not finish.')); return; }
      try { finish(undefined, JSON.parse(output) as SpotifyWorkerArtist[]); }
      catch { finish(new Error('Spotify returned an unreadable discovery result.')); }
    });
  });
}

async function runSpotifyWorkerDiscovery(artistId: string, minimumListeners: number, maximumListeners: number): Promise<SpotifyWorkerArtist[]> {
  return runSpotifyWorkerRequest({ artistId, minimumListeners, maximumListeners }, 25_000, 'Spotify discovery stopped after 25 seconds. Please try again.');
}

async function runSpotifyWorkerHydration(artists: Array<{ id: string; name: string; image?: string }>): Promise<SpotifyWorkerArtist[]> {
  return runSpotifyWorkerRequest({ artists }, 25_000, 'Spotify profile verification stopped after 25 seconds. Please try again.');
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let activeSpotifyScrapes = 0;
const spotifyScrapeWaiters: Array<() => void> = [];

async function acquireSpotifyScrapeSlot() {
  if (activeSpotifyScrapes < 4) { activeSpotifyScrapes += 1; return; }
  await new Promise<void>((resolve) => spotifyScrapeWaiters.push(resolve));
  activeSpotifyScrapes += 1;
}

function releaseSpotifyScrapeSlot() {
  activeSpotifyScrapes -= 1;
  spotifyScrapeWaiters.shift()?.();
}

async function scrapeSpotifyPage<T>(url: string, script: string, ready: (result: T) => boolean, timeoutMilliseconds = 12_000, settleMilliseconds = 0): Promise<T> {
  await acquireSpotifyScrapeSlot();
  const browser = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { partition: 'persist:scoutline-spotify', contextIsolation: true, nodeIntegration: false } });
  browser.webContents.setUserAgent(browserUserAgent);
  browser.webContents.setAudioMuted(true);
  try {
    await Promise.race([
      browser.loadURL(url, { userAgent: browserUserAgent }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Spotify page load timed out.')), Math.min(timeoutMilliseconds, 12_000))),
    ]);
    if (settleMilliseconds) await wait(settleMilliseconds);
    const expiresAt = Date.now() + timeoutMilliseconds;
    let lastResult: T | undefined;
    while (Date.now() < expiresAt) {
      lastResult = await browser.webContents.executeJavaScript(script).catch(() => undefined) as T | undefined;
      if (lastResult !== undefined && ready(lastResult)) return lastResult;
      await wait(400);
    }
    if (lastResult !== undefined) return lastResult;
    throw new Error('Spotify did not finish loading. Please try again.');
  } finally {
    if (!browser.isDestroyed()) browser.destroy();
    releaseSpotifyScrapeSlot();
  }
}

const spotifyArtistCardsScript = `(() => {
  const artists = new Map();
  for (const link of document.querySelectorAll('a[href*="/artist/"]')) {
    const match = link.href.match(/\\/artist\\/([A-Za-z0-9]+)/);
    if (!match) continue;
    const card = link.closest('[data-testid="card-container"]') || link.closest('[role="group"]') || link.parentElement?.parentElement;
    const rawName = link.getAttribute('title') || link.getAttribute('aria-label') || link.textContent || card?.querySelector('a[href*="/artist/"]')?.textContent || '';
    const name = rawName.replace(/^Play\\s+/i, '').replace(/\\s+/g, ' ').trim();
    if (!name || name.toLowerCase() === 'artist') continue;
    const image = card?.querySelector('img')?.src || link.querySelector('img')?.src;
    if (!artists.has(match[1])) artists.set(match[1], { id: match[1], name, image, spotifyUrl: 'https://open.spotify.com/artist/' + match[1], followers: 0, popularity: 0, genres: [] });
  }
  return [...artists.values()].slice(0, 20);
})()`;

async function spotifySearchArtists(query: string): Promise<SpotifyArtistResult[]> {
  const results = await scrapeSpotifyPage<SpotifyArtistResult[]>(
    `https://open.spotify.com/search/${encodeURIComponent(query)}/artists`,
    spotifyArtistCardsScript,
    (artists) => artists.length > 0,
  );
  return results.slice(0, 10);
}

type SpotifyRenderedGraphArtist = SpotifyWorkerArtist & {
  related: Array<{ id: string; name: string; image?: string; spotifyUrl: string }>;
  associatedArtistIds: string[];
};

async function renderedSpotifyGraphArtist(artistId: string): Promise<SpotifyRenderedGraphArtist> {
  return scrapeSpotifyPage<SpotifyRenderedGraphArtist>(
    `https://open.spotify.com/artist/${artistId}`,
    `(async () => {
      const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const text = document.body?.innerText || '';
      const listenerMatch = text.match(/([\\d,.]+)\\s*([KMB])?\\s+monthly listeners/i);
      const multiplier = listenerMatch?.[2]?.toUpperCase() === 'B' ? 1000000000 : listenerMatch?.[2]?.toUpperCase() === 'M' ? 1000000 : listenerMatch?.[2]?.toUpperCase() === 'K' ? 1000 : 1;
      const monthlyListeners = listenerMatch ? Math.round(Number(listenerMatch[1].replaceAll(',', '')) * multiplier) : 0;
      const sections = [...document.querySelectorAll('section')];
      const fansHeading = [...document.querySelectorAll('h1, h2')].find((heading) => /^fans also like$/i.test(clean(heading.textContent)));
      const fansSection = fansHeading?.closest('section') || fansHeading?.parentElement?.parentElement;
      const related = [];
      const seen = new Set();
      for (const link of fansSection?.querySelectorAll('a[href*="/artist/"]') || []) {
        const match = link.href.match(/\\/artist\\/([A-Za-z0-9]+)/);
        const card = link.closest('[data-testid="card-container"]') || link.closest('li') || link.parentElement?.parentElement;
        const textCandidates = [...new Set([link.getAttribute('title'), link.textContent, ...[...(card?.querySelectorAll('[data-encore-id="text"], span') || [])].map((element) => element.textContent)].map(clean).filter((value) => value && !/^(artist|play|your library|follow)$/i.test(value)))];
        const name = textCandidates.find((value) => value.length < 160 && !/monthly listeners|followers/i.test(value));
        if (!match || match[1] === ${JSON.stringify(artistId)} || !name || seen.has(match[1])) continue;
        seen.add(match[1]);
        related.push({ id: match[1], name, image: card?.querySelector('img')?.src || link.querySelector('img')?.src, spotifyUrl: link.href.split('?')[0] });
      }
      const associatedArtistIds = [...new Set([...document.querySelectorAll('a[href*="/artist/"]')].filter((link) => !fansSection?.contains(link)).map((link) => link.href.match(/\\/artist\\/([A-Za-z0-9]+)/)?.[1]).filter((id) => id && id !== ${JSON.stringify(artistId)}))];
      const encodedState = document.querySelector('#initialState')?.textContent || '';
      let initialState = '';
      try { initialState = encodedState ? atob(encodedState).replaceAll('\\\\u002F', '/').replaceAll('\\\\u0040', '@').replaceAll('\\\\/', '/') : ''; } catch {}
      const aboutHeading = [...document.querySelectorAll('h1, h2')].find((heading) => /^about$/i.test(clean(heading.textContent)));
      aboutHeading?.scrollIntoView({ block: 'center' });
      (aboutHeading?.closest('button, [role="button"]') || aboutHeading?.parentElement?.querySelector('button, [role="button"]'))?.click();
      if (aboutHeading) await new Promise((resolve) => setTimeout(resolve, 1_000));
      const embeddedInstagramUrls = [...initialState.matchAll(/"url":"(https?:\\/\\/[^"]+)"/gi)].map((match) => match[1]);
      const validInstagram = (url) => { try { const parsed = new URL(url, location.href); const handle = parsed.pathname.split('/').filter(Boolean)[0]?.toLowerCase(); return /(^|\\.)instagram\\.com$/i.test(parsed.hostname) && handle && !['spotify', 'spotifyusa', 'spotifyuk', 'spotifyartists'].includes(handle); } catch { return false; } };
      const instagramUrl = embeddedInstagramUrls.find(validInstagram) || [...document.querySelectorAll('a[href*="instagram.com/"]')].filter((link) => !link.closest('footer')).map((link) => link.href).find(validInstagram);
      const email = [...document.querySelectorAll('a[href^="mailto:"]')].map((link) => link.href.replace(/^mailto:/i, '').split('?')[0]).find(Boolean) || text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i)?.[0] || initialState.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i)?.[0];
      const latestSection = sections.find((section) => /latest release/i.test(section.querySelector('h2, h1')?.textContent || ''));
      const releaseLink = latestSection?.querySelector('a[href*="/album/"], a[href*="/track/"]');
      const releaseMatch = releaseLink?.href.match(/\\/(?:album|track)\\/([A-Za-z0-9]+)/);
      const latestRelease = clean(releaseLink?.getAttribute('title') || releaseLink?.getAttribute('aria-label') || releaseLink?.textContent);
      const html = document.documentElement.innerHTML.replaceAll('\\\\u002F', '/');
      const popularLocations = [...new Set([...html.matchAll(/"city":"([^"]+)"/gi), ...initialState.matchAll(/"city":"([^"]+)"/gi)].map((match) => match[1]).filter(Boolean))].slice(0, 10);
      const embeddedUrls = [...initialState.matchAll(/"url":"(https?:\\/\\/[^"]+)"/gi)].map((match) => match[1]);
      const websiteUrls = [...new Set([...document.querySelectorAll('a[href^="http"]')].map((link) => link.href).concat(embeddedUrls).filter((url) => !/(?:spotify|instagram|facebook|twitter|x\\.com|youtube|tiktok)\\./i.test(url)))].slice(0, 3);
      return { id: ${JSON.stringify(artistId)}, name: clean(document.querySelector('[data-testid="entityTitle"] h1, main h1')?.textContent) || ${JSON.stringify(artistId)}, image: document.querySelector('[data-testid="entityTitle"] img, main img')?.src, spotifyUrl: location.href.split('?')[0], monthlyListeners, instagramUrl, email, latestRelease: latestRelease || undefined, latestReleaseSpotifyId: releaseMatch?.[1], latestReleaseImage: releaseLink?.closest('[data-testid="card-container"]')?.querySelector('img')?.src, popularLocations, websiteUrls, related, associatedArtistIds };
    })()`,
    (artist) => artist.related.length > 0 || artist.monthlyListeners > 0,
    25_000,
    2_000,
  );
}

function spotifyRangeDistance(listeners: number, minimum: number, maximum: number): number {
  if (!listeners) return Number.MAX_SAFE_INTEGER;
  if (listeners < minimum) return minimum - listeners;
  if (listeners > maximum) return listeners - maximum;
  return 0;
}

async function runRenderedSpotifyDiscovery(artistId: string, minimumListeners: number, maximumListeners: number): Promise<SpotifyWorkerArtist[]> {
  const seed = await renderedSpotifyGraphArtist(artistId);
  if (!seed.related.length) throw new Error('Spotify did not expose related artists for this profile.');
  type Candidate = SpotifyWorkerArtist & { hop: number; parents: Set<string>; roots: Set<string> };
  const candidates = new Map<string, Candidate>(seed.related.map((artist) => [artist.id, { ...artist, monthlyListeners: 0, hop: 1, parents: new Set([artistId]), roots: new Set([artist.id]) }]));
  const hydrated = new Map<string, SpotifyRenderedGraphArtist>();
  const expanded = new Set<string>();
  const seedAssociates = new Set(seed.associatedArtistIds);
  const independent = () => [...hydrated.values()].filter((artist) => {
    const graph = candidates.get(artist.id);
    return Boolean(graph && graph.hop >= 3 && artist.monthlyListeners > 0 && !seedAssociates.has(artist.id) && !artist.associatedArtistIds.includes(artistId));
  });
  for (let depth = 0; depth < 6; depth += 1) {
    const pending = [...candidates.values()].filter((artist) => !hydrated.has(artist.id)).sort((a, b) => b.roots.size - a.roots.size || b.parents.size - a.parents.size || b.hop - a.hop).slice(0, 32);
    if (!pending.length) break;
    const pages = (await Promise.all(pending.map((artist) => renderedSpotifyGraphArtist(artist.id).catch(() => undefined)))).filter(Boolean) as SpotifyRenderedGraphArtist[];
    for (const page of pages) hydrated.set(page.id, page);
    const matches = independent().filter((artist) => artist.monthlyListeners >= minimumListeners && artist.monthlyListeners <= maximumListeners);
    if (matches.length >= 30 || candidates.size >= 450) break;
    const sources = pages.filter((artist) => artist.related.length && !expanded.has(artist.id)).sort((a, b) => spotifyRangeDistance(a.monthlyListeners, minimumListeners, maximumListeners) - spotifyRangeDistance(b.monthlyListeners, minimumListeners, maximumListeners)).slice(0, 16);
    for (const source of sources) {
      expanded.add(source.id);
      const sourceGraph = candidates.get(source.id);
      if (!sourceGraph) continue;
      for (const related of source.related) {
        if (related.id === artistId) continue;
        const existing = candidates.get(related.id);
        if (existing) {
          existing.hop = Math.min(existing.hop, sourceGraph.hop + 1);
          existing.parents.add(source.id);
          for (const root of sourceGraph.roots) existing.roots.add(root);
        } else candidates.set(related.id, { ...related, monthlyListeners: 0, hop: sourceGraph.hop + 1, parents: new Set([source.id]), roots: new Set(sourceGraph.roots) });
      }
    }
  }
  const discovered = independent().sort((a, b) => {
    const left = candidates.get(a.id)!; const right = candidates.get(b.id)!;
    return right.roots.size - left.roots.size || right.parents.size - left.parents.size || right.hop - left.hop || spotifyRangeDistance(a.monthlyListeners, minimumListeners, maximumListeners) - spotifyRangeDistance(b.monthlyListeners, minimumListeners, maximumListeners);
  }).map(({ related: _related, associatedArtistIds: _associatedArtistIds, ...artist }) => artist);
  if (!discovered.length) throw new Error('Spotify did not return an independent artist network for this search.');
  return discovered;
}

async function runSpotifyDiscovery(artistId: string, minimumListeners: number, maximumListeners: number): Promise<SpotifyWorkerArtist[]> {
  return runSpotifyWorkerDiscovery(artistId, minimumListeners, maximumListeners);
}

const spotifyArtistHtmlCache = new Map<string, { html: string; expiresAt: number }>();

function validSpotifyArtistInstagramUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const handle = parsed.pathname.split('/').filter(Boolean).at(0)?.toLowerCase();
    return /(^|\.)instagram\.com$/i.test(parsed.hostname) && handle && !['spotify', 'spotifyusa', 'spotifyuk', 'spotifyartists'].includes(handle) ? url : undefined;
  } catch { return undefined; }
}

function spotifyArtistExternalUrls(html: string): string[] {
  const encodedState = html.match(/<script id="initialState" type="text\/plain">([^<]+)<\/script>/i)?.[1];
  const initialState = encodedState ? Buffer.from(encodedState, 'base64').toString('utf8').replaceAll('\\u002F', '/').replaceAll('\\/', '/') : '';
  const profileUrls: string[] = [];
  for (const externalLinks of initialState.matchAll(/"externalLinks":\{"items":(\[[^\]]*\])\}/g)) {
    try {
      const items = JSON.parse(externalLinks[1]) as Array<{ url?: string }>;
      for (const item of items) if (item.url) profileUrls.push(item.url);
    } catch { /* ignore malformed embedded metadata */ }
  }
  return [...new Set(profileUrls)];
}

function spotifyArtistInstagramUrl(html: string): string | undefined {
  const urls = [...spotifyArtistExternalUrls(html), ...[...html.matchAll(/https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9._-]+/gi)].map((match) => match[0])];
  return urls.map(validSpotifyArtistInstagramUrl).find(Boolean);
}

async function downloadSpotifyArtistHtml(artistId: string): Promise<string> {
  const response = await fetch(`https://open.spotify.com/artist/${artistId}`, {
    headers: { Accept: 'text/html', 'User-Agent': 'Scoutline/0.6.1' },
    signal: AbortSignal.timeout(7_000),
  });
  if (!response.ok) throw new Error(`Spotify artist page failed (${response.status}).`);
  const html = await response.text();
  if (Buffer.byteLength(html) > 2_000_000) throw new Error('Spotify returned an oversized artist page.');
  return html;
}

async function spotifyArtistHtml(artistId: string): Promise<string> {
  const cached = spotifyArtistHtmlCache.get(artistId);
  if (cached && cached.expiresAt > Date.now()) return cached.html;
  try {
    const html = (await downloadSpotifyArtistHtml(artistId)).replaceAll('\\u002F', '/').replaceAll('\\u0040', '@').replaceAll('\\/', '/');
    if (process.argv.includes('--spotify-catalog-smoke')) console.log(`SCOUTLINE_SPOTIFY_HTML ${JSON.stringify({ artistId, length: html.length, hasListeners: /monthly listeners/i.test(html) })}`);
    spotifyArtistHtmlCache.set(artistId, { html, expiresAt: Date.now() + 300_000 });
    return html;
  } catch (error) {
    if (process.argv.includes('--spotify-catalog-smoke')) console.error(`SCOUTLINE_SPOTIFY_FETCH_ERROR ${artistId} ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

async function publicSpotifyArtistLinks(artistId: string): Promise<SpotifyArtistResult[]> {
  try {
    const html = await spotifyArtistHtml(artistId);
    const artists = new Map<string, SpotifyArtistResult>();
    const links = html.matchAll(/href="\/artist\/([A-Za-z0-9]+)"([\s\S]{0,900}?)<\/a>/gi);
    for (const link of links) {
      if (link[1] === artistId) continue;
      const spans = [...link[2].matchAll(/<span[^>]*>([^<]+)<\/span>/gi)];
      const name = spans.at(-1)?.[1]?.replaceAll('&amp;', '&').replaceAll('&#x27;', "'").trim();
      if (!name) continue;
      const image = link[2].match(/<img[^>]+src="([^"]+)"/i)?.[1];
      if (!artists.has(link[1])) artists.set(link[1], { id: link[1], name, image, spotifyUrl: `https://open.spotify.com/artist/${link[1]}`, followers: 0, popularity: 0, genres: [] });
    }
    return [...artists.values()].slice(0, 30);
  } catch { return []; }
}

async function publicSpotifyDetails(artistId: string, allowRenderedFallback = true, preferRendered = false): Promise<SpotifyPublicDetails> {
  const artistUrl = `https://open.spotify.com/artist/${artistId}`;
  if (!preferRendered) try {
      const html = await spotifyArtistHtml(artistId);
      const listenerMatch = html.match(/([\d,.]+)\s*([KMB])?\s+monthly listeners/i);
      const baseListeners = listenerMatch ? Number(listenerMatch[1].replaceAll(',', '')) : 0;
      const multiplier = listenerMatch?.[2]?.toUpperCase() === 'B' ? 1_000_000_000 : listenerMatch?.[2]?.toUpperCase() === 'M' ? 1_000_000 : listenerMatch?.[2]?.toUpperCase() === 'K' ? 1_000 : 1;
      const monthlyListeners = Math.round(baseListeners * multiplier);
      const instagramUrl = spotifyArtistInstagramUrl(html);
      const websiteUrls = spotifyArtistExternalUrls(html).filter((url) => {
        try {
          const hostname = new URL(url).hostname.replace(/^www\./i, '');
          return !/(?:spotify\.com|instagram\.com|facebook\.com|twitter\.com|x\.com|wikipedia\.org|youtube\.com|tiktok\.com)$/i.test(hostname);
        } catch { return false; }
      }).slice(0, 3);
      const fansHeading = html.toLowerCase().indexOf('>fans also like<');
      const fansEnd = fansHeading >= 0 ? html.toLowerCase().indexOf('<h2', fansHeading + 18) : -1;
      const nonFansHtml = fansHeading >= 0 ? `${html.slice(0, fansHeading)}${fansEnd > fansHeading ? html.slice(fansEnd) : ''}` : html;
      const associatedArtistIds = [...new Set([...nonFansHtml.matchAll(/href="\/artist\/([A-Za-z0-9]+)"/gi)].map((match) => match[1]).filter((id) => id !== artistId))];
      const emails = html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
      const email = emails.find((candidate) => !/@(?:spotify|sentry|w3|example)\./i.test(candidate));
      const latestIndex = html.toLowerCase().indexOf('latest release');
      const latestSection = latestIndex >= 0 ? html.slice(latestIndex, latestIndex + 16_000) : '';
      const latestBlock = latestSection.match(/<a[^>]+href="\/(?:album|track)\/([A-Za-z0-9]+)"[^>]*>[\s\S]{0,6000}?<\/a>/i);
      const latestReleaseSpotifyId = latestBlock?.[1];
      const releaseTexts = [...(latestBlock?.[0] || '').matchAll(/<(?:span|div)[^>]*>([^<>]+)<\/(?:span|div)>/gi)].map((match) => match[1].replaceAll('&amp;', '&').replaceAll('&#x27;', "'").trim());
      const latestRelease = releaseTexts.find((text) => text.length > 0 && text.length < 160 && !/^(latest release|play|album|single|ep|\d[\d,.]*|\d{1,2}\/\d{1,2}\/\d{2,4})$/i.test(text) && !/monthly listeners|followers/i.test(text));
      const latestReleaseImage = latestBlock?.[0].match(/<img[^>]+src="([^"]+)"/i)?.[1];
      if (monthlyListeners > 0) return { monthlyListeners, instagramUrl, email, latestRelease, latestReleaseSpotifyId, latestReleaseImage, websiteUrls, associatedArtistIds };
  } catch { /* rendered-page fallback below */ }
  if (!allowRenderedFallback) return { monthlyListeners: 0 };
  try {
    const details = await scrapeSpotifyPage<SpotifyPublicDetails>(artistUrl, `(async () => {
      const initialText = document.body?.innerText || '';
      const listenerMatch = initialText.match(/([\\d,.]+)\\s+monthly listeners/i);
      const aboutHeading = [...document.querySelectorAll('h1, h2')].find((heading) => /^about$/i.test((heading.textContent || '').trim()));
      aboutHeading?.scrollIntoView({ block: 'center' });
      (aboutHeading?.closest('button, [role="button"]') || aboutHeading?.parentElement?.querySelector('button, [role="button"]'))?.click();
      if (aboutHeading) await new Promise((resolve) => setTimeout(resolve, 1_000));
      const text = document.body?.innerText || initialText;
      const validInstagram = (url) => { try { const parsed = new URL(url, location.href); const handle = parsed.pathname.split('/').filter(Boolean)[0]?.toLowerCase(); return /(^|\\.)instagram\\.com$/i.test(parsed.hostname) && handle && !['spotify', 'spotifyusa', 'spotifyuk', 'spotifyartists'].includes(handle); } catch { return false; } };
      const instagramUrl = [...document.querySelectorAll('a[href*="instagram.com/"]')].filter((link) => !link.closest('footer')).map((link) => link.href).find(validInstagram);
      const websiteUrls = [...new Set([...document.querySelectorAll('a[href^="http"]')].map((link) => link.href).filter((url) => !/(?:spotify|instagram|facebook|twitter|x\\.com|youtube|tiktok)\\./i.test(url)))].slice(0, 3);
      const email = [...document.querySelectorAll('a[href^="mailto:"]')].map((link) => link.href.replace(/^mailto:/i, '').split('?')[0]).find(Boolean) || text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i)?.[0];
      const sections = [...document.querySelectorAll('section')];
      const releaseSection = sections.find((section) => /latest release/i.test(section.querySelector('h2, h1')?.textContent || '')) || sections.find((section) => /discography/i.test(section.querySelector('h2, h1')?.textContent || ''));
      const releaseLink = releaseSection?.querySelector('a[href*="/album/"], a[href*="/track/"]');
      const releaseMatch = releaseLink?.href.match(/\\/(?:album|track)\\/([A-Za-z0-9]+)/);
      const releaseCard = releaseLink?.closest('[data-testid="card-container"]') || releaseLink?.parentElement?.parentElement;
      const latestRelease = releaseLink?.getAttribute('title') || releaseLink?.getAttribute('aria-label') || releaseLink?.textContent?.replace(/\\s+/g, ' ').trim();
      return {
        monthlyListeners: listenerMatch ? Number(listenerMatch[1].replace(/[^0-9]/g, '')) : 0,
        instagramUrl,
        email,
        latestRelease,
        latestReleaseSpotifyId: releaseMatch?.[1],
        latestReleaseImage: releaseCard?.querySelector('img')?.src,
        websiteUrls,
      };
    })()`, (result) => result.monthlyListeners > 0 || Boolean(result.latestRelease), 12_000, 2_000);
    if (details.monthlyListeners || details.instagramUrl || details.latestRelease) return details;
  } catch { return { monthlyListeners: 0 }; }
  return { monthlyListeners: 0 };
}

function publicEmailIn(text: string): string | undefined {
  let searchFrom = 0;
  while (true) {
    const at = text.indexOf('@', searchFrom);
    if (at < 0) return undefined;
    const left = text.slice(Math.max(0, at - 100), at).match(/[A-Z0-9._%+-]+$/i)?.[0];
    const right = text.slice(at + 1, at + 150).match(/^[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    const candidate = left && right ? `${left}@${right}` : undefined;
    if (candidate && !/@(?:instagram|facebook|meta|spotify|sentry|w3|example)\./i.test(candidate)) return candidate;
    searchFrom = at + 1;
  }
}

async function websitePublicEmail(url: string): Promise<string | undefined> {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return undefined;
    const response = await session.defaultSession.fetch(parsed.href, { headers: { 'User-Agent': browserUserAgent }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return undefined;
    return publicEmailIn((await response.text()).replaceAll('\\u0040', '@').replaceAll('\\/', '/'));
  } catch { return undefined; }
}

function socialCount(value: string): number | undefined {
  const match = value.match(/([\d,.]+)\s*([KMB])?/i);
  if (!match) return undefined;
  const multiplier = match[2]?.toUpperCase() === 'B' ? 1_000_000_000 : match[2]?.toUpperCase() === 'M' ? 1_000_000 : match[2]?.toUpperCase() === 'K' ? 1_000 : 1;
  return Math.round(Number(match[1].replaceAll(',', '')) * multiplier);
}

type InstagramProfileDetails = { email?: string; followers?: number; sessionExpired?: boolean; profileFound?: boolean };

let activeInstagramLookups = 0;
const instagramLookupWaiters: Array<() => void> = [];
const instagramProfileCache = new Map<string, { details: InstagramProfileDetails; expiresAt: number }>();

async function acquireInstagramLookupSlot() {
  if (activeInstagramLookups < 5) { activeInstagramLookups += 1; return; }
  await new Promise<void>((resolve) => instagramLookupWaiters.push(resolve));
  activeInstagramLookups += 1;
}

function releaseInstagramLookupSlot() {
  activeInstagramLookups -= 1;
  instagramLookupWaiters.shift()?.();
}

async function renderedInstagramProfileDetails(instagramUrl: string, partition: string): Promise<InstagramProfileDetails> {
  const browser = new BrowserWindow({ show: false, width: 900, height: 760, webPreferences: { partition, contextIsolation: true, nodeIntegration: false } });
  browser.webContents.setUserAgent(browserUserAgent);
  browser.webContents.setAudioMuted(true);
  try {
    await Promise.race([
      browser.loadURL(instagramUrl, { userAgent: browserUserAgent }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Instagram profile timed out.')), 8_000)),
    ]);
    const expiresAt = Date.now() + 6_000;
    while (Date.now() < expiresAt) {
      const details = await browser.webContents.executeJavaScript(`(() => {
        const html = document.documentElement.innerHTML.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('\\u0040', '@').replaceAll('\\/', '/');
        const text = [document.querySelector('meta[name="description"]')?.content || '', document.body?.innerText || '', html].join('\n');
        const count = text.match(/"(?:follower_count|edge_followed_by)"\s*:\s*(?:\{\s*"count"\s*:\s*)?(\d+)/i)?.[1];
        const visible = text.match(/([\d,.]+)\s*([KMB])?\s+Followers/i);
        const multiplier = visible?.[2]?.toUpperCase() === 'B' ? 1000000000 : visible?.[2]?.toUpperCase() === 'M' ? 1000000 : visible?.[2]?.toUpperCase() === 'K' ? 1000 : 1;
        const followers = count ? Number(count) : visible ? Math.round(Number(visible[1].replaceAll(',', '')) * multiplier) : undefined;
        const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
        return { followers, email };
      })()`).catch(() => undefined) as InstagramProfileDetails | undefined;
      if (details?.followers !== undefined || details?.email) return details;
      await wait(350);
    }
    return {};
  } finally {
    if (!browser.isDestroyed()) browser.destroy();
  }
}

async function instagramProfileDetails(instagramUrl?: string, spotifyWebsites: string[] = [], findEmail = false): Promise<InstagramProfileDetails> {
  const normalizedUrl = instagramUrl?.split('?')[0].replace(/\/$/, '');
  const cacheKey = `${normalizedUrl || 'no-instagram'}:${findEmail ? 'email' : 'followers'}:${spotifyWebsites.slice(0, 1).join('|')}`;
  const cached = instagramProfileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.details;
  await acquireInstagramLookupSlot();
  try {
    const websites = [...spotifyWebsites];
    let email: string | undefined;
    let followers: number | undefined;
    let sessionExpired = false;
    let profileFound: boolean | undefined;
    const instagramConnection = getConnection('Instagram');
    if (normalizedUrl && instagramConnection?.partition) {
      const username = normalizedUrl.split('/').filter(Boolean).at(-1)?.replace(/^@/, '');
      if (username) {
        try {
          const instagramSession = session.fromPartition(instagramConnection.partition);
          const sessionCookie = (await instagramSession.cookies.get({ url: 'https://www.instagram.com', name: 'sessionid' })).at(0);
          const csrf = (await instagramSession.cookies.get({ url: 'https://www.instagram.com', name: 'csrftoken' })).at(0)?.value;
          if (!sessionCookie) sessionExpired = true;
          const profileResponse = await instagramSession.fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, {
            headers: { Accept: '*/*', Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`, 'User-Agent': browserUserAgent, 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest', ...(csrf ? { 'x-csrftoken': csrf } : {}) },
            credentials: 'include',
            signal: AbortSignal.timeout(4_500),
          });
          if (profileResponse.status === 401 || profileResponse.status === 403) sessionExpired = true;
          if (profileResponse.ok) {
            const payload = await profileResponse.json() as { data?: { user?: { public_email?: string; business_email?: string; biography?: string; external_url?: string; follower_count?: number; edge_followed_by?: { count?: number } } } };
            const user = payload.data?.user;
            profileFound = Boolean(user);
            email = user?.public_email || user?.business_email || publicEmailIn(user?.biography || '');
            followers = user?.follower_count ?? user?.edge_followed_by?.count;
            if (user?.external_url) websites.unshift(user.external_url);
          }
        } catch { /* continue with public websites */ }
      }
    }
    if (normalizedUrl && instagramConnection?.partition && followers === undefined && !sessionExpired) {
      try {
        const rendered = await renderedInstagramProfileDetails(normalizedUrl, instagramConnection.partition);
        followers = rendered.followers;
        email ||= rendered.email;
        if (rendered.followers !== undefined || rendered.email) profileFound = true;
      } catch { /* public profile fallback below */ }
    }
    if (normalizedUrl && followers === undefined) {
      try {
        const profileResponse = await session.defaultSession.fetch(normalizedUrl, { headers: { 'User-Agent': browserUserAgent }, signal: AbortSignal.timeout(4_000) });
        if (profileResponse.ok) {
          const html = (await profileResponse.text()).replaceAll('&quot;', '"').replaceAll('&#x27;', "'");
          const followerText = html.match(/([\d,.]+\s*[KMB]?)\s+Followers/i)?.[1];
          followers = followerText ? socialCount(followerText) : undefined;
          profileFound = true;
          if (findEmail) email ||= publicEmailIn(html.replaceAll('\\u0040', '@').replaceAll('\\/', '/'));
        }
      } catch { /* an authenticated profile request may still have supplied details */ }
    }
    if (findEmail && !email) {
      for (const website of [...new Set(websites)].slice(0, 1)) {
        email = await websitePublicEmail(website);
        if (email) break;
      }
    }
    const details = { email, followers, sessionExpired, profileFound };
    instagramProfileCache.set(cacheKey, { details, expiresAt: Date.now() + (followers !== undefined || email ? 30 * 60_000 : 5 * 60_000) });
    return details;
  } finally {
    releaseInstagramLookupSlot();
  }
}

async function instagramPublicEmail(instagramUrl?: string, spotifyWebsites: string[] = []): Promise<string | undefined> {
  return (await instagramProfileDetails(instagramUrl, spotifyWebsites, true)).email;
}

async function hydrateSpotifyArtist(artist: SpotifyApiArtist, enrichInstagramEmail = false, allowRenderedFallback = true): Promise<Artist> {
  const publicDetails = await publicSpotifyDetails(artist.id, allowRenderedFallback);
  const email = publicDetails.email || (enrichInstagramEmail ? await instagramPublicEmail(publicDetails.instagramUrl) : undefined);
  const instagramHandle = publicDetails.instagramUrl ? `@${publicDetails.instagramUrl.split('/').filter(Boolean).at(-1)}` : undefined;
  return {
    id: `spotify-${artist.id}`,
    name: artist.name,
    image: artist.images?.[0]?.url,
    status: 'Prospect',
    spotifyId: artist.id,
    spotifyUrl: artist.external_urls?.spotify || `https://open.spotify.com/artist/${artist.id}`,
    spotifyFollowers: artist.followers?.total || 0,
    spotifyPopularity: artist.popularity || 0,
    monthlyListeners: publicDetails.monthlyListeners,
    instagramFollowers: 0,
    instagramUrl: publicDetails.instagramUrl,
    instagramHandle,
    email,
    genres: artist.genres || [],
    latestRelease: publicDetails.latestRelease,
    latestReleaseType: publicDetails.latestRelease ? 'release' : undefined,
    latestReleaseSpotifyId: publicDetails.latestReleaseSpotifyId,
    latestReleaseImage: publicDetails.latestReleaseImage,
    confidence: publicDetails.instagramUrl ? 'verified' : 'unverified',
    confidenceScore: publicDetails.instagramUrl ? 100 : 0,
    evidence: [
      ...(publicDetails.instagramUrl ? [{ label: 'Instagram', source: 'Spotify artist profile', value: instagramHandle || publicDetails.instagramUrl, strength: 'decisive' as const }] : []),
      ...(email ? [{ label: 'Public email', source: publicDetails.email ? 'Spotify artist profile' : 'Instagram artist profile', value: email, strength: 'supporting' as const }] : []),
    ],
    source: 'Spotify live discovery',
    createdAt: new Date().toISOString(),
    lastVerifiedAt: publicDetails.instagramUrl ? new Date().toISOString() : undefined,
    contactedCount: 0,
    lists: [],
  };
}

async function expandSpotifyDiscoveryWithAi(criteria: SpotifyFindCriteria, existing: SpotifyWorkerArtist[]): Promise<SpotifyWorkerArtist[]> {
  const state = readAppState();
  const provider = state?.settings.aiProvider;
  const isolatedSmoke = process.argv.includes('--ai-discovery-smoke');
  if (!provider || (!getConnection(provider) && !isolatedSmoke) || !criteria.seedName) return [];
  const instagramRange = criteria.minimumInstagramFollowers !== undefined && criteria.maximumInstagramFollowers !== undefined
    ? ` Prefer artists likely to have ${criteria.minimumInstagramFollowers.toLocaleString()} to ${criteria.maximumInstagramFollowers.toLocaleString()} Instagram followers.`
    : '';
  const emailPreference = criteria.publicEmailRequired ? ' Require artists likely to list a public business email.' : ' Prefer artists likely to list a public business email.';
  const locationPreference = criteria.popularIn ? ` Prefer artists with an audience in ${criteria.popularIn}.` : '';
  const instruction = `List 12 real, active, emerging independent artists who are sonically or audience-similar to ${criteria.seedName}. Search broadly across adjacent independent scenes rather than the artist's direct professional network. Avoid members of ${criteria.seedName}'s label, crew, group, immediate collaborators, and famous legacy artists. Favor artists likely to have ${criteria.minimumListeners.toLocaleString()} to ${criteria.maximumListeners.toLocaleString()} Spotify monthly listeners.${instagramRange}${emailPreference}${locationPreference} Return only one exact Spotify artist name per line.`;
  aiDiscoveryGenerationCount += 1;
  const response = await runAiGeneration({ provider, task: 'discover_artists', prompt: instruction });
  const names = parseArtistNameList(response.text).slice(0, 12);
  const existingIds = new Set(existing.map((artist) => artist.id));
  const candidates: SpotifyWorkerArtist[] = [];
  const graphSources: SpotifyRenderedGraphArtist[] = [];
  for (let index = 0; index < names.length; index += 4) {
    const batch = names.slice(index, index + 4);
    const results = await Promise.all(batch.map(async (name) => {
      try {
        const found = await spotifySearchArtists(name);
        const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        const match = found.find((artist) => artist.name.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized) || found.at(0);
        if (!match || existingIds.has(match.id)) return undefined;
        const profile = await renderedSpotifyGraphArtist(match.id);
        if (!profile.monthlyListeners) return undefined;
        return {
          graph: { ...profile, id: match.id, name: match.name, image: match.image || profile.image, spotifyUrl: match.spotifyUrl },
          artist: { ...profile, id: match.id, name: match.name, image: match.image || profile.image, spotifyUrl: match.spotifyUrl } satisfies SpotifyWorkerArtist,
        };
      } catch { return undefined; }
    }));
    for (const result of results) if (result && !existingIds.has(result.artist.id)) {
      existingIds.add(result.artist.id);
      candidates.push(result.artist);
      graphSources.push(result.graph);
    }
    if (candidates.filter((artist) => artist.monthlyListeners >= criteria.minimumListeners && artist.monthlyListeners <= criteria.maximumListeners).length >= 3) break;
  }
  const relatedPool = new Map<string, { id: string; name: string; image?: string; spotifyUrl: string }>();
  for (const source of graphSources.sort((left, right) => spotifyRangeDistance(left.monthlyListeners, criteria.minimumListeners, criteria.maximumListeners) - spotifyRangeDistance(right.monthlyListeners, criteria.minimumListeners, criteria.maximumListeners)).slice(0, 6)) {
    for (const related of source.related) if (!existingIds.has(related.id) && !relatedPool.has(related.id)) relatedPool.set(related.id, related);
  }
  const relatedArtists = [...relatedPool.values()].slice(0, 16);
  for (let index = 0; index < relatedArtists.length; index += 4) {
    const batch = relatedArtists.slice(index, index + 4);
    const results = await Promise.all(batch.map(async (related) => {
      try {
        const profile = await renderedSpotifyGraphArtist(related.id);
        if (!profile.monthlyListeners) return undefined;
        return { ...profile, id: related.id, name: related.name, image: related.image || profile.image, spotifyUrl: related.spotifyUrl } satisfies SpotifyWorkerArtist;
      } catch { return undefined; }
    }));
    for (const artist of results) if (artist && !existingIds.has(artist.id)) { existingIds.add(artist.id); candidates.push(artist); }
    if (candidates.filter((artist) => artist.monthlyListeners >= criteria.minimumListeners && artist.monthlyListeners <= criteria.maximumListeners).length >= 6) break;
  }
  const contactFilterActive = instagramFilterIsActive(criteria.minimumInstagramFollowers ?? 0, criteria.maximumInstagramFollowers ?? Number.MAX_SAFE_INTEGER) || criteria.publicEmailRequired;
  if (contactFilterActive) {
    const secondHopPool = new Map<string, { id: string; name: string; image?: string; spotifyUrl: string }>();
    const inRangeSources = candidates.filter((artist) => artist.monthlyListeners >= criteria.minimumListeners && artist.monthlyListeners <= criteria.maximumListeners) as SpotifyRenderedGraphArtist[];
    for (const source of inRangeSources) {
      for (const related of (source.related || []).slice(0, 4)) if (!existingIds.has(related.id) && !secondHopPool.has(related.id)) secondHopPool.set(related.id, related);
    }
    const secondHopArtists = [...secondHopPool.values()].slice(0, 16);
    for (let index = 0; index < secondHopArtists.length; index += 4) {
      const batch = secondHopArtists.slice(index, index + 4);
      const results = await Promise.all(batch.map(async (related) => {
        try {
          const profile = await renderedSpotifyGraphArtist(related.id);
          if (!profile.monthlyListeners) return undefined;
          return { ...profile, id: related.id, name: related.name, image: related.image || profile.image, spotifyUrl: related.spotifyUrl } satisfies SpotifyWorkerArtist;
        } catch { return undefined; }
      }));
      for (const artist of results) if (artist && !existingIds.has(artist.id)) {
        existingIds.add(artist.id);
        if (artist.monthlyListeners >= criteria.minimumListeners && artist.monthlyListeners <= criteria.maximumListeners) candidates.unshift(artist);
        else candidates.push(artist);
      }
    }
  }
  return candidates;
}

function normalizedArtistName(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function jsonArrayFromText<T>(text: string): T[] {
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = unfenced.indexOf('[');
  const end = unfenced.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('Chartmetric returned an unreadable discovery result.');
  const parsed = JSON.parse(unfenced.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('Chartmetric returned an unreadable discovery result.');
  return parsed as T[];
}

function numericMetric(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value !== 'string') return 0;
  return socialCount(value) || Math.max(0, Math.round(Number(value.replaceAll(',', '')) || 0));
}

async function runChartmetricDiscovery(criteria: SpotifyFindCriteria): Promise<SpotifyWorkerArtist[]> {
  if (!criteria.seedName) throw new Error('Choose a seed artist first.');
  const instruction = `Use only the connected Chartmetric MCP tools to find up to 30 real artists similar to ${JSON.stringify(criteria.seedName)}. Apply Spotify monthly listeners ${criteria.minimumListeners} through ${criteria.maximumListeners}.${criteria.popularIn ? ` Prefer artists popular in ${criteria.popularIn}.` : ''} Return a JSON array only. Every item must use these keys: name, chartmetricId, spotifyId, spotifyUrl, image, monthlyListeners, instagramFollowers, instagramUrl, email, genres, popularLocations, latestRelease. Use null when Chartmetric does not have a field. Do not invent values and do not include the seed artist.`;
  const response = await runCodexPrompt(instruction, 120_000);
  type RawChartmetricArtist = {
    name?: unknown; chartmetricId?: unknown; spotifyId?: unknown; spotifyUrl?: unknown; image?: unknown; monthlyListeners?: unknown;
    instagramFollowers?: unknown; instagramUrl?: unknown; email?: unknown; genres?: unknown; popularLocations?: unknown; latestRelease?: unknown;
  };
  const rawArtists = jsonArrayFromText<RawChartmetricArtist>(response);
  const artists: SpotifyWorkerArtist[] = [];
  for (const raw of rawArtists) {
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name || normalizedArtistName(name) === normalizedArtistName(criteria.seedName)) continue;
    let spotifyId = typeof raw.spotifyId === 'string' ? raw.spotifyId.trim() : '';
    if (!spotifyId && typeof raw.spotifyUrl === 'string') spotifyId = raw.spotifyUrl.match(/open\.spotify\.com\/artist\/([A-Za-z0-9]+)/)?.[1] || '';
    if (!spotifyId) {
      const search = await spotifySearchArtists(name).catch(() => []);
      spotifyId = search.find((candidate) => normalizedArtistName(candidate.name) === normalizedArtistName(name))?.id || '';
    }
    if (!spotifyId) continue;
    artists.push({
      id: spotifyId,
      name,
      chartmetricId: typeof raw.chartmetricId === 'string' ? raw.chartmetricId : undefined,
      image: typeof raw.image === 'string' ? raw.image : undefined,
      spotifyUrl: typeof raw.spotifyUrl === 'string' ? raw.spotifyUrl : `https://open.spotify.com/artist/${spotifyId}`,
      monthlyListeners: numericMetric(raw.monthlyListeners),
      instagramFollowers: raw.instagramFollowers === null || raw.instagramFollowers === undefined ? undefined : numericMetric(raw.instagramFollowers),
      instagramUrl: validSpotifyArtistInstagramUrl(typeof raw.instagramUrl === 'string' ? raw.instagramUrl : undefined),
      email: typeof raw.email === 'string' && raw.email.includes('@') ? raw.email : undefined,
      latestRelease: typeof raw.latestRelease === 'string' ? raw.latestRelease : undefined,
      popularLocations: Array.isArray(raw.popularLocations) ? raw.popularLocations.filter((value): value is string => typeof value === 'string') : undefined,
      genres: Array.isArray(raw.genres) ? raw.genres.filter((value): value is string => typeof value === 'string') : undefined,
      dataSource: 'Chartmetric',
    });
  }
  if (!artists.length) throw new Error('Chartmetric returned no usable artists for this search.');
  return artists;
}

let activeFreeDiscoveryRun = 0;

async function runFreeProviderDiscovery(seedSpotifyId: string, criteria: SpotifyFindCriteria): Promise<SpotifyWorkerArtist[]> {
  if (!criteria.seedName) throw new Error('Choose a seed artist first.');
  const run = ++activeFreeDiscoveryRun;
  const lastFmApiKey = getConnection('Last.fm')?.apiKey;
  const candidates = await discoverFreeCandidates(criteria.seedName, lastFmApiKey);
  if (run !== activeFreeDiscoveryRun) throw new Error('A newer Finder search replaced this one.');
  const musicBrainzIds = candidates.flatMap((candidate) => candidate.musicBrainzId ? [candidate.musicBrainzId] : []);
  const spotifyIds = await resolveSpotifyIdsFromListenBrainz(musicBrainzIds).catch(() => new Map<string, string>());
  const unresolvedMusicBrainzIds = musicBrainzIds.filter((musicBrainzId) => !spotifyIds.has(musicBrainzId));
  if (unresolvedMusicBrainzIds.length) {
    const fallbackIds = await resolveSpotifyIdsFromWikidata(unresolvedMusicBrainzIds.slice(0, 25)).catch(() => new Map<string, string>());
    for (const [musicBrainzId, spotifyId] of fallbackIds) spotifyIds.set(musicBrainzId, spotifyId);
  }
  if (process.argv.includes('--real-finder-test')) console.log(`SCOUTLINE_REAL_DISCOVERY_STAGE ${JSON.stringify({ candidates: candidates.length, musicBrainzIds: musicBrainzIds.length, spotifyIds: spotifyIds.size })}`);
  const selected: Array<{ name: string; spotifyId: string; source: string }> = [];
  const seenSpotifyIds = new Set([seedSpotifyId]);
  const orderedCandidates = criteria.maximumListeners <= 1_000_000
    ? [...candidates].sort((left, right) => Number(right.sources.includes('MusicBrainz') && !right.sources.includes('ListenBrainz')) - Number(left.sources.includes('MusicBrainz') && !left.sources.includes('ListenBrainz')) || right.roots - left.roots || right.score - left.score)
    : candidates;
  for (const candidate of orderedCandidates) {
    const spotifyId = candidate.musicBrainzId ? spotifyIds.get(candidate.musicBrainzId) : undefined;
    if (!spotifyId || seenSpotifyIds.has(spotifyId)) continue;
    seenSpotifyIds.add(spotifyId);
    selected.push({ name: candidate.name, spotifyId, source: candidate.sources.join(' + ') });
    if (selected.length >= 500) break;
  }
  if (process.argv.includes('--real-finder-test')) console.log(`SCOUTLINE_REAL_DISCOVERY_SELECTED ${JSON.stringify({ selected: selected.length })}`);

  const discovered: SpotifyWorkerArtist[] = [];
  for (let offset = 0; offset < selected.length; offset += 100) {
    if (run !== activeFreeDiscoveryRun) throw new Error('A newer Finder search replaced this one.');
    const batch = selected.slice(offset, offset + 100);
    const sourceById = new Map(batch.map((candidate) => [candidate.spotifyId, candidate.source]));
    const hydrated = await runSpotifyWorkerHydration(batch.map((candidate) => ({ id: candidate.spotifyId, name: candidate.name }))).catch(() => []);
    discovered.push(...hydrated.filter((details) => details.monthlyListeners > 0 && !details.associatedArtistIds?.includes(seedSpotifyId)).map((details) => ({ ...details, dataSource: sourceById.get(details.id) || 'Free sources' })));
    if (process.argv.includes('--real-finder-test')) console.log(`SCOUTLINE_REAL_DISCOVERY_HYDRATED ${JSON.stringify({ checked: Math.min(offset + batch.length, selected.length), verified: discovered.length, inRange: discovered.filter((artist) => artist.monthlyListeners >= criteria.minimumListeners && artist.monthlyListeners <= criteria.maximumListeners).length })}`);
    const inRange = discovered.filter((artist) => artist.monthlyListeners >= criteria.minimumListeners && artist.monthlyListeners <= criteria.maximumListeners);
    if (inRange.length > 0) break;
  }
  if (!discovered.length) throw new Error('The free discovery sources returned artists, but their Spotify profiles could not be verified.');
  return discovered;
}

function connectDatabase() {
  const databasePath = path.join(app.getPath('userData'), 'scoutline.sqlite');
  database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connections (
      service TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS spotify_discovery_cache (
      cache_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      run_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS background_jobs_due ON background_jobs(status, run_at);
  `);
}

function readAppState(): AppState | null {
  const row = database.prepare('SELECT payload FROM app_state WHERE id = 1').get() as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as AppState : null;
}

function broadcastState(state: AppState) {
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('state:changed', state);
}

function writeAppState(state: AppState, action = 'state_saved', broadcast = true) {
  const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`
      INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(JSON.stringify(state), now);
    database.prepare('INSERT INTO audit_log (action, created_at) VALUES (?, ?)').run(action, now);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  if (broadcast) broadcastState(state);
}

type BackgroundJob = {
  id: string;
  type: 'campaign-send' | 'automation-action';
  payload: string;
  status: 'pending' | 'running' | 'paused' | 'complete' | 'failed' | 'cancelled';
  run_at: number;
  attempts: number;
  last_error?: string;
};

function insertJob(job: { id: string; type: BackgroundJob['type']; payload: unknown; runAt: number; status?: BackgroundJob['status'] }) {
  const now = new Date().toISOString();
  database.prepare(`INSERT OR IGNORE INTO background_jobs (id, type, payload, status, run_at, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`)
    .run(job.id, job.type, JSON.stringify(job.payload), job.status || 'pending', job.runAt, now, now);
}

function updateStateArtistConversation(state: AppState, artist: Artist, channel: 'Instagram' | 'Email', body: string, sentAt: string): AppState {
  const existing = state.conversations.find((conversation) => conversation.artistId === artist.id && conversation.channel === channel);
  const conversations = existing
    ? state.conversations.map((conversation) => conversation.id === existing.id ? { ...conversation, updatedAt: sentAt, messages: [...conversation.messages, { id: crypto.randomUUID(), direction: 'outgoing' as const, body, createdAt: sentAt, read: true }] } : conversation)
    : [...state.conversations, { id: crypto.randomUUID(), artistId: artist.id, channel, updatedAt: sentAt, messages: [{ id: crypto.randomUUID(), direction: 'outgoing' as const, body, createdAt: sentAt, read: true }] }];
  return {
    ...state,
    artists: state.artists.map((item) => item.id === artist.id ? { ...item, contactedCount: item.contactedCount + 1, lastContactedAt: sentAt } : item),
    conversations,
  };
}

function renderTemplate(value: string, artist: Artist) {
  return value.replaceAll(/<artist name>/gi, artist.name).replaceAll(/<release name>/gi, artist.latestRelease || 'your latest release');
}

function scheduleDelay(schedule: string): number {
  if (/1 minute/i.test(schedule)) return 60_000;
  if (/1 day/i.test(schedule)) return 86_400_000;
  if (/7 days/i.test(schedule)) return 7 * 86_400_000;
  return 0;
}

function createWindow() {
  const smokeTest = process.argv.includes('--smoke-test');
  const realFinderTest = process.argv.includes('--real-finder-test');
  const agreementPdfSmoke = process.argv.includes('--agreement-pdf-smoke');
  const spotifyCatalogSmoke = process.argv.includes('--spotify-catalog-smoke');
  const finderToggleSmoke = process.argv.includes('--finder-toggle-smoke');
  const finderInstagramSmoke = process.argv.includes('--finder-instagram-smoke');
  const aiDiscoveryCountAtSmokeStart = aiDiscoveryGenerationCount;
  const codexAuthSmoke = process.argv.includes('--codex-auth-smoke');
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0d10',
    show: !smokeTest && !realFinderTest,
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (smokeTest) {
    window.webContents.once('did-finish-load', async () => {
      const result = await window.webContents.executeJavaScript(`new Promise(async (resolve) => {
        const started = Date.now();
        const waitFor = (selector, timeout = 3000) => new Promise((done) => {
          const waitingSince = Date.now();
          const checkSelector = () => {
            const element = document.querySelector(selector);
            if (element || Date.now() - waitingSince > timeout) done(element);
            else setTimeout(checkSelector, 30);
          };
          checkSelector();
        });
        const waitForEnabled = (selector, timeout = 5000) => new Promise((done) => {
          const waitingSince = Date.now();
          const checkEnabled = () => {
            const element = document.querySelector(selector);
            if ((element && !element.disabled) || Date.now() - waitingSince > timeout) done(element);
            else setTimeout(checkEnabled, 30);
          };
          checkEnabled();
        });
        const waitForGone = (selector, timeout = 15000) => new Promise((done) => {
          const waitingSince = Date.now();
          const checkGone = () => {
            if (!document.querySelector(selector) || Date.now() - waitingSince > timeout) done(!document.querySelector(selector));
            else setTimeout(checkGone, 30);
          };
          checkGone();
        });
        const waitForText = (selector, pattern, timeout = 15000) => new Promise((done) => {
          const waitingSince = Date.now();
          const checkText = () => {
            const element = document.querySelector(selector);
            if ((element && pattern.test(element.textContent || '')) || Date.now() - waitingSince > timeout) done(element);
            else setTimeout(checkText, 30);
          };
          checkText();
        });
        const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
        const setValue = (selector, value) => {
          const element = document.querySelector(selector);
          if (!element) return false;
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          setter?.call(element, value);
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        };
        const check = async () => {
          const brand = document.querySelector('.brand strong')?.textContent;
          const navigationItems = document.querySelectorAll('.nav-item').length;
          if ((brand && navigationItems > 0) || Date.now() - started > 5000) {
            document.querySelector('[data-testid="nav-automations"]')?.click();
            const newAutomation = await waitFor('[data-testid="new-automation"]');
            newAutomation?.click();
            const automationModal = Boolean(await waitFor('[data-testid="automation-modal"]'));
            document.querySelector('[data-testid="automation-modal"] .modal-header button')?.click();
            await waitForGone('[data-testid="automation-modal"]', 3000);
            document.querySelector('[data-testid="nav-tools"]')?.click();
            await waitFor('[data-testid="tool-ai-beat-name-generator"]');
            const toolNames = ['non-exclusive-beat-license-agreement', 'exclusive-beat-license-agreement', 'ai-beat-name-generator', 'metadata-formatter', 'outreach-template-builder'];
            let workingTools = 0;
            let functionalTools = 0;
            let beatNamesGenerated = false;
            let agreementPdfExported = -1;
            for (const toolName of toolNames) {
              document.querySelector('[data-testid="tool-' + toolName + '"]')?.click();
              const modal = await waitFor('[data-testid="local-tool-modal"]');
              if (modal) workingTools += 1;
              if (toolName.includes('beat-license-agreement')) {
                setValue('[data-agreement-field="beatTitle"]', 'Midnight Motion');
                setValue('[data-agreement-field="producerAddress"]', '100 Studio Ave, New York, NY 10001');
                setValue('[data-agreement-field="artistLegalName"]', 'Alex Artist');
                setValue('[data-agreement-field="artistEmail"]', 'artist@example.com');
                setValue('[data-agreement-field="artistAddress"]', '200 Artist St, Brooklyn, NY 11201');
                setValue('[data-agreement-field="governingState"]', 'New York');
                setValue('[data-agreement-field="governingCounty"]', 'New York County');
                document.querySelector('[data-testid="generate-agreement"]')?.click();
                const expectedTitle = toolName.startsWith('non-exclusive') ? /NON-EXCLUSIVE BEAT LICENSE AGREEMENT/ : /EXCLUSIVE BEAT LICENSE AGREEMENT/;
                const output = await waitForText('[data-testid="agreement-output"]', expectedTitle, 3000);
                const text = output?.textContent || '';
                if (text.includes('21. COUNTERPARTS AND ELECTRONIC SIGNATURES') && text.includes('ARTIST / LICENSEE') && document.querySelector('[data-testid="download-agreement-pdf"]')) functionalTools += 1;
                if (${agreementPdfSmoke} && toolName.startsWith('non-exclusive') && text) {
                  const saved = await window.scoutline.saveAgreementPdf({ title: 'Non-Exclusive Beat License - Midnight Motion', agreement: text });
                  agreementPdfExported = !saved.canceled && Boolean(saved.path?.endsWith('.pdf')) ? 1 : 0;
                }
              }
              if (toolName === 'ai-beat-name-generator') {
                setValue('[data-testid="beat-artist"]', 'Snoop Dogg');
                setValue('[data-testid="beat-moods"]', 'cinematic, confident');
                setValue('[data-testid="beat-subject"]', 'Los Angeles after midnight');
                document.querySelector('[data-testid="generate-beat-names"]')?.click();
                beatNamesGenerated = Boolean(await waitFor('.generated-name-grid button'));
                if (beatNamesGenerated) functionalTools += 1;
              }
              if (toolName === 'metadata-formatter') {
                setValue('[data-metadata-field="beatTitle"]', 'Signal Fire');
                setValue('[data-metadata-field="primaryArtist"]', 'Luna Harbor');
                setValue('[data-metadata-field="bpm"]', '142');
                setValue('[data-metadata-field="musicalKey"]', 'C# minor');
                document.querySelector('[data-testid="format-metadata"]')?.click();
                const metadataOutput = await waitFor('[data-testid="metadata-output"]', 3000);
                const metadataText = metadataOutput?.textContent || '';
                if (metadataText.includes('RELEASE METADATA') && metadataText.includes('CREDITS') && metadataText.includes('IDENTIFIERS') && metadataText.includes('COPYRIGHT LINES')) functionalTools += 1;
              }
              if (toolName === 'outreach-template-builder') {
                setValue('[data-template-preview="artist_name"]', 'Chima Anya');
                setValue('[data-template-preview="latest_release"]', 'The Sun Is Shining');
                await pause(50);
                const templateText = document.querySelector('.template-preview')?.textContent || '';
                if (templateText.includes('Chima Anya') && templateText.includes('The Sun Is Shining')) functionalTools += 1;
              }
              document.querySelector('[data-testid="local-tool-modal"] .modal-header button')?.click();
              await waitForGone('[data-testid="local-tool-modal"]', 3000);
            }
            document.querySelector('[data-testid="nav-contacts"]')?.click();
            await waitFor('.page-header');
            [...document.querySelectorAll('.page-actions button')].find((button) => /new contact/i.test(button.textContent || ''))?.click();
            const contactModal = Boolean(await waitFor('[data-testid="new-contact-modal"]'));
            document.querySelector('[data-testid="new-contact-modal"] .modal-header button')?.click();
            await waitForGone('[data-testid="new-contact-modal"]', 3000);
            document.querySelector('[data-testid="nav-emails"]')?.click();
            await waitFor('.page-header');
            document.querySelector('.page-actions .primary')?.click();
            const campaignModal = Boolean(await waitFor('[data-testid="campaign-modal"]'));
            document.querySelector('[data-testid="campaign-modal"] .modal-header button')?.click();
            await waitForGone('[data-testid="campaign-modal"]', 3000);
            document.querySelector('[data-testid="nav-packs"]')?.click();
            await waitFor('.page-header');
            document.querySelector('.page-actions .primary')?.click();
            const packModal = Boolean(await waitFor('[data-testid="pack-modal"]'));
            document.querySelector('[data-testid="pack-modal"] .modal-header button')?.click();
            await waitForGone('[data-testid="pack-modal"]', 3000);
            document.querySelector('[data-testid="nav-youtube"]')?.click();
            await waitFor('[data-testid="review-youtube-upload"]');
            document.querySelector('[data-testid="review-youtube-upload"]')?.click();
            const youtubeValidation = Boolean(await waitForText('.connection-error', /select an imported audio file/i, 3000));
            document.querySelector('[data-testid="nav-settings"]')?.click();
            const connectSpotify = await waitFor('[data-testid="connect-Spotify"]');
            connectSpotify?.click();
            const connectionModal = Boolean(await waitFor('[data-testid="connection-modal"]'));
            const connectionCopy = document.querySelector('[data-testid="connection-modal"]')?.textContent || '';
            const developerFieldsAbsent = !/Client ID|Client Secret|Redirect URI|Developer Dashboard|Google Cloud/i.test(connectionCopy);
            document.querySelector('[data-testid="connection-modal"] .modal-header button')?.click();
            await waitForGone('[data-testid="connection-modal"]', 5000);
            const aiSessionConnectors = ['Codex', 'Claude', 'Gemini'].filter((service) => document.querySelector('[data-testid="connection-' + service + '"]')).length;
            let codexSessionConnected = -1;
            if (${codexAuthSmoke}) {
              document.querySelector('[data-testid="connect-Codex"]')?.click();
              await waitFor('[data-testid="connection-modal"]');
              document.querySelector('[data-testid="connection-modal"] .modal-footer .primary')?.click();
              codexSessionConnected = await waitForGone('[data-testid="connect-Codex"]') ? 1 : 0;
            }
            if (${spotifyCatalogSmoke}) {
              const beforeFinder = await window.scoutline.getState();
              await window.scoutline.saveState({ ...beforeFinder, finderQueue: [] });
              await pause(250);
            }
            document.querySelector('[data-testid="nav-finder"]')?.click();
            await waitFor('.finder-page');
            const fictionalPlaceholderAbsent = !document.body.textContent?.includes('Luna Harbor');
            let spotifySearchResults = -1;
            let spotifySimilarResults = -1;
            let finderUiArtist = '';
            let finderUiError = '';
            let emailFilterPreserved = -1;
            let emailFilterRecovered = -1;
            let criteriaChangeRecovered = -1;
            let instagramFilterVerified = -1;
            let finderButtonRecovered = -1;
            let emailFilterError = '';
            if (${spotifyCatalogSmoke}) {
              const input = document.querySelector('.spotify-search input');
              const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              inputSetter?.call(input, 'Snoop Dogg');
              input?.dispatchEvent(new Event('input', { bubbles: true }));
              const firstResult = await waitFor('.spotify-results button', 30000);
              spotifySearchResults = document.querySelectorAll('.spotify-results button').length;
              firstResult?.click();
              const instagramMaximum = document.querySelector('[data-testid="maximum-instagram-followers"]');
              const followerSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              followerSetter?.call(instagramMaximum, ${JSON.stringify(finderInstagramSmoke ? '5000' : '100000')});
              instagramMaximum?.dispatchEvent(new Event('input', { bubbles: true }));
              const listenerMaximum = document.querySelector('[data-testid="maximum-listeners"]');
              const listenerSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              listenerSetter?.call(listenerMaximum, ${JSON.stringify(finderToggleSmoke ? '250000' : '25000')});
              listenerMaximum?.dispatchEvent(new Event('input', { bubbles: true }));
              await pause(100);
              const findButton = await waitForEnabled('.finder-submit button', 5000);
              findButton?.click();
              const finderOutcome = await Promise.race([
                waitFor('.artist-card .artist-hero h2', 150000).then((element) => ({ kind: 'artist', element })),
                waitFor('.finder-page .connection-error', 150000).then((element) => ({ kind: 'error', element })),
              ]);
              finderUiArtist = finderOutcome.kind === 'artist' ? finderOutcome.element?.textContent || '' : '';
              finderUiError = finderOutcome.kind === 'error' ? finderOutcome.element?.textContent || '' : '';
              spotifySimilarResults = finderUiArtist ? 1 : 0;
              await pause(350);
              const finderState = await window.scoutline.getState();
              instagramFilterVerified = ${finderInstagramSmoke} ? (finderState.finderQueue.length > 0 && finderState.finderQueue.every((artist) => artist.instagramFollowers >= 0 && artist.instagramFollowers <= 5000) ? 1 : 0) : -1;
              const recoveredButton = document.querySelector('[data-testid="find-artists"]');
              finderButtonRecovered = recoveredButton && !recoveredButton.disabled && /Find artists/i.test(recoveredButton.textContent || '') ? 1 : 0;
              if (${finderToggleSmoke} && finderUiArtist) {
                const emailToggle = document.querySelector('[data-testid="public-email-toggle"]');
                emailToggle?.click();
                await pause(100);
                document.querySelector('[data-testid="find-artists"]')?.click();
                const emailError = await waitForText('.finder-page .connection-error', /Connect Instagram|No verified public emails/i, 150000);
                emailFilterError = emailError?.textContent || '';
                emailFilterPreserved = document.querySelector('.artist-card .artist-hero h2')?.textContent === finderUiArtist ? 1 : 0;

                emailToggle?.click();
                await pause(100);
                document.querySelector('[data-testid="find-artists"]')?.click();
                await pause(100);
                await waitForEnabled('[data-testid="find-artists"]', 150000);
                await waitForGone('.finder-page .connection-error', 5000);
                emailFilterRecovered = document.querySelector('.artist-card .artist-hero h2')?.textContent ? 1 : 0;

                const maximumInput = document.querySelector('[data-testid="maximum-listeners"]');
                const numberSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                numberSetter?.call(maximumInput, '200000');
                maximumInput?.dispatchEvent(new Event('input', { bubbles: true }));
                await pause(100);
                document.querySelector('[data-testid="find-artists"]')?.click();
                await pause(100);
                await waitForEnabled('[data-testid="find-artists"]', 150000);
                criteriaChangeRecovered = document.querySelector('.artist-card .artist-hero h2')?.textContent && !document.querySelector('.finder-page .connection-error') ? 1 : 0;
              }
            }
            document.querySelector('[data-testid="nav-home"]')?.click();
            await waitFor('.quick-actions');
            [...document.querySelectorAll('.quick-actions button')].find((button) => /Import CSV/i.test(button.textContent || ''))?.click();
            const overviewImport = Boolean(await waitFor('.import-modal'));
            document.querySelector('.import-modal .modal-header button')?.click();
            await waitForGone('.import-modal', 3000);

            const pollState = async (predicate, timeout = 8000) => {
              const deadline = Date.now() + timeout;
              let current;
              while (Date.now() < deadline) {
                current = await window.scoutline.getState();
                if (predicate(current)) return current;
                await pause(100);
              }
              return current;
            };
            const baseState = await window.scoutline.getState();
            const smokeArtist = { id: 'smoke-artist', name: 'Verified Artist', status: 'Prospect', email: 'artist@example.test', instagramHandle: '@verifiedartist', monthlyListeners: 12000, instagramFollowers: 900, genres: ['Hip Hop'], latestRelease: 'Real Release', confidence: 'verified', confidenceScore: 100, evidence: [], source: 'Smoke fixture', createdAt: new Date().toISOString(), contactedCount: 0, lists: [] };
            const smokeCampaign = { id: 'smoke-campaign', name: 'Workflow smoke', channel: 'Email', status: 'Draft', sent: 0, queued: 0, replied: 0, failed: 0, pacingSeconds: 0, template: 'Hey <artist name>, I heard <release name>.', subject: 'For <artist name>', artistIds: [smokeArtist.id], createdAt: new Date().toISOString() };
            await window.scoutline.saveState({ ...baseState, artists: [smokeArtist], campaigns: [smokeCampaign], conversations: [], activities: [], automations: [] });
            await window.scoutline.startCampaign(smokeCampaign.id);
            const campaignState = await pollState((current) => current.campaigns[0]?.status === 'Complete');
            const sentMessage = campaignState?.conversations[0]?.messages[0]?.body || '';
            const workflowCampaign = campaignState?.campaigns[0]?.sent === 1 && campaignState?.campaigns[0]?.failed === 0 && /Verified Artist/.test(sentMessage) && /Real Release/.test(sentMessage);

            const smokeAutomation = { id: 'smoke-automation', name: 'Status workflow smoke', trigger: 'New prospect is saved', action: 'Change contact status', schedule: 'Immediately after audit', targetStatus: 'Connection', enabled: true };
            const beforeAutomation = await window.scoutline.getState();
            await window.scoutline.saveState({ ...beforeAutomation, artists: beforeAutomation.artists.map((artist) => ({ ...artist, status: 'Prospect' })), automations: [smokeAutomation] });
            await window.scoutline.runAutomation(smokeAutomation.id);
            const automationState = await pollState((current) => current.artists[0]?.status === 'Connection' && Boolean(current.automations[0]?.lastRun));
            const workflowAutomation = automationState?.artists[0]?.status === 'Connection' && Boolean(automationState?.automations[0]?.lastRun) && !automationState?.automations[0]?.lastError;
            resolve({ title: document.title, brand, navigationItems, automationModal, workingTools, functionalTools, beatNamesGenerated, agreementPdfExported, contactModal, campaignModal, packModal, youtubeValidation, connectionModal, developerFieldsAbsent, aiSessionConnectors, codexSessionConnected, fictionalPlaceholderAbsent, spotifySearchResults, spotifySimilarResults, finderUiArtist, finderUiError, emailFilterPreserved, emailFilterRecovered, criteriaChangeRecovered, instagramFilterVerified, finderButtonRecovered, emailFilterError, overviewImport, workflowCampaign, workflowAutomation });
          } else {
            setTimeout(check, 50);
          }
        };
        await check();
      })`);
      const aiDiscoveryCalls = aiDiscoveryGenerationCount - aiDiscoveryCountAtSmokeStart;
      const finalResult = { ...result, aiDiscoveryCalls };
      if (result.brand === 'Scoutline' && result.navigationItems >= 10 && result.automationModal && result.workingTools === 5 && result.functionalTools === 5 && result.beatNamesGenerated && (!agreementPdfSmoke || result.agreementPdfExported === 1) && result.contactModal && result.campaignModal && result.packModal && result.youtubeValidation && result.connectionModal && result.developerFieldsAbsent && result.aiSessionConnectors === 3 && (!codexAuthSmoke || result.codexSessionConnected === 1) && result.fictionalPlaceholderAbsent && result.overviewImport && result.workflowCampaign && result.workflowAutomation && (!spotifyCatalogSmoke || (result.spotifySearchResults > 0 && result.spotifySimilarResults > 0 && result.finderButtonRecovered === 1)) && (!finderInstagramSmoke || result.instagramFilterVerified === 1) && (!finderToggleSmoke || (result.emailFilterPreserved === 1 && result.emailFilterRecovered === 1 && result.criteriaChangeRecovered === 1 && aiDiscoveryCalls <= 2))) {
        console.log(`SCOUTLINE_SMOKE_OK ${JSON.stringify(finalResult)}`);
        app.quit();
      } else {
        console.error(`SCOUTLINE_SMOKE_FAILED ${JSON.stringify(finalResult)}`);
        app.exit(1);
      }
    });
    window.webContents.once('did-fail-load', (_event, code, description) => {
      console.error(`SCOUTLINE_SMOKE_FAILED ${code} ${description}`);
      app.exit(1);
    });
  }

  if (realFinderTest) {
    window.webContents.once('did-finish-load', async () => {
      const startedAt = Date.now();
      const finderArgument = (name: string, fallback: string) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
      const seedId = finderArgument('finder-seed-id', '7hJcb9fa4alzcOq3EaNPoG');
      const seedName = decodeURIComponent(finderArgument('finder-seed-name', 'Snoop%20Dogg'));
      const minimumListeners = Number(finderArgument('finder-minimum-listeners', '10000'));
      const maximumListeners = Number(finderArgument('finder-maximum-listeners', '25000'));
      const minimumInstagramFollowers = Number(finderArgument('finder-minimum-instagram', '0'));
      const maximumInstagramFollowers = Number(finderArgument('finder-maximum-instagram', String(Number.MAX_SAFE_INTEGER)));
      const publicEmailRequired = finderArgument('finder-public-email', 'false') === 'true';
      try {
        const profileId = finderArgument('finder-profile-id', '');
        if (profileId) {
          const profile = await renderedSpotifyGraphArtist(profileId);
          console.log(`SCOUTLINE_REAL_PROFILE_OK ${JSON.stringify({ elapsedMilliseconds: Date.now() - startedAt, name: profile.name, monthlyListeners: profile.monthlyListeners, instagramUrl: profile.instagramUrl })}`);
          app.quit();
          return;
        }
        const runFinder = (emailRequired: boolean) => window.webContents.executeJavaScript(`window.scoutline.spotifyFindSimilar(${JSON.stringify(seedId)}, { seedName: ${JSON.stringify(seedName)}, minimumListeners: ${minimumListeners}, maximumListeners: ${maximumListeners}, minimumInstagramFollowers: ${minimumInstagramFollowers}, maximumInstagramFollowers: ${maximumInstagramFollowers}, publicEmailRequired: ${emailRequired} })`) as Promise<Artist[]>;
        const artists = await runFinder(publicEmailRequired);
        console.log(`SCOUTLINE_REAL_FINDER_OK ${JSON.stringify({ elapsedMilliseconds: Date.now() - startedAt, seedName, minimumListeners, maximumListeners, minimumInstagramFollowers, maximumInstagramFollowers, publicEmailRequired, artists: artists.map((artist) => ({ name: artist.name, monthlyListeners: artist.monthlyListeners, instagramFollowers: artist.instagramFollowers, instagramUrl: artist.instagramUrl, hasPublicEmail: Boolean(artist.email) })) })}`);
        if (process.argv.includes('--finder-toggle-recovery')) {
          let emailOutcome: { returned: number } | { error: string };
          try { emailOutcome = { returned: (await runFinder(true)).length }; }
          catch (error) { emailOutcome = { error: error instanceof Error ? error.message : String(error) }; }
          const recovered = await runFinder(false);
          if (!recovered.length) throw new Error('Finder did not recover after the public-email filter was turned off.');
          console.log(`SCOUTLINE_REAL_FINDER_TOGGLE_RECOVERY_OK ${JSON.stringify({ emailOutcome, recovered: recovered.length, elapsedMilliseconds: Date.now() - startedAt })}`);
        }
        app.quit();
      } catch (error) {
        console.error(`SCOUTLINE_REAL_FINDER_FAILED ${JSON.stringify({ elapsedMilliseconds: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) })}`);
        app.exit(1);
      }
    });
    window.webContents.once('did-fail-load', (_event, code, description) => {
      console.error(`SCOUTLINE_REAL_FINDER_FAILED ${code} ${description}`);
      app.exit(1);
    });
  }

  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
  if (!app.isPackaged && !realFinderTest && !smokeTest) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(path.join(dirname, '../../dist/index.html'));
  }
}

app.whenReady().then(() => {
  connectDatabase();
  database.prepare("UPDATE background_jobs SET status = 'pending', updated_at = ? WHERE status = 'running'").run(new Date().toISOString());
  setInterval(() => void runDueBackgroundJob(), 1_000);

  ipcMain.handle('state:get', () => readAppState());

  ipcMain.handle('state:save', (_event, state: AppState) => {
    const previous = readAppState();
    writeAppState(state, 'state_saved');
    scheduleAutomationEvents(previous, state);
  });

  ipcMain.handle('files:select', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('files:info', (_event, paths: string[]) => paths.flatMap((filePath) => {
    try { return [{ path: filePath, size: statSync(filePath).size }]; }
    catch { return []; }
  }));
  ipcMain.handle('files:preview', (_event, filePath: string) => {
    if (!existsSync(filePath)) throw new Error('The selected file no longer exists.');
    const extension = path.extname(filePath).toLowerCase();
    const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' } as Record<string, string>)[extension];
    if (!mime) throw new Error('This file type cannot be previewed.');
    return `data:${mime};base64,${readFileSync(filePath).toString('base64')}`;
  });

  ipcMain.handle('external:open', (_event, url: string) => shell.openExternal(url));
  ipcMain.handle('path:open', (_event, filePath: string) => shell.openPath(filePath));
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    databasePath: path.join(app.getPath('userData'), 'scoutline.sqlite'),
  }));

  ipcMain.handle('connections:get', () => (['Instagram', 'Gmail', 'Spotify', 'YouTube', 'Codex', 'Claude', 'Gemini', 'Chartmetric', 'Last.fm'] as ConnectionService[]).map(connectionStatus));
  ipcMain.handle('connections:connect', async (_event, service: ConnectionService, credential?: string) => {
    if (service === 'Codex') return connectCodexService();
    if (service === 'Chartmetric') {
      if (!getConnection('Codex')) await connectCodexService();
      return connectChartmetricService();
    }
    if (service === 'Last.fm') return connectLastFmService(credential);
    if (['Gmail', 'YouTube', 'Claude', 'Gemini'].includes(service)) return connectGoogleChromeService(service);
    return connectBrowserService(service);
  });
  ipcMain.handle('connections:disconnect', async (_event, service: ConnectionService) => {
    database.prepare('DELETE FROM connections WHERE service = ?').run(service);
    if (service === 'Instagram') instagramProfileCache.clear();
    if (service === 'Chartmetric') await runCodexCommand(['mcp', 'logout', 'chartmetric'], 15_000).catch(() => undefined);
    if (['Instagram', 'Spotify'].includes(service)) await session.fromPartition(browserConnection(service).partition).clearStorageData();
  });

  ipcMain.handle('outreach:send', async (_event, request: { channel: 'Instagram' | 'Email'; recipient: string; body: string; subject?: string; attachments?: string[] }) => {
    if (!request.recipient.trim() || !request.body.trim()) throw new Error('Recipient and message are required.');
    if (request.channel === 'Instagram') await sendInstagramDm(request.recipient, request.body);
    else await sendGmailEmail(request.recipient, request.subject?.trim() || 'Quick note', request.body, request.attachments || []);
    return { sentAt: new Date().toISOString() };
  });

  ipcMain.handle('inbox:sync', (_event, contacts: InboxContact[]) => syncConnectedInboxes(contacts));
  ipcMain.handle('campaign:start', (_event, campaignId: string) => startCampaign(campaignId));
  ipcMain.handle('campaign:pause', (_event, campaignId: string) => pauseCampaign(campaignId));
  ipcMain.handle('automation:run', (_event, automationId: string) => runAutomationNow(automationId));
  ipcMain.handle('ai:run', (_event, request: AiGenerationRequest) => runAiGeneration(request));
  ipcMain.handle('agreement:save-pdf', (_event, request: AgreementPdfRequest) => saveAgreementPdf(request));
  ipcMain.handle('youtube:upload', (_event, request: YouTubeUploadRequest) => uploadYouTubeVideo(request));

  ipcMain.handle('spotify:search-artists', async (_event, query: string): Promise<SpotifyArtistResult[]> => {
    if (!query.trim()) return [];
    return spotifySearchArtists(query.trim());
  });

  ipcMain.handle('spotify:find-similar', async (_event, artistId: string, requested?: SpotifyFindCriteria): Promise<Artist[]> => {
    const criteria: SpotifyFindCriteria = requested || { minimumListeners: 0, maximumListeners: Number.MAX_SAFE_INTEGER, publicEmailRequired: false };
    const discoveryAlgorithmVersion = 'v16-free-provider-genre-depth';
    const minimumInstagramFollowers = criteria.minimumInstagramFollowers ?? 0;
    const maximumInstagramFollowers = criteria.maximumInstagramFollowers ?? Number.MAX_SAFE_INTEGER;
    const instagramFilterEnabled = instagramFilterIsActive(minimumInstagramFollowers, maximumInstagramFollowers);
    const finderInstagramSmoke = process.argv.includes('--finder-instagram-smoke');
    const normalizedLocation = criteria.popularIn?.trim().toLowerCase() || '';
    const provider = getConnection('Chartmetric') ? 'chartmetric' : 'free';
    const cacheKey = `${discoveryAlgorithmVersion}:${provider}:${artistId}:${criteria.minimumListeners}:${criteria.maximumListeners}:${normalizedLocation}`;
    const cached = spotifyDiscoveryCache.get(cacheKey);
    const stored = database.prepare('SELECT payload, updated_at FROM spotify_discovery_cache WHERE cache_key = ?').get(cacheKey) as { payload: string; updated_at: number } | undefined;
    const storedArtists = stored ? (JSON.parse(stored.payload) as SpotifyWorkerArtist[]).map((artist) => ({ ...artist, instagramUrl: validSpotifyArtistInstagramUrl(artist.instagramUrl) })) : [];
    const storedFresh = Boolean(stored && Date.now() - stored.updated_at < 6 * 60 * 60_000 && storedArtists.length);
    let discovered: SpotifyWorkerArtist[] = [];
    let discoverySource = provider === 'chartmetric' ? 'Chartmetric' : 'Free sources';
    if (cached && cached.expiresAt > Date.now()) {
      discovered = cached.artists;
    } else if (storedFresh) {
      discovered = storedArtists;
      spotifyDiscoveryCache.set(cacheKey, { artists: discovered, expiresAt: Date.now() + 30 * 60_000 });
    } else {
      let chartmetricError: unknown;
      if (provider === 'chartmetric') {
        try {
          discovered = await runChartmetricDiscovery(criteria);
        } catch (error) { chartmetricError = error; }
      }
      if (!discovered.length) {
        discovered = await runFreeProviderDiscovery(artistId, criteria);
        discoverySource = chartmetricError ? 'Free sources (Chartmetric fallback)' : 'Free sources';
      }
      if (discovered.length) {
        spotifyDiscoveryCache.set(cacheKey, { artists: discovered, expiresAt: Date.now() + 30 * 60_000 });
        database.prepare(`
          INSERT INTO spotify_discovery_cache (cache_key, payload, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
        `).run(cacheKey, JSON.stringify(discovered), Date.now());
      }
    }
    const listenerMatches = discovered.filter((artist) => artist.monthlyListeners >= criteria.minimumListeners && artist.monthlyListeners <= criteria.maximumListeners && (!normalizedLocation || artist.popularLocations?.some((location) => location.toLowerCase().includes(normalizedLocation))));
    if (!listenerMatches.length) throw new Error(`${discoverySource} found similar artists, but none matched ${criteria.minimumListeners.toLocaleString()}–${criteria.maximumListeners.toLocaleString()} Spotify monthly listeners.`);
    type HydratedCandidate = { artist: Artist; instagramFollowers?: number; sessionExpired: boolean };
    const hydrated: HydratedCandidate[] = [];
    const candidatesToCheck = listenerMatches.slice(0, criteria.publicEmailRequired || instagramFilterEnabled ? 30 : 12);
    const enrichmentStartedAt = Date.now();
    for (let offset = 0; offset < candidatesToCheck.length; offset += 5) {
      const batch = candidatesToCheck.slice(offset, offset + 5);
      const results = await Promise.all(batch.map(async (candidate, index): Promise<HydratedCandidate> => {
        const fixtureIndex = offset + index;
        const profileCandidate = candidate;
        const instagram: InstagramProfileDetails = finderInstagramSmoke
          ? { followers: 500 + ((fixtureIndex * 977) % 4_300), email: fixtureIndex % 2 === 0 ? `finder-${fixtureIndex}@example.test` : undefined, profileFound: true }
          : profileCandidate.instagramFollowers !== undefined && !criteria.publicEmailRequired
            ? { followers: profileCandidate.instagramFollowers, profileFound: true }
          : criteria.publicEmailRequired || instagramFilterEnabled
            ? await instagramProfileDetails(profileCandidate.instagramUrl, profileCandidate.websiteUrls, criteria.publicEmailRequired)
            : {};
        const email = finderInstagramSmoke ? undefined : profileCandidate.email || instagram.email;
        const verifiedInstagramFollowers = profileCandidate.instagramFollowers ?? instagram.followers;
        const instagramHandle = profileCandidate.instagramUrl ? `@${profileCandidate.instagramUrl.split('/').filter(Boolean).at(-1)}` : undefined;
        return {
          instagramFollowers: verifiedInstagramFollowers,
          sessionExpired: Boolean(instagram.sessionExpired),
          artist: {
            id: `spotify-${profileCandidate.id}`, name: profileCandidate.name, image: profileCandidate.image, status: 'Prospect', spotifyId: profileCandidate.id,
            chartmetricId: profileCandidate.chartmetricId,
            spotifyUrl: profileCandidate.spotifyUrl, spotifyFollowers: 0, spotifyPopularity: 0, monthlyListeners: profileCandidate.monthlyListeners,
            instagramFollowers: verifiedInstagramFollowers ?? 0, instagramUrl: profileCandidate.instagramUrl, instagramHandle, email, genres: profileCandidate.genres || [], latestRelease: profileCandidate.latestRelease,
            location: profileCandidate.popularLocations?.at(0), popularLocations: profileCandidate.popularLocations,
            latestReleaseType: profileCandidate.latestRelease ? 'release' : undefined, latestReleaseSpotifyId: profileCandidate.latestReleaseSpotifyId,
            latestReleaseImage: profileCandidate.latestReleaseImage, confidence: profileCandidate.instagramUrl ? 'verified' : 'unverified',
            confidenceScore: profileCandidate.instagramUrl ? 100 : 0,
            evidence: [
              ...(profileCandidate.instagramUrl ? [{ label: 'Instagram', source: profileCandidate.dataSource === 'Chartmetric' ? 'Chartmetric + Spotify identity' : 'Spotify artist profile', value: instagramHandle || profileCandidate.instagramUrl, strength: 'decisive' as const }] : []),
              ...(email ? [{ label: 'Public email', source: profileCandidate.email ? 'Spotify artist profile' : 'Public artist profile', value: email, strength: 'supporting' as const }] : []),
            ],
            source: profileCandidate.dataSource || discoverySource, createdAt: new Date().toISOString(), lastVerifiedAt: profileCandidate.instagramUrl ? new Date().toISOString() : undefined,
            contactedCount: 0, lists: [],
          },
        };
      }));
      hydrated.push(...results);
      const ready = hydrated.filter(({ artist, instagramFollowers }) => (!instagramFilterEnabled || (instagramFollowers !== undefined && instagramFollowers >= minimumInstagramFollowers && instagramFollowers <= maximumInstagramFollowers)) && (!criteria.publicEmailRequired || Boolean(artist.email))).length;
      if (ready >= 5 || Date.now() - enrichmentStartedAt >= 35_000) break;
    }
    const followerSummary = summarizeInstagramFilter(hydrated.map((candidate) => candidate.instagramFollowers), minimumInstagramFollowers, maximumInstagramFollowers);
    if (process.argv.includes('--real-finder-test')) console.log(`SCOUTLINE_REAL_INSTAGRAM_COUNTS ${JSON.stringify(hydrated.map(({ artist, instagramFollowers, sessionExpired }) => ({ name: artist.name, instagramHandle: artist.instagramHandle, instagramFollowers, sessionExpired })))}`);
    if (instagramFilterEnabled && followerSummary.verified === 0) {
      if (hydrated.some((candidate) => candidate.sessionExpired)) throw new Error('Your Instagram session expired while follower counts were being verified. Reconnect Instagram in Settings, then retry the same search.');
      throw new Error('Instagram follower counts could not be verified from the artists’ public profiles. Connect Instagram for authenticated verification or widen the follower range.');
    }
    const followerQualified = hydrated.filter(({ instagramFollowers }) => !instagramFilterEnabled || (instagramFollowers !== undefined && instagramFollowers >= minimumInstagramFollowers && instagramFollowers <= maximumInstagramFollowers));
    if (instagramFilterEnabled && !followerQualified.length) throw new Error(`No verified artists in this result set matched ${minimumInstagramFollowers.toLocaleString()}–${maximumInstagramFollowers.toLocaleString()} Instagram followers. Your existing results were kept.`);
    const matches = followerQualified.filter(({ artist }) => !criteria.publicEmailRequired || Boolean(artist.email)).map(({ artist }) => artist).slice(0, 10);
    if (criteria.publicEmailRequired && !matches.length) throw new Error('No verified public emails were found among the artists matching your other filters. Your existing results were kept.');
    if (process.argv.includes('--spotify-catalog-smoke')) console.log(`SCOUTLINE_FINDER_RESULT ${JSON.stringify({ discovered: discovered.length, listenerMatches: listenerMatches.length, returned: matches.length, minimum: matches.at(0)?.monthlyListeners || 0, source: discoverySource, names: matches.map((artist) => artist.name) })}`);
    return matches;
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  database?.close();
  if (process.platform !== 'darwin') app.quit();
});
