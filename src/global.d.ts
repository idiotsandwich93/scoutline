import type { ScoutlineAPI } from './shared/types';

declare global {
  interface Window {
    scoutline?: ScoutlineAPI;
  }
}

export {};
