import type { AppState } from '../shared/types';

export const initialState: AppState = {
  stateVersion: 4,
  artists: [],
  finderQueue: [],
  campaigns: [],
  assets: [],
  packs: [],
  automations: [
    { id: 'automation-1', name: 'Welcome new connections', trigger: 'Status changes to Connection', action: 'Send welcome email', schedule: 'After 1 minute', enabled: false },
    { id: 'automation-2', name: 'Friday beat delivery', trigger: 'Every Friday', action: 'Send newest tagged pack', schedule: '10:30 AM ET', enabled: false },
  ],
  conversations: [],
  activities: [],
  settings: {
    aiProvider: 'Codex',
    aiModel: 'Not connected',
    aiCallsThisMonth: 0,
    estimatedTokens: 0,
    automaticSending: false,
    requireReviewBelow: 90,
  },
};
