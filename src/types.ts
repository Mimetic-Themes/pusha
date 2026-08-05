// Public types and ambient global declarations for Pusha.
//
// `window.theme.config` is the canonical config surface. Themes set it before
// the runtime boots (e.g. in `layout/theme.liquid` ahead of `{% render 'pusha' %}`).

export type TemplateType =
  | 'index'
  | 'product'
  | 'collection'
  | 'article'
  | 'blog'
  | 'page'
  | 'other'
  | (string & {});

export interface PrefetchTtl {
  soft: number;
  hard: number;
}

export type PrefetchEntry = number | PrefetchTtl;

export type PrefetchConfig = Partial<Record<TemplateType, PrefetchEntry>>;

export interface AnalyticsConfig {
  /** Shopify admin reporting + Customer Events bridge (page_viewed plus any
   *  page-type events the theme serializes as data-pusha-analytics-event).
   *  Defaults to true. */
  shopify?: boolean;
  /** Direct GA4 (gtag.js) page_view on swap. `true` fires when window.gtag
   *  exists; a measurement id (or array of ids) targets specific streams via
   *  send_to. Defaults to false — GA4 routed through Shopify Customer Events is
   *  already covered by `shopify`, and firing both double-counts. */
  ga4?: boolean | string | string[];
  /** GTM dataLayer push on swap. `true` pushes { event: 'pusha.page_view', … };
   *  a string sets the event name; an object is merged into the push. Defaults
   *  to false. */
  dataLayer?: boolean | string | Record<string, unknown>;
  /** @shopify/standard-events bridge for new-Liquid themes. On a full load the
   *  theme dispatches a `PageViewEvent` (via @shopify/standard-events) on
   *  DOMContentLoaded; that does NOT re-fire on a PJAX swap, so the generic
   *  pageview goes missing on the standard-events channel. When enabled, Pusha
   *  dynamically imports @shopify/standard-events (via the theme's importmap)
   *  and re-dispatches `PageViewEvent` on each swap. Page-type events
   *  (product_viewed, collection_viewed) are NOT re-fired — the theme's
   *  <s-view-event view-event-trigger="connect"> elements re-fire those on
   *  re-mount. `'auto'` (default) fires only when the import resolves (i.e. the
   *  theme ships standard-events); `false` disables; `true` forces the attempt.
   *  Independent of `shopify` — the two channels don't cross-forward. */
  standardEvents?: boolean | 'auto';
  /** Prefixed custom customer events — the only publish path that reaches web
   *  pixels. Standard event names are fenced (`Shopify.analytics.publish`
   *  returns false for them); custom events are explicitly supported from theme
   *  Liquid and reach "all custom pixels and app pixels". `true` (default) uses
   *  the `pusha` prefix; a string sets your own (use a shared one to let a
   *  single companion pixel serve several soft-nav frameworks); `false`
   *  disables. Nothing consumes these until you add a companion pixel —
   *  see docs/analytics-companion-pixel.md. */
  customEvents?: boolean | string;
  /** Re-fire Shopify's own pageview into Trekkie/Monorail — the pipe behind the
   *  admin's Analytics reports — by calling `ShopifyAnalytics.lib.page(null, …)`
   *  with the destination's identity. MEASURED to work on a published OS 2.0
   *  store: `pageType`/`resourceId` land in `trekkie_storefront_page_view` and
   *  both `storefront_customer_tracking` schemas, and Web Pixels Manager mirrors
   *  it into `storefront_customer_tracking_parity`. Identity is read from a
   *  `<script data-pusha-trekkie-page>` block the theme renders per template —
   *  `ShopifyAnalytics.meta` is never written to.
   *
   *  ⚠ OFF by default and deliberately so. `ShopifyAnalytics` is an undocumented
   *  global outside Shopify's Liquid compatibility guarantee, so it can vanish
   *  without notice. Every access is optional-chained: if it goes, admin
   *  reporting silently undercounts rather than reporting wrong data.
   *
   *  ⚠ Does NOT reach web pixels. Meta/GA4/Klaviyo still need a companion pixel
   *  — see docs/analytics-companion-pixel.md. */
  trekkie?: boolean;
}

export interface PushaConfig {
  /** Per-component opt-out, checked inside initPage(). */
  disabledComponents?: string[];
  /** Global kill switch for PJAX nav. Defaults to true. */
  pjax?: boolean;
  /** Dev-mode diagnostics. Defaults to false. */
  debug?: boolean;
  /** Per-template-type prefetch TTL. */
  prefetchConfig?: PrefetchConfig;
  /** Run leave/enter CSS transitions. Defaults to true. Set false for instant swaps. */
  transitions?: boolean;
  /** Analytics bridge. `true` (default) = Shopify admin + Customer Events
   *  only; `false` = off; an object enables per-bridge control (Shopify,
   *  direct GA4, GTM dataLayer). See AnalyticsConfig. */
  analytics?: boolean | AnalyticsConfig;
  /** PJAX swap target. Defaults to '#MainContent'. */
  containerSelector?: string;
  /** Selector for elements whose first link is warmed as they near the viewport
   *  (collection cards, article tiles). Off unless set — OS 2.0 themes share no
   *  card convention, so there's no safe default. ⚠ Budget it: a long collection
   *  scroll warms one page per card, capped only by the prefetch cache size. */
  prefetchInViewport?: string;
  /** Routes (paths) whose prefetch entries should be flushed on `cart:mutated`. */
  cartStatefulRoutes?: string[];
}

export interface NavMeta {
  /** URL just navigated to. */
  url: string;
  /** value of data-page-type on the container, or empty string. */
  template: string;
  /** true if the HTML came from prefetch cache. */
  cached: boolean;
}

export interface GoOptions {
  /** Request a specific named transition. */
  transition?: string;
  /** Use history.replaceState instead of pushState. */
  replace?: boolean;
  /** Bypass PJAX and full-load the URL. */
  hard?: boolean;
}

export interface SectionInits {
  [handle: string]: (root: HTMLElement) => void;
}

export interface SectionDestroyers {
  [handle: string]: (root: HTMLElement) => void;
}

declare global {
  interface Window {
    theme: {
      config?: PushaConfig;
      sectionInits?: SectionInits;
      sectionDestroy?: SectionDestroyers;
      initPage?: () => void;
    };
    Pusha?: unknown;
    Shopify?: {
      designMode?: boolean;
      analytics?: {
        page?: () => void;
        publish?: (event: string, payload?: unknown) => void;
      };
      currency?: { active: string; rate: string };
      locale?: string;
      formatMoney?: (cents: number, format: string) => string;
    };
    /** Trekkie — Shopify's own storefront analytics client, the pipe behind the
     *  admin's Analytics reports. Undocumented and outside the Liquid
     *  compatibility guarantee, so treat every member as possibly absent. */
    ShopifyAnalytics?: {
      lib?: {
        page?: (name: string | null, props?: Record<string, unknown>) => unknown;
        track?: (event: string, props?: Record<string, unknown>, ...rest: unknown[]) => unknown;
      };
      /** Page identity rendered by Liquid for the CURRENT document. Pusha reads
       *  identity from the theme's serialized block instead, and never writes
       *  here — other scripts on the page read this object. */
      meta?: Record<string, unknown>;
    };
    /** GA4 / Google Ads global. Present when gtag.js is installed in the theme. */
    gtag?: (...args: unknown[]) => void;
    /** GTM data layer. Present when Google Tag Manager is installed. */
    dataLayer?: unknown[];
    __pushaSyncedStyles?: Set<string>;
  }
}
