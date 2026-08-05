// Analytics bridge. Re-fires page-view analytics on every PJAX swap so admin
// reporting, web pixels, and any *direct* GA4 / GTM install in the theme keep
// working. Without this, every storefront on Pusha silently under-reports: a
// PJAX swap is not a browser navigation, so nothing re-fires on its own.
//
// ⚠ THE FENCE — `Shopify.analytics.publish` publishes CUSTOM EVENTS ONLY:
//
//   "To ensure the quality of standard events, partners and merchants cannot
//    publish standard events. Shopify.analytics.publish only exposes the
//    method to publish custom events."
//   — https://shopify.dev/docs/api/web-pixels-api/emitting-data
//
// So publishing under a STANDARD name (`page_viewed`, `product_viewed`, …) is
// rejected: the call returns false and no pixel receives it. Pusha used to make
// those calls anyway, on the theory that they were harmless no-ops ready for a
// future supported path. They are removed — a call that provably cannot land
// reads as a working pixel path to anyone skimming this file, and that is worse
// than the byte it saves. The supported route is a namespaced custom event plus
// a merchant-authored custom pixel: the `customEvents` bridge below, on by
// default. ⚠ It reaches pixels, but it does NOT restore third-party app pixels
// (Meta/Klaviyo don't know the prefixed names) and cannot feed Shopify admin
// reporting — `trekkie` is the bridge for that.
// See docs/analytics-companion-pixel.md and README "Analytics & tracking".
//
// SIX bridges, each switchable via the `analytics` config:
//
//   analytics: true   → shopify on, standardEvents auto, customEvents on,
//                       ga4/dataLayer/trekkie off (default)
//   analytics: false  → all off
//   analytics: { … }  → per-bridge control
//
//   1. shopify  — Shopify.analytics.page() only. Classic-theme admin reporting,
//                 and a thin one: the method is `undefined` on every modern
//                 classic theme measured so far (the live entry point is
//                 `ShopifyAnalytics.lib.page` — see `trekkie`) and absent on
//                 new-Liquid. Kept for themes where it does exist, and SKIPPED
//                 when `trekkie` is on, since both feed the same pageview and
//                 firing both would double-count.
//   2. ga4      — window.gtag('event','page_view', …). For a *direct* gtag.js
//                 install in the theme. Currently the only GA4 path Pusha can
//                 keep alive across swaps; GA4 routed through Customer Events
//                 needs the companion pixel. Off by default.
//   3. dataLayer— window.dataLayer.push({ event, … }) for GTM. Off by default.
//   4. standardEvents — @shopify/standard-events PageViewEvent, re-dispatched on
//                 swap for new-Liquid themes (their page-view-event.js fires only
//                 on DOMContentLoaded, so the generic pageview is dropped on PJAX
//                 navs). 'auto' by default: no-ops unless the theme ships
//                 @shopify/standard-events (resolved via the theme's importmap).
//                 Page-type events self-heal via <s-view-event> — not re-fired here.
//                 MEASURED not to reach the web pixel sandbox; it is a
//                 documented-surface call, so it stays as the forward-compatible
//                 channel, but don't claim it as a pixel fix.
//   5. customEvents — prefixed custom events. The only publish path that clears
//                 the fence above and reaches pixels. On by default.
//   6. trekkie  — ShopifyAnalytics.lib.page(), the pipe behind admin Analytics.
//                 Off by default (undocumented global). See its own block below.
//
// Every channel is best-effort: absent globals are silent no-ops; nothing here
// throws or blocks navigation.

import { getConfig } from './config.js';
import { log as dlog } from './diagnostics.js';
import type { AnalyticsConfig, NavMeta } from './types.js';

interface SerializedEvent {
  name: string;
  data?: unknown;
}

function pageParams(): Record<string, string> {
  return {
    page_location: window.location.href,
    page_title: document.title,
    page_path: window.location.pathname + window.location.search,
  };
}

// Normalize the `analytics` config (bool | object) into explicit per-bridge
// switches. Defaults: shopify on, ga4/dataLayer off.
function resolveBridges(): Required<AnalyticsConfig> {
  const a = getConfig().analytics;
  if (a === false) {
    return {
      shopify: false, ga4: false, dataLayer: false,
      standardEvents: false, customEvents: false, trekkie: false,
    };
  }
  if (a === undefined || a === true) {
    return {
      shopify: true, ga4: false, dataLayer: false,
      standardEvents: 'auto', customEvents: true, trekkie: false,
    };
  }
  return {
    shopify: a.shopify !== false,
    ga4: a.ga4 ?? false,
    dataLayer: a.dataLayer ?? false,
    standardEvents: a.standardEvents ?? 'auto',
    customEvents: a.customEvents ?? true,
    trekkie: a.trekkie ?? false,
  };
}

export function firePageView(meta?: NavMeta): void {
  const bridges = resolveBridges();
  // Only the custom-event bridge reads these now — the standard-name publishes
  // that used to share the parse were rejected by the platform and are gone.
  const serialized = bridges.customEvents !== false ? readSerializedEvents() : [];
  if (bridges.customEvents !== false) {
    fireCustomEvents(
      bridges.customEvents === true ? 'pusha' : bridges.customEvents,
      serialized,
      meta,
    );
  }
  if (bridges.trekkie) fireTrekkie(meta);
  if (bridges.shopify) fireShopify(bridges.trekkie);
  if (bridges.ga4 !== false) fireGa4(bridges.ga4);
  if (bridges.dataLayer !== false) fireDataLayer(bridges.dataLayer);
  // Async, fire-and-forget: dynamic import + dispatch shouldn't block the nav
  // lifecycle. No-ops when @shopify/standard-events isn't importable (classic themes).
  if (bridges.standardEvents !== false) void fireStandardEvents(meta);
}

// `Shopify.analytics.page()` — the whole of this bridge. Its publish() calls
// were removed: standard event names are fenced (see the header), so they
// landed nowhere, and the prefixed copies already go out via `customEvents`.
//
// Skipped entirely when `trekkie` is on. Both bridges exist to re-fire the one
// storefront pageview; on a theme where `Shopify.analytics.page` is defined,
// running both would send two pageviews per navigation. That would inflate
// admin counts and — worse for the A/B/C measurement this was built for — read
// as a success when it is a double-count.
function fireShopify(trekkieEnabled: boolean): void {
  if (trekkieEnabled) {
    dlog('analytics', 'shopify bridge skipped — trekkie owns the pageview');
    return;
  }
  const analytics = window.Shopify?.analytics;
  if (!analytics) return;

  try {
    analytics.page?.();
  } catch (err) {
    console.warn('[pusha/analytics] page() threw', err);
  }
}

// Read <script type="application/json" data-pusha-analytics-event> blocks from
// the live document (the swapped-in container's script is now live; the prior
// page's was removed with its container). Accepts a single object or an array.
function readSerializedEvents(): SerializedEvent[] {
  const nodes = document.querySelectorAll<HTMLScriptElement>(
    'script[data-pusha-analytics-event]',
  );
  const out: SerializedEvent[] = [];
  for (const node of nodes) {
    const raw = node.textContent?.trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn('[pusha/analytics] bad data-pusha-analytics-event JSON', err);
      continue;
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (item && typeof item === 'object' && typeof (item as SerializedEvent).name === 'string') {
        out.push(item as SerializedEvent);
      }
    }
  }
  return out;
}

// ─── Trekkie bridge (admin reporting) ───────────────────────────────────────
// Re-fires the pageview that feeds Shopify admin's Analytics reports. Separate
// pipe from web pixels: Trekkie/Monorail carries admin reporting, Web Pixels
// Manager carries Meta/GA4/Klaviyo. This bridge only addresses the former.
//
// MEASURED on a published OS 2.0 store (see experiments/monorail-admin-probe.md):
//   - `lib.page(null, { path, url })` with no identity sends, but the payload
//     carries NO pageType and NO resourceId at all.
//   - `lib.page(null, { …, pageType, resourceId })` lands both fields in
//     `trekkie_storefront_page_view` and both `storefront_customer_tracking`
//     schemas, AND Web Pixels Manager mirrors it into
//     `storefront_customer_tracking_parity` with the same event_id.
//   - `ShopifyAnalytics.meta` is NOT read for identity and is never written —
//     verified unchanged across calls. That matters: `meta` is a global other
//     scripts read, so mutating it would be a side effect on code we don't own.
//
// Identity comes from the theme, per template, exactly like the page-type
// Customer Events above — Pusha never invents it. No block, no call.
//
// ⚠ `window.ShopifyAnalytics` is undocumented and sits outside Shopify's Liquid
// compatibility guarantee. Every access is optional-chained so its removal
// degrades to silence: admin undercounts rather than receiving wrong data.
//
// ⚠ Known payload gaps on a soft nav, unresolved: `canonical_url` comes from the
// document's <link rel="canonical"> (head-sync should correct it — untested),
// `navigation_type` stays "reload" from the original load's Navigation Timing
// entry, and `microSessionId` does not rotate the way a hard load rotates it.
interface TrekkiePage {
  pageType?: string;
  resourceId?: number | string;
  [key: string]: unknown;
}

function readTrekkiePage(): TrekkiePage | null {
  const node = document.querySelector<HTMLScriptElement>('script[data-pusha-trekkie-page]');
  const raw = node?.textContent?.trim();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as TrekkiePage;
    }
  } catch (err) {
    console.warn('[pusha/analytics] bad data-pusha-trekkie-page JSON', err);
  }
  return null;
}

function fireTrekkie(meta?: NavMeta): void {
  const lib = window.ShopifyAnalytics?.lib;
  const page = lib?.page;
  if (!lib || typeof page !== 'function') return;

  const identity = readTrekkiePage();
  if (!identity) {
    dlog('analytics', 'trekkie bridge: no data-pusha-trekkie-page block, skipping');
    return;
  }

  const url = new URL(meta?.url ?? window.location.href, window.location.origin);

  try {
    page.call(lib, null, {
      path: url.pathname,
      search: url.search,
      url: url.href,
      title: document.title,
      ...identity,
    });
    dlog('analytics', `trekkie page() fired for ${identity.pageType ?? '?'} ${url.pathname}`);
  } catch (err) {
    console.warn('[pusha/analytics] ShopifyAnalytics.lib.page threw', err);
  }
}

// ─── Custom-event bridge ────────────────────────────────────────────────────
// The only publish path from a theme that actually reaches web pixels.
// `Shopify.analytics.publish` rejects STANDARD event names ("to ensure the
// quality of standard events, partners and merchants cannot publish standard
// events" — web-pixels-api/emitting-data) and returns false, so the page_viewed
// call in fireShopify() above lands nowhere. CUSTOM events are explicitly
// supported from theme Liquid and are delivered to "all custom pixels and app
// pixels", so a prefixed name gets through.
//
// Nothing subscribes to these by default — they are a no-op until the merchant
// adds a companion pixel that forwards them onward. See
// docs/analytics-companion-pixel.md for the pixel and the honest limits (this
// does NOT revive third-party app pixels, and cannot feed admin reporting).
//
// Only fires on swaps: firePageView() is called from the swap path alone, so a
// hard load emits Shopify's native standard events and nothing from here. The
// two sets are disjoint — a companion pixel can subscribe to both without
// double-counting.
function fireCustomEvents(
  prefix: string,
  serialized: SerializedEvent[],
  meta?: NavMeta,
): void {
  if (!window.Shopify?.analytics?.publish) return;

  const url = meta?.url
    ? new URL(meta.url, window.location.origin).href
    : window.location.href;

  publishCustom(prefix, 'page_viewed', {
    url,
    path: new URL(url).pathname,
    title: document.title,
    template: containerTemplate(meta),
    cached: meta?.cached ?? false,
  });

  // Same theme-serialized payloads the Shopify bridge reads, republished under
  // the prefix so they clear the standard-name fence.
  for (const evt of serialized) {
    publishCustom(prefix, evt.name, evt.data);
  }
}

function publishCustom(prefix: string, name: string, data: unknown): void {
  try {
    window.Shopify?.analytics?.publish?.(`${prefix}:${name}`, data);
  } catch (err) {
    console.warn(`[pusha/analytics] publish(${prefix}:${name}) threw`, err);
  }
}

// ─── Standard Events bridge (new-Liquid) ────────────────────────────────────
// @shopify/standard-events is resolved through the THEME's importmap at runtime.
// The specifier lives in a variable + /* @vite-ignore */ so the bundler leaves it
// as a runtime import (Pusha doesn't depend on the package). Cached after the
// first attempt: the module on success, null on failure (classic theme — no
// importmap entry).
const STANDARD_EVENTS_SPECIFIER = '@shopify/standard-events';
let standardEventsModule: { PageViewEvent?: new (detail: unknown) => Event } | null | undefined;

async function loadStandardEvents(): Promise<typeof standardEventsModule> {
  if (standardEventsModule !== undefined) return standardEventsModule;
  try {
    standardEventsModule = await import(/* @vite-ignore */ STANDARD_EVENTS_SPECIFIER);
  } catch {
    standardEventsModule = null;
  }
  return standardEventsModule;
}

function containerTemplate(meta?: NavMeta): string {
  if (meta?.template) return meta.template;
  const el =
    document.querySelector('[data-page-container]') ??
    document.getElementById('main-content') ??
    document.getElementById('MainContent');
  return (
    el?.getAttribute('data-page-type') ??
    el?.getAttribute('data-template') ??
    document.body?.getAttribute('data-template') ??
    ''
  );
}

// Re-dispatch the generic PageViewEvent through @shopify/standard-events — the
// theme's page-view-event.js fires it on DOMContentLoaded, which never re-fires
// on a PJAX swap, so the standard-events channel silently drops the pageview.
// Page-type events (product_viewed, collection_viewed) are intentionally NOT
// re-fired here: the theme's <s-view-event view-event-trigger="connect"> elements
// re-fire those when they re-mount in the swapped content, so doing it here would
// double-count. Verified independent of Shopify.analytics.publish (no cross-forward).
async function fireStandardEvents(meta?: NavMeta): Promise<void> {
  const mod = await loadStandardEvents();
  if (!mod || typeof mod.PageViewEvent !== 'function') return;
  const url = meta?.url
    ? new URL(meta.url, window.location.origin).href
    : window.location.href;
  try {
    document.dispatchEvent(
      new mod.PageViewEvent({
        page: { template: containerTemplate(meta), title: document.title, url },
      }),
    );
  } catch (err) {
    console.warn('[pusha/analytics] PageViewEvent dispatch threw', err);
  }
}

// Direct GA4 (gtag.js). `cfg === true` → one generic page_view. A measurement
// id (or array) targets specific streams via `send_to` so a multi-stream
// install doesn't fan a single event to all of them.
function fireGa4(cfg: boolean | string | string[]): void {
  const gtag = window.gtag;
  if (typeof gtag !== 'function') return;
  const params = pageParams();
  const ids = typeof cfg === 'string' ? [cfg] : Array.isArray(cfg) ? cfg : null;
  try {
    if (ids) {
      for (const id of ids) gtag('event', 'page_view', { ...params, send_to: id });
    } else {
      gtag('event', 'page_view', params);
    }
  } catch (err) {
    console.warn('[pusha/analytics] gtag page_view threw', err);
  }
}

// GTM dataLayer. `cfg === true` → default event name; string → custom event
// name; object → merged into the push (lets the theme add ecommerce payloads).
function fireDataLayer(cfg: boolean | string | Record<string, unknown>): void {
  const dl = window.dataLayer;
  if (!Array.isArray(dl)) return;
  const payload: Record<string, unknown> = {
    event: typeof cfg === 'string' ? cfg : 'pusha.page_view',
    ...pageParams(),
  };
  if (cfg && typeof cfg === 'object') Object.assign(payload, cfg);
  try {
    dl.push(payload);
  } catch (err) {
    console.warn('[pusha/analytics] dataLayer.push threw', err);
  }
}
