// Singleton holder for the resolved runtime config. Modules read via
// `getConfig()` so the same object isn't passed through every function call.

import type { PushaConfig } from './types.js';

const DEFAULTS: Required<
  Pick<
    PushaConfig,
    'pjax' | 'debug' | 'analytics' | 'transitions' | 'containerSelector' | 'standardCartEvents'
  >
> = {
  pjax: true,
  debug: false,
  analytics: true,
  transitions: true,
  containerSelector: '#MainContent',
  standardCartEvents: true,
};

let resolved: PushaConfig = { ...DEFAULTS };

export function setConfig(config: PushaConfig): void {
  resolved = { ...DEFAULTS, ...config };
}

export function getConfig(): PushaConfig {
  return resolved;
}

export function resolveConfig(input?: PushaConfig): PushaConfig {
  // Merge order: defaults < window.theme.config < explicit input.
  const fromWindow = (typeof window !== 'undefined' && window.theme?.config) || {};
  const merged: PushaConfig = { ...DEFAULTS, ...fromWindow, ...(input ?? {}) };
  resolved = merged;
  return merged;
}
