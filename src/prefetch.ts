// Prefetch cache + hover/touch warmup + nav-link warmup. Per the spec this
// subpath is opt-in; the main runtime imports it automatically when
// `prefetchConfig` is set on `window.theme.config`.

import type { PushaConfig, PrefetchTtl } from './types.js';
import { getConfig } from './config.js';
import { log as dlog } from './diagnostics.js';
import { SHOPIFY_RESERVED } from './routes.js';

interface CacheEntry {
  html: string;
  cachedAt: number;
}

// Whole pages are cached as HTML strings, so an uncapped map is a slow leak on
// a long browsing session — and viewport prefetch can add entries far faster
// than clicking does. Oldest-first eviction; Map preserves insertion order.
const CACHE_MAX_ENTRIES = 32;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<void>>();

function trimCache(): void {
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== 'string') break;
    cache.delete(oldest);
    dlog('prefetch', `evicted ${oldest} (cache cap ${CACHE_MAX_ENTRIES})`);
  }
}

let hoverTimeout: ReturnType<typeof setTimeout> | null = null;
let installed = false;

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

// Params that never change server-rendered content — campaign tags and
// Shopify's own recommendation-tracking (`pr_*`, added to every product link
// rendered by a recommendations section). Stripping them collapses what would
// otherwise be a separate cache entry, and a separate fetch, per referring
// widget. Deny-list rather than allow-list on purpose: an unknown param may be
// a collection filter or a variant, and dropping one of those would serve the
// wrong page.
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'twclid', 'igshid',
  'mc_cid', 'mc_eid', 'srsltid', '_kx',
  'pr_prod_strat', 'pr_rec_id', 'pr_rec_pid', 'pr_ref_pid', 'pr_seq',
]);

// Cache key — pathname + normalized search. Hash is excluded because it never
// changes server-rendered content. Params are stripped of tracking noise and
// sorted so equivalent URLs share one entry. This value is also used as the
// fetch URL, so the request goes out clean too.
export function toPathKey(url: string): string {
  const u = new URL(url, window.location.href);
  const params = new URLSearchParams(u.search);
  for (const name of Array.from(params.keys())) {
    if (TRACKING_PARAMS.has(name)) params.delete(name);
  }
  params.sort();
  const search = params.toString();
  return search ? `${u.pathname}?${search}` : u.pathname;
}

// Infer template type from Shopify's URL structure. Used to look up the TTL
// before the response is in hand. Themes serving non-standard URLs may have
// some prefetch decisions fall through to the 'other' bucket.
export function getTemplateFromUrl(url: string): string {
  const path = new URL(url, window.location.href).pathname;
  if (path === '/' || path === '') return 'index';
  if (path.startsWith('/products/')) return 'product';
  if (path.startsWith('/collections/')) return 'collection';
  if (path.startsWith('/blogs/')) return path.split('/').length > 3 ? 'article' : 'blog';
  if (path.startsWith('/pages/')) return 'page';
  return 'other';
}

function resolveTtl(template: string, config: PushaConfig): PrefetchTtl | undefined {
  const raw = config.prefetchConfig?.[template];
  if (raw === undefined) return undefined;
  if (typeof raw === 'number') return { soft: Math.floor(raw / 4), hard: raw };
  return raw;
}

export function getCachedHtml(url: string): string | null {
  const config = getConfig();
  const key = toPathKey(url);
  const entry = cache.get(key);
  if (!entry) return null;
  const ttl = resolveTtl(getTemplateFromUrl(url), config);
  if (!ttl) {
    cache.delete(key);
    return null;
  }
  const age = Date.now() - entry.cachedAt;
  if (age > ttl.hard) {
    dlog('prefetch', `EXPIRED ${key} (age ${Math.round(age / 1000)}s > hard ${Math.round(ttl.hard / 1000)}s)`);
    cache.delete(key);
    return null;
  }
  if (age > ttl.soft) {
    dlog('prefetch', `STALE ${key} (age ${Math.round(age / 1000)}s > soft ${Math.round(ttl.soft / 1000)}s) — revalidating in background`);
    void prefetchPage(url, { force: true });
  } else {
    dlog('prefetch', `HIT ${key} (age ${Math.round(age / 1000)}s, soft TTL not reached)`);
  }
  return entry.html;
}

// Sync probe — returns the in-flight prefetch promise for `url` if one is
// active, else null. Used by runtime.navigate() to dedup against an in-flight
// hover/touch warmup: if the user clicks a link mid-warmup, we await the
// prefetch instead of firing a duplicate fetch.
export function peekInFlight(url: string): Promise<void> | null {
  return inFlight.get(toPathKey(url)) ?? null;
}

export function invalidateCache(predicate?: (url: string) => boolean): void {
  if (!predicate) {
    if (cache.size) dlog('prefetch', `invalidating entire cache (${cache.size} entries)`);
    cache.clear();
    return;
  }
  let removed = 0;
  for (const key of Array.from(cache.keys())) {
    if (predicate(key)) {
      cache.delete(key);
      removed++;
    }
  }
  if (removed) dlog('prefetch', `invalidated ${removed} cache entries via predicate`);
}

// Background-load fetchpriority="high" images from prefetched HTML so the
// browser cache is warm by the time the user clicks. Detached Image() with
// srcset/sizes lets the browser pick the right resource for the viewport.
function warmCriticalImages(html: string): void {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const imgs = doc.querySelectorAll<HTMLImageElement>('img[fetchpriority="high"]');
    imgs.forEach((img) => {
      const src = img.getAttribute('src');
      if (!src) return;
      const preload = new Image();
      const srcset = img.getAttribute('srcset');
      const sizes = img.getAttribute('sizes');
      if (sizes) preload.sizes = sizes;
      if (srcset) preload.srcset = srcset;
      preload.src = src;
    });
  } catch {
    // Image warming is best-effort — never block the prefetch.
  }
}

export function prefetchPage(url: string, { force = false } = {}): Promise<void> {
  const key = toPathKey(url);
  if (!force && cache.has(key)) return Promise.resolve();

  const existing = inFlight.get(key);
  if (existing) return existing;

  dlog('prefetch', `warming ${key}`);
  const promise = (async () => {
    try {
      const response = await fetch(key, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!response.ok) {
        dlog('prefetch', `warm FAILED ${key} (${response.status})`);
        return;
      }
      const html = await response.text();
      cache.set(key, { html, cachedAt: Date.now() });
      trimCache();
      dlog('prefetch', `cached ${key} (${html.length} bytes)`);
      warmCriticalImages(html);
    } catch (err) {
      // Prefetch failures are silent — main nav will fetch normally.
      dlog('prefetch', `warm threw ${key}`, err);
    }
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, promise);
  return promise;
}

function shouldPrefetchLink(link: Element): boolean {
  if (link.tagName !== 'A') return false;
  const anchor = link as HTMLAnchorElement;
  if (!anchor.href) return false;
  if (anchor.hasAttribute('data-no-transition')) return false;
  if (anchor.closest('[data-no-transition]')) return false;
  if (anchor.target === '_blank') return false;
  if (!isSameOrigin(anchor.href)) return false;
  const path = new URL(anchor.href).pathname;
  if (SHOPIFY_RESERVED.test(path)) return false;
  return true;
}

function handleLinkHover(event: MouseEvent): void {
  const link = (event.target as Element | null)?.closest('a');
  if (!link || !shouldPrefetchLink(link)) return;
  const config = getConfig();
  const ttl = resolveTtl(getTemplateFromUrl((link as HTMLAnchorElement).href), config);
  if (!ttl) return;
  if (hoverTimeout) clearTimeout(hoverTimeout);
  hoverTimeout = setTimeout(() => {
    prefetchPage((link as HTMLAnchorElement).href);
  }, 100);
}

function clearHoverTimeout(): void {
  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }
}

// Pointer-down path, every pointer type: skip the 100ms hover-intent debounce.
// The user has committed to the click, so kick the fetch immediately — mobile
// gets the ~80–200ms before click-settle, and a fast mouse click that lands
// inside the debounce window stops missing the cache entirely.
function handleLinkPointerDown(event: PointerEvent): void {
  const link = (event.target as Element | null)?.closest('a');
  if (!link || !shouldPrefetchLink(link)) return;
  const config = getConfig();
  const ttl = resolveTtl(getTemplateFromUrl((link as HTMLAnchorElement).href), config);
  if (!ttl) return;
  clearHoverTimeout();
  prefetchPage((link as HTMLAnchorElement).href);
}

// Keyboard path: tabbing onto a link is the keyboard equivalent of hovering it,
// and without this keyboard users never get a warm cache.
function handleLinkFocus(event: FocusEvent): void {
  const link = (event.target as Element | null)?.closest('a');
  if (!link || !shouldPrefetchLink(link)) return;
  const config = getConfig();
  const ttl = resolveTtl(getTemplateFromUrl((link as HTMLAnchorElement).href), config);
  if (!ttl) return;
  prefetchPage((link as HTMLAnchorElement).href);
}

export function installPrefetch(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('mouseover', handleLinkHover);
  document.addEventListener('mouseout', clearHoverTimeout);
  document.addEventListener('pointerdown', handleLinkPointerDown);
  document.addEventListener('focusin', handleLinkFocus);
}

// Viewport warmup. Warms the first link inside each element matching
// `prefetchInViewport` as it nears the viewport — the collection-grid case,
// where the next click is almost always a card the buyer just scrolled to.
//
// Opt-in by selector because OS 2.0 themes share no card convention (Dawn uses
// .card-wrapper, others differ, and Horizon has a <product-card> element). A
// wrong selector either does nothing or warms far too much, so there is no
// useful default. Budget it: on a 50-product collection this is 50 fetches if
// the buyer scrolls to the bottom, bounded only by CACHE_MAX_ENTRIES.
let viewportObserver: IntersectionObserver | null = null;

function warmElementLink(el: Element): void {
  const link = el.matches('a[href]') ? el : el.querySelector('a[href]');
  if (!link || !shouldPrefetchLink(link)) return;
  const ttl = resolveTtl(getTemplateFromUrl((link as HTMLAnchorElement).href), getConfig());
  if (!ttl) return;
  prefetchPage((link as HTMLAnchorElement).href);
}

export function observeViewportPrefetch(root: ParentNode = document): void {
  const selector = getConfig().prefetchInViewport;
  if (!selector) return;

  if (typeof IntersectionObserver === 'undefined') {
    root.querySelectorAll(selector).forEach(warmElementLink);
    return;
  }

  viewportObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        viewportObserver?.unobserve(entry.target);
        warmElementLink(entry.target);
      }
    },
    { rootMargin: '200px 0px' },
  );

  const targets = root.querySelectorAll(selector);
  targets.forEach((el) => viewportObserver?.observe(el));
  if (targets.length) dlog('prefetch', `viewport warmup observing ${targets.length} × "${selector}"`);
}

// Clears the module-level singletons. Without this, `installed` stays true
// across a test's fresh jsdom document and installPrefetch() early-returns,
// leaving the listeners bound to the torn-down document.
export function _resetPrefetchForTests(): void {
  viewportObserver?.disconnect();
  viewportObserver = null;
  installed = false;
  clearHoverTimeout();
  cache.clear();
  inFlight.clear();
  warmedFrom.clear();
}

// Eager nav-link warmup. Runs at requestIdleCallback time on initial load
// and after PJAX swaps onto index/page templates. Same-page links and
// /cart, /account, /checkout are skipped.
const warmedFrom = new Set<string>();

export interface NavWarmupOptions {
  /** Selector for the nav container. Defaults to '#header-group, header'. */
  selector?: string;
  /** Restrict warmup to these template values. Defaults to ['index', 'page']. */
  templates?: string[];
}

export function warmupNavLinks(options: NavWarmupOptions = {}): void {
  const templates = options.templates ?? ['index', 'page'];
  const template = document.body.dataset.template ?? '';
  if (!templates.includes(template) && window.location.pathname !== '/') return;
  if (warmedFrom.has(window.location.pathname)) return;
  warmedFrom.add(window.location.pathname);

  const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 200));
  idle(() => {
    const sel = options.selector ?? '#header-group, header';
    const header = document.querySelector(sel);
    if (!header) {
      dlog('prefetch', `nav-link warmup: selector "${sel}" matched nothing`);
      return;
    }
    const links = header.querySelectorAll<HTMLAnchorElement>('a[href]');
    const origin = window.location.origin;
    let warmed = 0;
    links.forEach((link) => {
      if (!link.href.startsWith(origin)) return;
      const path = new URL(link.href).pathname;
      // Exclude SHOPIFY_RESERVED (auth/checkout/locale/etc) AND /cart (PJAX-able
      // but stateful — warming a cart page is wasteful since it's per-session).
      if (SHOPIFY_RESERVED.test(path)) return;
      if (path.startsWith('/cart')) return;
      if (path === window.location.pathname) return;
      prefetchPage(link.href);
      warmed++;
    });
    if (warmed) dlog('prefetch', `nav-link warmup: ${warmed} links`);
  });
}
