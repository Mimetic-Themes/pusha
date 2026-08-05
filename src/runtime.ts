// Core navigation engine. Adapted from earlier in-theme PJAX prototypes.
// Differences from those prototypes:
//   - container selector is configurable via `config.containerSelector`
//   - transitions go through the named-transition system, not hardcoded mapping
//     or `window.theme.leaveTransition`/`enterTransition`
//   - lifecycle hooks (onBeforeNav, onBeforeLeave, onAfterSwap, onAfterInit)
//     replace the implicit `window.theme.*` callbacks
//   - cart is theme code: Pusha only listens for `cart:mutated` to invalidate
//     the prefetch cache, and bridges Shopify's standard cart events into that
//     same signal so app-driven mutations count too (src/cart.ts)
//   - analytics bridge is built-in and runs after every swap
//   - a11y focus + screen reader announcement run automatically
//   - design-mode (theme editor) disables PJAX and wires shopify:section:* events

import { firePageView } from './analytics.js';
import { installCartBridge, uninstallCartBridge } from './cart.js';
import { getConfig, resolveConfig } from './config.js';
import { checkContainer, log as dlog, recordNavigation, setDebug } from './diagnostics.js';
import { announce, focusContainer, prefersReducedMotion } from './focus.js';
import {
  syncHeadScripts,
  syncHeadStyles,
  updateBodyTemplateAttribute,
  updateMetadata,
  waitForEagerImages,
} from './head-sync.js';
import {
  fireAfterInit,
  fireAfterSwap,
  fireBeforeLeave,
  fireBeforeNav,
  fireFirstLoad,
  fireNavError,
} from './hooks.js';
import { revalidateIslands } from './islands.js';
import {
  getCachedHtml,
  getTemplateFromUrl,
  installPrefetch,
  invalidateCache,
  observeViewportPrefetch,
  peekInFlight,
  warmupNavLinks,
} from './prefetch.js';
import { registry } from './registry.js';
import { SHOPIFY_RESERVED } from './routes.js';
import { restoreScroll, saveScroll, scrollToHash, scrollToTop } from './scroll.js';
import { pickTransition } from './transitions.js';
import type { GoOptions, PushaConfig, NavMeta } from './types.js';

const TRANSITION_DURATION = 300;
const TRANSITION_TIMEOUT = TRANSITION_DURATION + 50;

let booted = false;
let isTransitioning = false;
let currentNavigation: AbortController | null = null;
let currentPageUrl = '';

function inThemeEditor(): boolean {
  return Boolean(window.Shopify?.designMode);
}

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function getContainer(): HTMLElement | null {
  const sel = getConfig().containerSelector!;
  return document.querySelector<HTMLElement>(sel);
}

function getTemplate(container: HTMLElement | null): string {
  return container?.getAttribute('data-page-type') ?? document.body.getAttribute('data-template') ?? '';
}

// ─── Link filtering ───────────────────────────────────────────────────────────

function shouldInterceptLink(link: Element): boolean {
  if (link.tagName !== 'A') return false;
  const anchor = link as HTMLAnchorElement;
  if (!anchor.href) return false;
  if (anchor.hasAttribute('data-no-transition')) return false;
  if (anchor.closest('[data-no-transition]')) return false;
  if (anchor.target === '_blank') return false;
  if (anchor.hasAttribute('download')) return false;
  if (!isSameOrigin(anchor.href)) return false;
  const path = new URL(anchor.href).pathname;
  if (SHOPIFY_RESERVED.test(path)) return false;
  return true;
}

function shouldInterceptEvent(event: MouseEvent): boolean {
  if (event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  return true;
}

// ─── Loading indicator ────────────────────────────────────────────────────────

function startLoading(): void {
  document.documentElement.classList.add('is-navigating');
}

function stopLoading(): void {
  document.documentElement.classList.remove('is-navigating');
}

function setTransitionAttr(name: string): void {
  document.documentElement.setAttribute('data-transition', name);
}

function clearTransitionAttr(): void {
  document.documentElement.removeAttribute('data-transition');
}

// Close persistent-shell modals/drawers/overlays that opted into nav-close.
// Themes mark the modal root with `data-pusha-close-on-nav` (and optionally
// `data-pusha-body-class-on-open="overflow-hidden menu-open"` listing body
// classes the modal toggles when open). Three close shapes are applied:
//
//   1. If the element defines `closeOnNav()` (custom-element method), call it
//      and skip the standard shapes — the theme owns the close behavior.
//   2. Otherwise apply standard shapes to the element itself: strip `[open]`
//      on <details>/<dialog> (calling `.close()` on <dialog>), set
//      `aria-expanded="false"` if previously true, set `aria-hidden="true"`
//      if previously false, and remove the registered body classes.
//
// Cart drawers, persistent widgets, and any modal intentionally surviving nav
// simply omit the marker — opt-in is the safe default.
function closeOnNavElements(): void {
  const els = document.querySelectorAll<HTMLElement>('[data-pusha-close-on-nav]');
  if (els.length === 0) return;
  for (const el of els) {
    const custom = (el as unknown as { closeOnNav?: () => void }).closeOnNav;
    if (typeof custom === 'function') {
      try { custom.call(el); } catch (err) { console.warn('[pusha] closeOnNav() threw', err); }
      stripBodyClassesFor(el);
      continue;
    }
    if (el.tagName === 'DETAILS' && el.hasAttribute('open')) {
      el.removeAttribute('open');
    }
    if (el.tagName === 'DIALOG' && (el as unknown as HTMLDialogElement).open) {
      try { (el as unknown as HTMLDialogElement).close(); } catch { /* ignore */ }
    }
    if (el.getAttribute('aria-expanded') === 'true') {
      el.setAttribute('aria-expanded', 'false');
    }
    if (el.getAttribute('aria-hidden') === 'false') {
      el.setAttribute('aria-hidden', 'true');
    }
    stripBodyClassesFor(el);
  }
}

function stripBodyClassesFor(el: Element): void {
  const list = el.getAttribute('data-pusha-body-class-on-open');
  if (!list || !document.body) return;
  for (const cls of list.split(/\s+/)) {
    if (cls) document.body.classList.remove(cls);
  }
}

// Wait for either a CSS transition or animation to finish on `element`,
// capped by `timeout`. Listening to both keeps the runtime agnostic to
// whether the theme uses `transition` or `@keyframes`.
function waitForCssTransition(element: HTMLElement | null, timeout = TRANSITION_TIMEOUT): Promise<void> {
  return new Promise((resolve) => {
    if (!element) {
      resolve();
      return;
    }
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      element.removeEventListener('transitionend', handler);
      element.removeEventListener('animationend', handler);
      resolve();
    };
    const handler = (event: Event) => {
      if (event.target === element) finish();
    };
    element.addEventListener('transitionend', handler);
    element.addEventListener('animationend', handler);
    setTimeout(finish, timeout);
  });
}

// ─── Core navigation ──────────────────────────────────────────────────────────

async function navigate(url: string, options: { isPopState?: boolean; replace?: boolean; forced?: string } = {}): Promise<void> {
  const config = getConfig();
  const targetUrl = new URL(url, window.location.href);
  const href = targetUrl.pathname + targetUrl.search + targetUrl.hash;
  const navStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  if (isTransitioning && currentNavigation) {
    dlog('nav', `aborting in-flight navigation for new target ${href}`);
    currentNavigation.abort();
  }

  isTransitioning = true;
  startLoading();
  saveScroll(currentPageUrl);

  const currentContainer = getContainer();
  if (!currentContainer) {
    window.location.href = href;
    return;
  }

  // Tell assistive tech the region is mid-update, so a screen reader doesn't
  // announce half-swapped content. Cleared in the `finally` below, which also
  // covers the abort and hard-fallback paths.
  currentContainer.setAttribute('aria-busy', 'true');

  const controller = new AbortController();
  currentNavigation = controller;

  const fromTemplate = getTemplate(currentContainer);
  const toTemplate = getTemplateFromUrl(url);
  const transition = pickTransition(fromTemplate, toTemplate, options.forced);
  const transitionName = transition?.name ?? 'fade';
  setTransitionAttr(transitionName);

  dlog('nav', `→ ${href} (${fromTemplate || '(empty)'} → ${toTemplate}, transition: ${transitionName})`);

  // Treat `transitions: false` like reduced motion — skip the class dance and
  // any CSS transition wait. Page swaps instantly, no fade.
  const reducedMotion = prefersReducedMotion() || config.transitions === false;

  try {
    const cached = getCachedHtml(url);
    const isCached = cached !== null;
    dlog('nav', isCached ? `cache HIT ${href}` : `cache MISS ${href} (fetching)`);

    const leaveMeta = { from: fromTemplate, to: toTemplate };
    const cachedMeta: NavMeta = { url: href, template: toTemplate, cached: isCached };

    await fireBeforeLeave(currentContainer, cachedMeta);

    // Close any persistent-shell modal/drawer that opted in. Without this,
    // search overlays, mobile menu drawers, etc. stay visually "open" across
    // PJAX nav — they were authored assuming a full reload would dismiss them.
    closeOnNavElements();

    // Clean up theme-opted-in portaled DOM before the swap. Custom elements
    // that `document.body.appendChild(this)` during connectedCallback (Dawn's
    // <product-modal> via ModalDialog is the canonical case) escape the swap
    // container and survive PJAX nav. Marking them with `data-pusha-cleanup`
    // in markup tells Pusha to remove them before each leave.
    document.querySelectorAll('[data-pusha-cleanup]').forEach((el) => el.remove());

    let leavePromise: Promise<void> = Promise.resolve();
    if (!reducedMotion) {
      const leaveResult = transition?.leave?.(currentContainer, leaveMeta) ?? null;
      if (leaveResult && typeof (leaveResult as Promise<void>).then === 'function') {
        leavePromise = leaveResult as Promise<void>;
      } else {
        if (isCached) {
          document.documentElement.setAttribute('data-cached-nav', '');
        }
        document.documentElement.classList.add('is-transitioning-out');
        leavePromise = waitForCssTransition(currentContainer);
      }
    }

    let htmlPromise: Promise<string>;
    const inFlightPrefetch = isCached ? null : peekInFlight(url);
    if (isCached) {
      htmlPromise = Promise.resolve(cached);
    } else if (inFlightPrefetch) {
      // Hover/touch prefetch is mid-fetch for this same URL. Awaiting it costs
      // ~the same wall time as firing a fresh fetch (network is the bottleneck)
      // but saves the duplicate round-trip and bandwidth.
      dlog('nav', `awaiting in-flight prefetch for ${href} (race avoided)`);
      htmlPromise = (async () => {
        await inFlightPrefetch;
        const fresh = getCachedHtml(url);
        if (fresh !== null) return fresh;
        // Prefetch resolved without populating cache (network failure / non-2xx).
        // Fall back to a fresh fetch on the nav path.
        const response = await fetch(href, {
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        return response.text();
      })();
    } else {
      const response = await fetch(href, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
      htmlPromise = response.text();
    }

    const [html] = await Promise.all([htmlPromise, leavePromise]);

    if (controller.signal.aborted) {
      isTransitioning = false;
      document.documentElement.classList.remove('is-transitioning-out');
      document.documentElement.removeAttribute('data-cached-nav');
      return;
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');

    updateBodyTemplateAttribute(doc);
    await Promise.all([syncHeadStyles(doc), syncHeadScripts(doc)]);
    updateMetadata(doc);

    const newContainer = doc.querySelector<HTMLElement>(config.containerSelector!);
    if (!newContainer) throw new Error('Target container not found in response');

    // Update URL before swap so analytics + initPage see the new location.
    if (!options.isPopState) {
      if (options.replace) {
        history.replaceState({}, '', href);
      } else {
        history.pushState({}, '', href);
      }
    }

    // importNode (not cloneNode) so the clone is owned by the live document
    // and any custom elements inside get upgraded against the live registry on
    // creation. Plain cloneNode + replaceWith adopts at insert time, which
    // can miss upgrades for nested custom elements.
    const fresh = document.importNode(newContainer, true) as HTMLElement;
    currentContainer.replaceWith(fresh);
    dlog('nav', `swapped ${config.containerSelector} (${fresh.children.length} child nodes)`);
    // Belt + suspenders: explicitly walk the new tree and upgrade any
    // custom elements the registry knows about. Catches the case where
    // a custom element survived importNode as an HTMLElement (Dawn's
    // <product-info> is the canonical example) and also the case where a
    // custom element's defining script loaded *after* the swap completed.
    if (typeof customElements !== 'undefined') {
      customElements.upgrade(fresh);
    }
    currentPageUrl = targetUrl.href;

    const meta: NavMeta = {
      url: targetUrl.pathname + targetUrl.search,
      template: getTemplate(fresh),
      cached: isCached,
    };

    if (options.isPopState) {
      restoreScroll(url);
    } else if (targetUrl.hash) {
      // Defer hash-scroll until after init so the target element exists.
    } else {
      scrollToTop();
    }

    await fireAfterSwap(fresh, meta);

    runInitPage();

    await fireAfterInit(fresh, meta);

    document.dispatchEvent(
      new CustomEvent('pjax:content-swap', { detail: meta }),
    );

    if (config.analytics !== false) {
      dlog('analytics', `firing analytics bridges (shopify/ga4/dataLayer per config)`);
      firePageView(meta);
    }

    if (targetUrl.hash) scrollToHash(targetUrl.hash);

    focusContainer(fresh, targetUrl.hash);
    if (document.title) announce(document.title);
    dlog('a11y', `focused container, announced "${document.title}"`);

    // Revalidate islands — fire-and-forget for cached navs.
    if (isCached) {
      void revalidateIslands(fresh, currentPageUrl, {
        onBeforeSwap: (wrapper) => registry.destroyAll(wrapper),
        onAfterSwap: (el) => registry.initAll(el, new Set(config.disabledComponents ?? [])),
      });
    }

    if (config.debug) {
      checkContainer(fresh, meta);
      recordNavigation(meta);
    }

    const elapsed = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - navStart);
    dlog('nav', `✓ ${href} in ${elapsed}ms`);

    if (!reducedMotion) {
      await waitForEagerImages(fresh);
      const enterResult = transition?.enter?.(fresh, leaveMeta) ?? null;
      if (enterResult && typeof (enterResult as Promise<void>).then === 'function') {
        await (enterResult as Promise<void>);
      } else {
        document.documentElement.classList.remove('is-transitioning-out');
        document.documentElement.classList.add('is-transitioning-in');
        await waitForCssTransition(fresh);
        document.documentElement.classList.remove('is-transitioning-in');
      }
    }
    document.documentElement.removeAttribute('data-cached-nav');
    clearTransitionAttr();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return;
    await fireNavError(error, href);
    console.warn('[pusha] navigation failed, falling back to full nav:', error);
    window.location.href = href;
  } finally {
    isTransitioning = false;
    currentNavigation = null;
    stopLoading();
    // The container may have been replaced by the swap, so clear the flag on
    // whichever element is live now rather than the one captured above.
    getContainer()?.removeAttribute('aria-busy');
  }
}

// ─── Section inits + page init ───────────────────────────────────────────────

function initSectionInits(container: HTMLElement | Document, disabled: ReadonlySet<string>): void {
  let matched = 0;
  let missing = 0;
  let skipped = 0;
  container.querySelectorAll<HTMLElement>('[data-section-type]').forEach((el) => {
    const type = el.dataset.sectionType;
    if (!type) return;
    if (disabled.has(type)) {
      skipped++;
      return;
    }
    const init = window.theme.sectionInits?.[type];
    if (typeof init === 'function') {
      matched++;
      try {
        init(el);
      } catch (err) {
        console.warn(`[pusha] sectionInits["${type}"] threw`, err);
      }
    } else {
      missing++;
      dlog('init', `no sectionInits handler for "${type}"`);
    }
  });
  if (matched || missing || skipped) {
    dlog('init', `sectionInits: ${matched} ran, ${missing} missing, ${skipped} disabled`);
  }
}

function destroySectionsIn(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>('[data-section-type]').forEach((el) => {
    const type = el.dataset.sectionType;
    if (!type) return;
    const destroy = window.theme.sectionDestroy?.[type];
    if (typeof destroy === 'function') {
      try {
        destroy(el);
      } catch (err) {
        console.warn(`[pusha] sectionDestroy["${type}"] threw`, err);
      }
    }
  });
}

function runInitPage(): void {
  const config = getConfig();
  const container = getContainer() ?? document.documentElement;
  const disabled = new Set(config.disabledComponents ?? []);

  registry.setupGlobal();
  registry.initAll(container, disabled);
  initSectionInits(container, disabled);
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function handleLinkClick(event: MouseEvent): void {
  if (!shouldInterceptEvent(event)) return;
  const link = (event.target as Element | null)?.closest('a');
  if (!link || !shouldInterceptLink(link)) return;
  const href = (link as HTMLAnchorElement).href;
  const url = new URL(href, window.location.href);

  // Same-page hash → let the browser smooth-scroll natively.
  if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) {
    return;
  }

  // A click on the URL you are already on — "Home" in the nav while on the home
  // page. Left alone this refetches byte-identical HTML, swaps it in, and fires
  // a second pageview for a page the buyer never left, inflating every
  // navigation-derived metric. Scroll to top instead: that is what the full
  // reload a browser would do looks like, minus the reload and the phantom view.
  if (url.pathname === window.location.pathname && url.search === window.location.search) {
    event.preventDefault();
    scrollToTop();
    dlog('nav', `same-URL click on ${url.pathname} — scrolled to top, no swap`);
    return;
  }

  event.preventDefault();

  // Async chain: fire onBeforeNav → optionally cancel → otherwise navigate.
  void (async () => {
    const beforeEvent = new CustomEvent('pjax:before-nav', {
      cancelable: true,
      detail: { url: href, event },
    });
    const allowedByEvent = document.dispatchEvent(beforeEvent);
    if (!allowedByEvent) {
      window.location.href = href;
      return;
    }
    const allowedByHook = await fireBeforeNav(href, event);
    if (!allowedByHook) return;
    await navigate(href);
  })();
}

function handlePopState(): void {
  void navigate(window.location.href, { isPopState: true });
}

function handleCartMutated(): void {
  const config = getConfig();
  const stateful = config.cartStatefulRoutes;
  if (stateful && stateful.length) {
    invalidateCache((key) => stateful.some((route) => key === route || key.startsWith(`${route}?`)));
    invalidateCache((key) => key === '/cart' || key.startsWith('/cart?'));
  } else {
    invalidateCache();
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function initRuntime(config?: PushaConfig): void {
  if (booted) return;
  booted = true;

  const resolved = resolveConfig(config);
  setDebug(resolved.debug === true);
  dlog('boot', 'initRuntime', { pjax: resolved.pjax, transitions: resolved.transitions, prefetch: !!resolved.prefetchConfig });

  // Boot the registered components on initial load.
  runInitPage();

  // Theme editor coexistence — PJAX off, but section editor events wired.
  if (inThemeEditor()) {
    document.addEventListener('shopify:section:load', (event) => {
      const target = event.target as HTMLElement;
      registry.initAll(target, new Set(resolved.disabledComponents ?? []));
      initSectionInits(target, new Set(resolved.disabledComponents ?? []));
    });
    document.addEventListener('shopify:section:unload', (event) => {
      const target = event.target as HTMLElement;
      destroySectionsIn(target);
      registry.destroyAll(target);
    });
    document.addEventListener('shopify:section:select', (event) => {
      const target = event.target as HTMLElement;
      registry.initAll(target, new Set(resolved.disabledComponents ?? []));
    });
    return;
  }

  if (resolved.pjax === false) return;

  if (!getContainer()) {
    console.warn(`[pusha] container "${resolved.containerSelector}" not found. PJAX disabled.`);
    return;
  }

  history.scrollRestoration = 'manual';
  currentPageUrl = window.location.href;

  document.addEventListener('click', handleLinkClick, true);
  window.addEventListener('popstate', handlePopState);
  document.addEventListener('cart:mutated', handleCartMutated);

  // Feed `cart:mutated` from Shopify's standard cart events too, so cart
  // changes an app made — which the theme never hears about — still invalidate
  // the cache. See src/cart.ts for the settle-before-dispatch timing.
  if (resolved.standardCartEvents !== false) installCartBridge();

  if (resolved.prefetchConfig) installPrefetch();

  // First-load lifecycle hook.
  const container = getContainer()!;
  void fireFirstLoad(container);

  // Eager nav-link warmup (idle).
  if (resolved.prefetchConfig) {
    if (document.readyState === 'complete') warmupNavLinks();
    else window.addEventListener('load', () => warmupNavLinks());
    document.addEventListener('pjax:content-swap', () => warmupNavLinks());
  }

  // Viewport warmup — re-observed after each swap, since the swapped-in
  // container brings new cards and the old observations died with it.
  if (resolved.prefetchConfig && resolved.prefetchInViewport) {
    observeViewportPrefetch();
    document.addEventListener('pjax:content-swap', () => observeViewportPrefetch(getContainer() ?? document));
  }

  if (resolved.analytics !== false) {
    // Initial page view — admin already counts the first hit, but Customer
    // Events publish() on initial load is owned by Shopify's own bootstrapping.
    // Don't double-fire here.
  }

  // Expose initPage for sections that registered via window.theme.sectionInits
  // and need to re-run initialization manually.
  window.theme = window.theme ?? {};
  window.theme.initPage = runInitPage;
}

export async function go(url: string, options: GoOptions = {}): Promise<void> {
  if (options.hard) {
    window.location.href = url;
    return;
  }
  const allowed = await fireBeforeNav(url, null);
  if (!allowed) return;
  await navigate(url, { replace: options.replace, forced: options.transition });
}

/** Test-only — reset boot state and listeners so initRuntime can be called again. */
export function _resetForTests(): void {
  if (booted) {
    document.removeEventListener('click', handleLinkClick, true);
    window.removeEventListener('popstate', handlePopState);
    document.removeEventListener('cart:mutated', handleCartMutated);
    uninstallCartBridge();
  }
  booted = false;
  isTransitioning = false;
  currentNavigation = null;
  currentPageUrl = '';
}
