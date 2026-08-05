# Companion pixel — analytics on client-side navigation

Pusha swaps the page without a document load. Shopify's Web Pixels Manager
initializes once per document and its page-view instrumentation never re-fires,
so on a Pusha storefront every navigation after the first is invisible to
pixels.

This document explains what can and cannot be recovered, and gives you a pixel
that recovers the part that can.

## Why the obvious fix doesn't work

`Shopify.analytics.publish('page_viewed', …)` looks like the answer. It isn't.
From the Web Pixels API docs (`api/web-pixels-api/emitting-data`):

> To ensure the quality of standard events, partners and merchants cannot
> publish standard events. `Shopify.analytics.publish` only exposes the method
> to publish custom events.

The call returns `false`, silently. Re-dispatching `PageViewEvent` through
`@shopify/standard-events` doesn't work either — it is a DOM event vocabulary,
and no pixel subscribes to it. Both were measured against a published store:
both fire once per navigation, both reach nothing.

## What does work

Custom events. Same docs:

> App users and app developers can publish custom customer events from online
> store theme liquid files… When custom customer events are published they can
> be accessed by all custom pixels and app pixels.

So Pusha publishes prefixed custom events on every swap, and a companion pixel
subscribes and forwards them wherever you need. This is on by default:

```js
Pusha.init({
  analytics: {
    customEvents: true,   // default — publishes `pusha:page_viewed` etc.
  },
});
```

Events published on each swap:

| Event | Payload (`customData`) |
| --- | --- |
| `pusha:page_viewed` | `url`, `path`, `title`, `template`, `cached` |
| `pusha:<name>` | whatever the theme serialized (see below) |

Page-type events come from the theme, so Pusha never invents analytics data. Add
one script per template:

```liquid
{%- comment -%} sections/main-product.liquid {%- endcomment -%}
<script type="application/json" data-pusha-analytics-event>
  {
    "name": "product_viewed",
    "data": {
      "productId": {{ product.id | json }},
      "title": {{ product.title | json }},
      "vendor": {{ product.vendor | json }},
      "price": {{ product.selected_or_first_available_variant.price | json }},
      "currency": {{ cart.currency.iso_code | json }}
    }
  }
</script>
```

That publishes as `pusha:product_viewed` on swap.

## Read this before you rely on it

**This does not revive third-party app pixels.** Meta's pixel subscribes to the
standard `product_viewed`. Your `pusha:product_viewed` is a different event that
it has no mapping for — the docs say as much: "if you haven't set up a way for
users to define custom transformation of payloads, then your app pixels might
not be able to parse these custom fields." A merchant running six marketing apps
does not get those six apps back. You get the vendors you wire up yourself.

**This does not feed Shopify admin analytics** — but that has its own route.
Pixels consume the analytics stream; they cannot produce into Shopify's
reporting backend. Admin reporting rides a different pipe (Trekkie/Monorail),
and that one is independently recoverable on a soft navigation: see
`analytics: { trekkie: true }` in the README, with the measurements in
`experiments/monorail-admin-probe.md`. It's a separate decision from this pixel,
and neither substitutes for the other.

**Checkout is unaffected.** Checkout runs as its own document load, so
`checkout_started`, `payment_info_submitted`, and `checkout_completed` fire
natively. The gap is browse events only.

**The line is authored vs. installed.** Not vendor by vendor — no app is a
special case and none is exempt. A pixel you wrote subscribes to `pusha:*` and
works; an app pixel subscribes to the standard name, receives your event, and
ignores it. So the question about a store is whether anything it depends on
needs mid-funnel browse events it didn't wire itself. Retargeting and dynamic
product ads do, and forwarding can't help — those audiences are built inside the
ad account. Browse-abandonment email does too, but that one you *can* wire; see
below.

If a store runs heavy paid acquisition through many installed marketing apps,
Pusha is not a good fit today. Say so before you install it.

## The pixel

Shopify admin → **Settings → Customer events → Add custom pixel**. In a custom
pixel `analytics`, `browser`, and `init` are already deconstructed for you — no
`register()` boilerplate.

This example forwards to PostHog because its project API key is designed to be
public, which keeps v0 free of any server. **Do not put a Meta CAPI token or a
GA4 API secret in here** — custom pixel source is client-visible. Those need
your own collector endpoint; swap `SINK` for it and fan out server-side.

```js
const SINK = 'https://us.i.posthog.com/i/v0/e/';
const KEY = 'phc_REPLACE_ME';

// Hard loads emit Shopify's standard events; Pusha emits the prefixed ones on
// swaps. The two sets are disjoint, so subscribing to both gives full coverage
// with no double-count.
function normalize(event) {
  const d = event.customData || {};
  const loc = event.context && event.context.document && event.context.document.location;
  return {
    url: d.url || (loc && loc.href) || '',
    path: d.path || (loc && loc.pathname) || '',
    title: d.title || (event.context && event.context.document && event.context.document.title) || '',
    template: d.template || '',
    soft: Boolean(event.customData),
    rest: d,
  };
}

function send(name, event) {
  const p = normalize(event);
  browser.cookie.get('_ga').then(function (ga) {
    fetch(SINK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        api_key: KEY,
        event: name,
        distinct_id: event.clientId,
        timestamp: event.timestamp,
        properties: Object.assign({}, p.rest, {
          $current_url: p.url,
          $pathname: p.path,
          title: p.title,
          template: p.template,
          soft_navigation: p.soft,
          ga_client_id: ga || null,
          shopify_client_id: event.clientId,
        }),
      }),
    }).catch(function () {});
  });
}

// Soft navigations (Pusha).
analytics.subscribe('pusha:page_viewed', function (e) { send('$pageview', e); });
analytics.subscribe('pusha:product_viewed', function (e) { send('product_viewed', e); });
analytics.subscribe('pusha:collection_viewed', function (e) { send('collection_viewed', e); });
analytics.subscribe('pusha:search_submitted', function (e) { send('search_submitted', e); });

// Hard loads (Shopify native).
analytics.subscribe('page_viewed', function (e) { send('$pageview', e); });
analytics.subscribe('product_viewed', function (e) { send('product_viewed', e); });
analytics.subscribe('collection_viewed', function (e) { send('collection_viewed', e); });
analytics.subscribe('search_submitted', function (e) { send('search_submitted', e); });
```

Consent is handled for you — the sandbox respects the Customer Privacy API, so
events are withheld when the buyer hasn't consented.

## ⚠ Browse abandonment needs wiring, and fails silently without it

The flow most likely to break unnoticed. Klaviyo's browse-abandonment flow
triggers on its `Viewed Product` metric, delivered by the Klaviyo app pixel —
which is exactly the channel that stops after page one. Mailchimp's product-
retargeting flows have the same shape.

This matters more than it first looks. Owned email is the usual answer to *not*
depending on paid retargeting — so on a Pusha storefront the fallback and the
thing it's replacing break through the same pipe. Nothing errors. The flow just
stops enrolling people, and you find out when someone asks why revenue from it
went flat.

Forward it yourself from the same subscription block:

```js
analytics.subscribe('pusha:product_viewed', function (event) {
  var p = event.data && event.data.productVariant;
  if (!p) return;

  fetch('https://a.klaviyo.com/client/events/?company_id=' + KLAVIYO_PUBLIC_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ /* Viewed Product payload — see below */ }),
  }).catch(function () {});
});
```

Two things to get right, and the second is the hard one:

1. **Payload shape.** Check Klaviyo's current Client APIs reference rather than
   copying a snippet — theirs has changed across versions, and a malformed body
   fails quietly with a 202.
2. **★ Identity.** An event with no profile attached enrolls nobody. Klaviyo
   identifies visitors by its `__kla_id` cookie, which its own JS sets on the
   storefront. The pixel sandbox exposes `browser.cookie`, so you can read it and
   attach the profile — but if the visitor has never identified themselves (no
   email captured yet) there is nothing to enroll, exactly as on a normal store.
   Test with a known-identified visitor or you'll conclude it's broken when it's
   working.

Verify by triggering the flow end to end on a published theme with a real
profile — a `202` from the API only means the request was accepted, not that a
profile was matched or a flow enrolled.

## Verifying it

1. Add a throwaway custom pixel containing only
   `analytics.subscribe('all_events', function (e) { console.log('[pixel]', e.name); });`
2. Load a collection page. You should see `page_viewed` and `collection_viewed`.
3. Click through to a product **without a reload**. You should see
   `pusha:page_viewed` and `pusha:product_viewed`.
4. Walk four or five more navigations and confirm one pair per navigation.

If step 3 shows nothing, check `Shopify.analytics.publish` exists in the console
and that `analytics.customEvents` is not `false`.

> **Note on event names.** The docs are internally inconsistent about whether the
> prefix survives into `event.name` for subscribers — the example publishes
> `my_app:my_custom_event` but shows the callback receiving
> `name: "my_custom_event"`. Subscribe by exact name, as above, rather than
> filtering `all_custom_events` on a prefix, and confirm what `e.name` actually
> contains during step 3.

## A note on the prefix

`customEvents` accepts a string, so you can publish under a namespace other than
`pusha`:

```js
Pusha.init({ analytics: { customEvents: 'softnav' } });
```

Pusha is not the only client-side navigation runtime on Shopify — the same gap
exists for anything built on `partials.apply()`. If soft-nav runtimes agree on
one namespace, a single companion pixel (or a vendor integration) can serve all
of them instead of one per framework. That convention isn't settled yet.
