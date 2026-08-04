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

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<void>>();

let hoverTimeout: ReturnType<typeof setTimeout> | null = null;
let installed = false;

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

// Cache key — pathname + search. Hash is excluded because it never changes
// server-rendered content.
export function toPathKey(url: string): string {
  const u = new URL(url, window.location.href);
  return u.pathname + u.search;
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

// Touch path: skip the 100ms hover-intent debounce. The user has already
// committed to the tap, so kick the fetch as soon as pointerdown fires —
// gives mobile the ~80–200ms before click-settle to warm the cache.
function handleLinkTouch(event: PointerEvent): void {
  if (event.pointerType !== 'touch') return;
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
  document.addEventListener('pointerdown', handleLinkTouch);
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
