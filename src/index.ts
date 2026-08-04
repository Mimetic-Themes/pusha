// @mimetic/pusha — main entry.
//
// Themes with a build pipeline (Path B) typically just import { initRuntime }
// and call it once at bootstrap. The UMD bundle (Path A) auto-boots — see
// src/umd.ts.

export { initRuntime, go } from './runtime.js';
export { registry, ComponentRegistry } from './registry.js';
export type { ThemeComponent } from './registry.js';
export {
  onBeforeNav,
  onBeforeLeave,
  onAfterSwap,
  onAfterInit,
  onFirstLoad,
  onNavError,
} from './hooks.js';
export type {
  BeforeNavHandler,
  ContainerHandler,
  FirstLoadHandler,
  NavErrorHandler,
} from './hooks.js';
export { registerTransition } from './transitions.js';
export type { TransitionDef, TransitionMatcher } from './transitions.js';
export { initActiveLinks } from './active-links.js';
export type {
  PushaConfig,
  PrefetchConfig,
  PrefetchEntry,
  PrefetchTtl,
  TemplateType,
  GoOptions,
  NavMeta,
  SectionInits,
  SectionDestroyers,
} from './types.js';
