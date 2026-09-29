import type { AppState, ScoutlineAPI } from '../src/shared/types.js';

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const api: ScoutlineAPI = {
  getState: () => ipcRenderer.invoke('state:get'),
  saveState: (state: AppState) => ipcRenderer.invoke('state:save', state),
  selectFiles: () => ipcRenderer.invoke('files:select'),
  fileInfo: (paths) => ipcRenderer.invoke('files:info', paths),
  filePreview: (path) => ipcRenderer.invoke('files:preview', path),
  openExternal: (url: string) => ipcRenderer.invoke('external:open', url),
  openPath: (path: string) => ipcRenderer.invoke('path:open', path),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getConnections: () => ipcRenderer.invoke('connections:get'),
  connectService: (service, credential) => ipcRenderer.invoke('connections:connect', service, credential),
  disconnectService: (service) => ipcRenderer.invoke('connections:disconnect', service),
  spotifySearchArtists: (query) => ipcRenderer.invoke('spotify:search-artists', query),
  spotifyFindSimilar: (artistId, criteria) => ipcRenderer.invoke('spotify:find-similar', artistId, criteria),
  sendOutreach: (request) => ipcRenderer.invoke('outreach:send', request),
  syncInbox: (contacts) => ipcRenderer.invoke('inbox:sync', contacts),
  startCampaign: (campaignId) => ipcRenderer.invoke('campaign:start', campaignId),
  pauseCampaign: (campaignId) => ipcRenderer.invoke('campaign:pause', campaignId),
  runAutomation: (automationId) => ipcRenderer.invoke('automation:run', automationId),
  uploadYouTube: (request) => ipcRenderer.invoke('youtube:upload', request),
  saveAgreementPdf: (request) => ipcRenderer.invoke('agreement:save-pdf', request),
  runAi: (request) => ipcRenderer.invoke('ai:run', request),
  onStateChanged: (listener) => {
    const handler = (_event: unknown, state: AppState) => listener(state);
    ipcRenderer.on('state:changed', handler);
    return () => ipcRenderer.removeListener('state:changed', handler);
  },
};

contextBridge.exposeInMainWorld('scoutline', api);
