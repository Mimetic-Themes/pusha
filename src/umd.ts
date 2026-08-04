// UMD entry — Path A consumers drop dist/pusha.min.js into theme/assets/ and
// the runtime auto-boots from window.theme.config.
//
// Everything exported here lands on `window.Pusha` via Vite's lib output.
// The auto-boot side-effect runs immediately on script load; if the script
// is loaded with `defer`, this fires after DOM parsing.

import { initRuntime, go } from './runtime.js';
import { registry, ComponentRegistry } from './registry.js';
import {
  onAfterInit,
  onAfterSwap,
  onBeforeLeave,
  onBeforeNav,
  onFirstLoad,
  onNavError,
} from './hooks.js';
import { registerTransition } from './transitions.js';
import { revalidateIslands } from './islands.js';
import { prefetchPage } from './prefetch.js';
import { initActiveLinks } from './active-links.js';

function boot(): void {
  initRuntime();
  // Auto-init active-links / body template-class sync. Both are gated on
  // opt-in markers ([data-pusha-active-links] containers and existing
  // `template-*` body classes), so this is a no-op for themes that don't use
  // either convention. Path A consumers no longer need to ship a separate
  // adapter or call initActiveLinks() manually.
  initActiveLinks();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}

export {
  initRuntime,
  go,
  registry,
  ComponentRegistry,
  onAfterInit,
  onAfterSwap,
  onBeforeLeave,
  onBeforeNav,
  onFirstLoad,
  onNavError,
  registerTransition,
  revalidateIslands,
  prefetchPage,
  initActiveLinks,
};
