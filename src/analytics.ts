// Analytics bridge. Re-fires page-view analytics on every PJAX swap so admin
// reporting, Shopify Customer Events pixels (Meta, GA4, TikTok, Klaviyo, …),
// and any *direct* GA4 / GTM install in the theme keep working. Without this,
// every storefront on Pusha silently corrupts merchant data: a PJAX swap is not
// a browser navigation, so nothing re-fires on its own.
//
// FOUR bridges, each switchable via the `analytics` config:
//
//   analytics: true                                       → shopify on, standardEvents auto, ga4/dataLayer off (default)
//   analytics: false                                      → all off
//   analytics: { shopify, standardEvents, ga4, dataLayer }→ per-bridge control
//
//   1. shopify  — Shopify.analytics.page()  + publish('page_viewed')   [admin + Customer Events]
//                 PLUS the page-type Customer Events the theme serializes as
//                   <script type="application/json" data-pusha-analytics-event>
//                     { "name": "product_viewed", "data": { … } }
//                   </script>
//                 On a native load Shopify auto-fires the page-type event
//                 (product_viewed, collection_viewed, search_submitted,
//                 cart_viewed, …) per template; on a PJAX swap NOTHING does, so
//                 only `page_viewed` would otherwise reach Meta/GA4/etc. The
//                 theme supplies the correct payload per page and Pusha
//                 re-publishes it. Opt-in per page — no script, no event, so
//                 Pusha never invents analytics data.
//   2. ga4      — window.gtag('event','page_view', …). For a *direct* gtag.js
//                 install in the theme. Leave OFF when GA4 runs through Shopify
//                 Customer Events (bridge 1 already covers that) — firing both
//                 double-counts. Off by default.
//   3. dataLayer— window.dataLayer.push({ event, … }) for GTM. Off by default.
//   4. standardEvents — @shopify/standard-events PageViewEvent, re-dispatched on
//                 swap for new-Liquid themes (their page-view-event.js fires only
//                 on DOMContentLoaded, so the generic pageview is dropped on PJAX
//                 navs). 'auto' by default: no-ops unless the theme ships
//                 @shopify/standard-events (resolved via the theme's importmap).
//                 Page-type events self-heal via <s-view-event> — not re-fired here.
//
// Every channel is best-effort: absent globals are silent no-ops; nothing here
// throws or blocks navigation.

import { getConfig } from './config.js';
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
  if (a === false) return { shopify: false, ga4: false, dataLayer: false, standardEvents: false };
  if (a === undefined || a === true) return { shopify: true, ga4: false, dataLayer: false, standardEvents: 'auto' };
  return {
    shopify: a.shopify !== false,
    ga4: a.ga4 ?? false,
    dataLayer: a.dataLayer ?? false,
    standardEvents: a.standardEvents ?? 'auto',
  };
}

export function firePageView(meta?: NavMeta): void {
  const bridges = resolveBridges();
  if (bridges.shopify) fireShopify(meta);
  if (bridges.ga4 !== false) fireGa4(bridges.ga4);
  if (bridges.dataLayer !== false) fireDataLayer(bridges.dataLayer);
  // Async, fire-and-forget: dynamic import + dispatch shouldn't block the nav
  // lifecycle. No-ops when @shopify/standard-events isn't importable (classic themes).
  if (bridges.standardEvents !== false) void fireStandardEvents(meta);
}

function fireShopify(meta?: NavMeta): void {
  const analytics = window.Shopify?.analytics;
  if (!analytics) return;

  const url = meta?.url
    ? new URL(meta.url, window.location.origin).href
    : window.location.href;

  try {
    analytics.page?.();
  } catch (err) {
    console.warn('[pusha/analytics] page() threw', err);
  }

  try {
    analytics.publish?.('page_viewed', { url });
  } catch (err) {
    console.warn('[pusha/analytics] publish(page_viewed) threw', err);
  }

  // Page-type events the theme serialized for the page just swapped in.
  for (const evt of readSerializedEvents()) {
    try {
      analytics.publish?.(evt.name, evt.data);
    } catch (err) {
      console.warn(`[pusha/analytics] publish(${evt.name}) threw`, err);
    }
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
