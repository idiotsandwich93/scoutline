export type NavKey =
  | 'home'
  | 'finder'
  | 'contacts'
  | 'inbox'
  | 'emails'
  | 'files'
  | 'packs'
  | 'automations'
  | 'youtube'
  | 'tools'
  | 'settings';

export type ContactStatus = 'Prospect' | 'Connection' | 'Inactive';
export type Confidence = 'verified' | 'high' | 'review' | 'unverified';

export interface Evidence {
  label: string;
  source: string;
  value: string;
  strength: 'decisive' | 'supporting' | 'weak';
}

export interface Artist {
  id: string;
  name: string;
  image?: string;
  status: ContactStatus;
  spotifyId?: string;
  chartmetricId?: string;
  viberateId?: string;
  spotifyUrl?: string;
  spotifyFollowers?: number;
  spotifyPopularity?: number;
  latestReleaseSpotifyId?: string;
  latestReleaseImage?: string;
  instagramHandle?: string;
  instagramUrl?: string;
  website?: string;
  email?: string;
  emailType?: string;
  monthlyListeners: number;
  instagramFollowers: number;
  location?: string;
  popularLocations?: string[];
  genres: string[];
  label?: string;
  latestRelease?: string;
  latestReleaseType?: string;
  latestReleaseDate?: string;
  confidence: Confidence;
  confidenceScore: number;
  evidence: Evidence[];
  source: string;
  createdAt: string;
  lastVerifiedAt?: string;
  lastContactedAt?: string;
  contactedCount: number;
  lists: string[];
  notes?: string;
}

export interface Campaign {
  id: string;
  name: string;
  channel: 'Instagram' | 'Email';
  status: 'Draft' | 'Active' | 'Paused' | 'Complete';
  sent: number;
  queued: number;
  replied: number;
  failed: number;
  pacingSeconds: number;
  template: string;
  subject?: string;
  artistIds?: string[];
  packId?: string;
  createdAt: string;
}

export interface Asset {
  id: string;
  name: string;
  kind: 'Audio' | 'Artwork' | 'Document';
  tags: string[];
  size: string;
  path?: string;
  createdAt: string;
}

export interface Pack {
  id: string;
  name: string;
  assetIds: string[];
  tags: string[];
  timesSent: number;
}

export interface Automation {
  id: string;
  name: string;
  trigger: string;
  action: string;
  schedule: string;
  subject?: string;
  message?: string;
  packId?: string;
  targetStatus?: ContactStatus;
  enabled: boolean;
  lastRun?: string;
  lastError?: string;
}

export interface Activity {
  id: string;
  artistId?: string;
  type: string;
  detail: string;
  createdAt: string;
}

export interface ConversationMessage {
  id: string;
  direction: 'incoming' | 'outgoing';
  body: string;
  createdAt: string;
  read: boolean;
}

export interface Conversation {
  id: string;
  artistId: string;
  channel: 'Instagram' | 'Email';
  subject?: string;
  messages: ConversationMessage[];
  updatedAt: string;
}

export interface AppSettings {
  aiProvider: 'Codex' | 'Claude' | 'Gemini';
  aiModel: string;
  aiCallsThisMonth: number;
  estimatedTokens: number;
  automaticSending: boolean;
  requireReviewBelow: number;
}

export interface AppState {
  stateVersion: number;
  artists: Artist[];
  finderQueue: Artist[];
  campaigns: Campaign[];
  assets: Asset[];
  packs: Pack[];
  automations: Automation[];
  conversations: Conversation[];
  activities: Activity[];
  settings: AppSettings;
}

export interface ScoutlineAPI {
  getState(): Promise<AppState>;
  saveState(state: AppState): Promise<void>;
  selectFiles(): Promise<string[]>;
  fileInfo(paths: string[]): Promise<Array<{ path: string; size: number }>>;
  filePreview(path: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<string>;
  getAppInfo(): Promise<{ version: string; databasePath: string }>;
  getConnections(): Promise<ConnectionStatus[]>;
  connectService(service: ConnectionService, credential?: string): Promise<ConnectionStatus>;
  disconnectService(service: ConnectionService): Promise<void>;
  spotifySearchArtists(query: string): Promise<SpotifyArtistResult[]>;
  spotifyFindSimilar(artistId: string, criteria?: SpotifyFindCriteria): Promise<Artist[]>;
  sendOutreach(request: { channel: 'Instagram' | 'Email'; recipient: string; body: string; subject?: string; attachments?: string[] }): Promise<{ sentAt: string }>;
  syncInbox(contacts: InboxContact[]): Promise<InboxSyncResult>;
  startCampaign(campaignId: string): Promise<void>;
  pauseCampaign(campaignId: string): Promise<void>;
  runAutomation(automationId: string): Promise<void>;
  uploadYouTube(request: YouTubeUploadRequest): Promise<{ uploadedAt: string; videoUrl?: string }>;
  saveAgreementPdf(request: AgreementPdfRequest): Promise<{ canceled: boolean; path?: string }>;
  runAi(request: AiGenerationRequest): Promise<{ text: string; provider: string }>;
  onStateChanged(listener: (state: AppState) => void): () => void;
}

export interface InboxContact {
  artistId: string;
  email?: string;
  instagramHandle?: string;
}

export interface SyncedInboxMessage {
  id: string;
  artistId: string;
  channel: 'Instagram' | 'Email';
  body: string;
  createdAt: string;
  subject?: string;
}

export interface InboxSyncResult {
  messages: SyncedInboxMessage[];
  syncedChannels: Array<'Instagram' | 'Email'>;
  warnings: string[];
}

export interface YouTubeUploadRequest {
  audioPath: string;
  artworkPath: string;
  title: string;
  description: string;
  tags: string[];
  visibility: 'Public' | 'Unlisted' | 'Private';
  publishAt?: string;
}

export interface AgreementPdfRequest {
  title: string;
  agreement: string;
}

export interface AiGenerationRequest {
  provider: 'Codex' | 'Claude' | 'Gemini';
  task: 'personalize_outreach' | 'audit_message' | 'draft_reply' | 'discover_artists' | 'beat_names';
  prompt: string;
}

export type ConnectionService = 'Instagram' | 'Gmail' | 'Spotify' | 'YouTube' | 'Codex' | 'Claude' | 'Gemini' | 'Chartmetric' | 'Last.fm';

export interface ConnectionStatus {
  service: ConnectionService;
  connected: boolean;
  accountLabel?: string;
  detail?: string;
}

export interface SpotifyArtistResult {
  id: string;
  name: string;
  image?: string;
  spotifyUrl: string;
  followers: number;
  popularity: number;
  genres: string[];
}

export interface SpotifyFindCriteria {
  seedName?: string;
  minimumListeners: number;
  maximumListeners: number;
  minimumInstagramFollowers?: number;
  maximumInstagramFollowers?: number;
  popularIn?: string;
  publicEmailRequired: boolean;
}
