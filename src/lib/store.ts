import { initialState } from '../data/seed';
import type { AppState } from '../shared/types';

const fallbackKey = 'scoutline-app-state-v1';

export async function loadState(): Promise<AppState> {
  if (window.scoutline) {
    const saved = await window.scoutline.getState();
    if (saved) return migrateState(saved);
    await window.scoutline.saveState(initialState);
    return initialState;
  }

  const saved = localStorage.getItem(fallbackKey);
  if (!saved) return initialState;
  try {
    return migrateState(JSON.parse(saved) as AppState);
  } catch {
    return initialState;
  }
}

function migrateState(saved: AppState): AppState {
  if (saved.stateVersion === initialState.stateVersion) return saved;
  return {
    ...initialState,
    artists: (saved.artists || []).filter((artist) => !/Demo/i.test(artist.source) && !artist.email?.endsWith('.example')),
    campaigns: (saved.campaigns || []).filter((campaign) => campaign.id !== 'campaign-release-dm'),
    assets: (saved.assets || []).filter((asset) => !['asset-1', 'asset-2', 'asset-3'].includes(asset.id)),
    packs: (saved.packs || []).filter((pack) => pack.id !== 'pack-1'),
    automations: saved.automations || initialState.automations,
    settings: { ...initialState.settings, ...(saved.settings || {}), aiModel: 'Not connected' },
  };
}

export async function persistState(state: AppState): Promise<void> {
  if (window.scoutline) {
    await window.scoutline.saveState(state);
    return;
  }
  localStorage.setItem(fallbackKey, JSON.stringify(state));
}
