// Lifecycle hooks. Imported from `@mimetic/pusha/hooks` or accessed via the
// global `Pusha` object. Each register fn returns an unregister fn.
//
// Async handlers are awaited — returning a Promise blocks the lifecycle stage
// until it resolves. Hooks fire in registration order.

import { log as dlog } from './diagnostics.js';
import type { NavMeta } from './types.js';

export type BeforeNavHandler = (
  url: string,
  event: MouseEvent | KeyboardEvent | null,
) => void | Promise<void> | false | Promise<false>;

export type ContainerHandler = (
  container: HTMLElement,
  meta: NavMeta,
) => void | Promise<void>;

export type FirstLoadHandler = (container: HTMLElement) => void | Promise<void>;

export type NavErrorHandler = (
  error: unknown,
  url: string,
) => void | Promise<void>;

type Unregister = () => void;

function makeRegister<T>(set: Set<T>): (handler: T) => Unregister {
  return (handler: T) => {
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  };
}

const beforeNavSet = new Set<BeforeNavHandler>();
const beforeLeaveSet = new Set<ContainerHandler>();
const afterSwapSet = new Set<ContainerHandler>();
const afterInitSet = new Set<ContainerHandler>();
const firstLoadSet = new Set<FirstLoadHandler>();
const navErrorSet = new Set<NavErrorHandler>();

// onFirstLoad fires exactly once at boot. Path A adapters loaded via
// `<script defer>` AFTER pusha.min.js can't register before fireFirstLoad has
// already iterated the set — without late-registration support, those handlers
// silently no-op on initial load. Track the boot state and replay for late
// registrants. (onAfterSwap/onAfterInit don't need this — they fire repeatedly,
// so late handlers naturally pick up from the next nav.)
let firstLoadFired = false;
let firstLoadContainer: HTMLElement | null = null;

export const onBeforeNav = makeRegister(beforeNavSet);
export const onBeforeLeave = makeRegister(beforeLeaveSet);
export const onAfterSwap = makeRegister(afterSwapSet);
export const onAfterInit = makeRegister(afterInitSet);
export const onFirstLoad = (handler: FirstLoadHandler): Unregister => {
  if (firstLoadFired && firstLoadContainer) {
    try {
      const result = handler(firstLoadContainer);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err) =>
          console.warn('[pusha] onFirstLoad handler threw (late)', err),
        );
      }
    } catch (err) {
      console.warn('[pusha] onFirstLoad handler threw (late)', err);
    }
    return () => {};
  }
  firstLoadSet.add(handler);
  return () => firstLoadSet.delete(handler);
};
export const onNavError = makeRegister(navErrorSet);

// ─── Internal — runtime calls these ───────────────────────────────────────────

/**
 * Returns false if any handler returned `false` (cancel the navigation),
 * otherwise true. Handlers run in registration order; the first cancellation
 * still awaits the rest so they observe the same event.
 */
export async function fireBeforeNav(
  url: string,
  event: MouseEvent | KeyboardEvent | null,
): Promise<boolean> {
  if (beforeNavSet.size) dlog('hooks', `onBeforeNav (${beforeNavSet.size} handlers)`);
  let cancelled = false;
  for (const handler of beforeNavSet) {
    try {
      const result = await handler(url, event);
      if (result === false) cancelled = true;
    } catch (err) {
      console.warn('[pusha] onBeforeNav handler threw', err);
    }
  }
  if (cancelled) dlog('hooks', `onBeforeNav cancelled navigation`);
  return !cancelled;
}

export async function fireBeforeLeave(container: HTMLElement, meta: NavMeta): Promise<void> {
  if (beforeLeaveSet.size) dlog('hooks', `onBeforeLeave (${beforeLeaveSet.size} handlers)`);
  for (const handler of beforeLeaveSet) {
    try {
      await handler(container, meta);
    } catch (err) {
      console.warn('[pusha] onBeforeLeave handler threw', err);
    }
  }
}

export async function fireAfterSwap(container: HTMLElement, meta: NavMeta): Promise<void> {
  if (afterSwapSet.size) dlog('hooks', `onAfterSwap (${afterSwapSet.size} handlers)`);
  for (const handler of afterSwapSet) {
    try {
      await handler(container, meta);
    } catch (err) {
      console.warn('[pusha] onAfterSwap handler threw', err);
    }
  }
}

export async function fireAfterInit(container: HTMLElement, meta: NavMeta): Promise<void> {
  if (afterInitSet.size) dlog('hooks', `onAfterInit (${afterInitSet.size} handlers)`);
  for (const handler of afterInitSet) {
    try {
      await handler(container, meta);
    } catch (err) {
      console.warn('[pusha] onAfterInit handler threw', err);
    }
  }
}

export async function fireFirstLoad(container: HTMLElement): Promise<void> {
  if (firstLoadSet.size) dlog('hooks', `onFirstLoad (${firstLoadSet.size} handlers)`);
  for (const handler of firstLoadSet) {
    try {
      await handler(container);
    } catch (err) {
      console.warn('[pusha] onFirstLoad handler threw', err);
    }
  }
  firstLoadContainer = container;
  firstLoadFired = true;
}

export async function fireNavError(error: unknown, url: string): Promise<void> {
  if (navErrorSet.size) dlog('hooks', `onNavError (${navErrorSet.size} handlers)`);
  for (const handler of navErrorSet) {
    try {
      await handler(error, url);
    } catch (err) {
      console.warn('[pusha] onNavError handler threw', err);
    }
  }
}

/** Test-only — clear all registered handlers. */
export function _resetHooksForTests(): void {
  beforeNavSet.clear();
  beforeLeaveSet.clear();
  afterSwapSet.clear();
  afterInitSet.clear();
  firstLoadSet.clear();
  navErrorSet.clear();
  firstLoadFired = false;
  firstLoadContainer = null;
}
