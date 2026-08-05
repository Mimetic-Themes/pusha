# Monorail probe — does soft navigation reach Shopify admin analytics?

Answers two questions in about 30 minutes, on any classic (non new-Liquid) OS 2.0
storefront. **Pusha does not need to be installed** — the soft navigation is
simulated in the console, which isolates the analytics question from the runtime.

1. Does calling `Shopify.analytics.page()` after a `pushState` actually send a
   Trekkie/Monorail pageview?
2. If it does, is the payload **correct**, or does it carry the previous page's
   identity because `ShopifyAnalytics.meta` was never updated?

Question 2 is the one that matters. Pusha calls bare `analytics.page?.()`
(`src/analytics.ts:128`) and never touches `ShopifyAnalytics.meta`, so the
suspicion is that every soft nav reports the right URL with the wrong
`pageType`/`resourceId` — wrong data rather than missing data.

## Venue

Any published Shopify storefront on a classic theme that you can browse. It does
not need to be yours and it does not need Pusha. Confirm it's classic:
`window.ShopifyAnalytics?.lib` should exist. If it's undefined you're on
new-Liquid — different problem, wrong venue.

Do this in a normal browser window, by hand. Not Playwright.

## Instrument — paste into the console first

Taps every transport Trekkie might use and logs the decoded Monorail payloads.
Survives navigation only if you re-paste, so paste again after any hard load.

```js
(() => {
  if (window.__monorailTap) { console.log('[monorail] tap already installed'); return; }
  window.__monorailTap = [];

  const isMonorail = (u) => String(u ?? '').includes('monorail-edge.shopifysvc.com');

  const record = (via, raw) => {
    let parsed = null;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : null; } catch { /* not JSON */ }
    const events = parsed?.events ?? (parsed ? [parsed] : []);
    for (const e of events) {
      const p = e?.payload ?? {};
      const row = {
        via,
        schema: e?.schema_id,
        url: p.url ?? p.href ?? p.document_location,
        pageType: p.page_type ?? p.pageType,
        resourceId: p.resource_id ?? p.resourceId,
      };
      window.__monorailTap.push(row);
      console.log('[monorail]', row);
    }
    if (!events.length) {
      window.__monorailTap.push({ via, raw: String(raw).slice(0, 300) });
      console.log('[monorail] (unparsed)', via, String(raw).slice(0, 300));
    }
  };

  const beacon = navigator.sendBeacon?.bind(navigator);
  if (beacon) {
    navigator.sendBeacon = (url, data) => {
      if (isMonorail(url)) {
        if (data instanceof Blob) data.text().then((t) => record('sendBeacon', t));
        else record('sendBeacon', data);
      }
      return beacon(url, data);
    };
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (isMonorail(url)) record('fetch', init?.body ?? (input?.body ?? ''));
    return origFetch(input, init);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    this.__monorail = isMonorail(u);
    return origOpen.call(this, m, u, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__monorail) record('xhr', body);
    return origSend.call(this, body);
  };

  console.log('[monorail] tap installed — window.__monorailTap collects rows');
})();
```

Also open DevTools → Network, tick **Preserve log**, and filter on
`monorail-edge` as a cross-check.

## Step 1 — baseline on a hard load

Load a **collection** page fresh. Paste the tap. Reload once so the tap is live
before Trekkie fires.

Record:

```js
window.__monorailTap;                       // expect a page-view row
window.ShopifyAnalytics.meta.page;          // { pageType: 'collection', resourceId: … }
```

Fill in the collection row of the results table below.

## Step 2 — baseline on a product page

Hard load a **product** page. Re-paste the tap, reload, then record the same two
things. You now know what a correct product pageview looks like, and you have the
destination's real meta for step 4.

Save the product's meta for later:

```js
copy(JSON.stringify(window.ShopifyAnalytics.meta));   // paste into a scratch file
```

## Step 3 — simulate what Pusha does today

Go back to the **collection** page, hard load, paste the tap. Then simulate a
soft navigation to the product, exactly the way Pusha does — URL changes, nothing
else:

```js
window.__monorailTap.length = 0;
history.pushState({}, '', '/products/YOUR-PRODUCT-HANDLE');
Shopify.analytics.page();          // if absent, use: ShopifyAnalytics.lib.page()
```

Then inspect:

```js
window.__monorailTap;               // did anything send?
window.ShopifyAnalytics.meta.page;  // ← the whole question
```

**What to look for.** If `meta.page.pageType` still says `collection` while the
URL says `/products/…`, the staleness is confirmed and Pusha has been mislabelling
every soft navigation. If a Monorail row appeared but its `pageType`/`resourceId`
match the *collection*, that's the same finding from the wire side.

## Step 3.5 — does `pageProps` alone carry the page identity?

Run this **before** step 4. It separates two things that are easy to conflate:
passing your own payload to an undocumented method, versus mutating a global
that other scripts on the page read. The first has no side effects on anyone
else; the second does. If this step works, step 4 is unnecessary.

Still on the collection page. Do **not** touch `ShopifyAnalytics.meta`:

```js
window.__monorailTap.length = 0;
ShopifyAnalytics.lib.page(null, {
  path: location.pathname,
  url: location.href,
  pageType: 'product',
  resourceId: /* the product id you noted in step 2 */,
});
window.__monorailTap;
```

If the row carries `pageType: 'product'` and the right `resourceId`, **stop
here** — Trekkie reads identity from the props argument, and Pusha can be correct
without writing to shared state. That's a materially smaller commitment than
step 4 and it's the only variant worth considering for a shipped path.

If the row still reports the collection, identity comes from the global and the
only way to fix it is the mutation in step 4 — which is the decision already made
against.

## Step 4 — does the meta swap fix it?

Still on the collection page after step 3. Apply the destination meta the way
Octavian's `syncShopifyAnalyticsFromDocument()` does — preserve `currency`,
replace the rest — then fire:

```js
window.__monorailTap.length = 0;
const destMeta = /* paste the JSON you copied in step 2 */;
const currency = window.ShopifyAnalytics.meta?.currency;
window.ShopifyAnalytics.meta = currency ? { currency, ...destMeta } : { ...destMeta };
ShopifyAnalytics.lib.page(null, { path: location.pathname, url: location.href });
window.__monorailTap;
```

If this row now carries the product's `pageType` and `resourceId`, the fix is
confirmed and it needs no HTML parsing — Pusha can serialize the destination meta
per template in Liquid (`data-pusha-trekkie-meta`, same pattern as
`data-pusha-analytics-event`) and assign it before calling `page`.

## Results

| Step | URL | `meta.page.pageType` | Monorail row? | Row `pageType` / `resourceId` |
| --- | --- | --- | --- | --- |
| 1 hard collection | | | | |
| 2 hard product | | | | |
| 3 soft nav, bare `page()` | | | | |
| 3.5 soft nav, `pageProps` only | | | | |
| 4 soft nav, meta swapped | | | | |

## Reading the outcome

| Pattern | Meaning | Next |
| --- | --- | --- |
| Step 3 sends nothing at all | `page()` is a no-op without a real document load | Admin parity needs the full replay; escalate to the A/B/C session test |
| Step 3 sends, but with stale `pageType` | **Expected.** Pusha reports wrong page identity today | Real bug — either drop the call or fix it per 3.5 |
| Step 3.5 correct | Identity rides `pageProps`; no shared-global write needed | The only variant worth considering for a shipped path |
| Step 3.5 wrong, step 4 correct | Identity comes from the global; correctness requires mutating it | Declined by decision — drop the call instead and let admin undercount |
| Step 4 still wrong | Trekkie needs more than meta + pageProps | Only bootstrap replay or WPM capture would do it — lab only |

## Caveats

- A Monorail row proves the event was **sent**, not that admin reporting counts
  it. Only the A/B/C session experiment on a store you own answers that. This
  probe is the cheap precondition, not the verdict.
- `ShopifyAnalytics.lib.page()` is an undocumented-but-long-stable global. Stable
  is not the same as supported — don't describe it as documented in any writeup.
- Trekkie batches and debounces. If a row doesn't appear immediately, wait a few
  seconds before concluding nothing sent.
- Ad blockers and tracking protection will silently eat Monorail requests. Run
  with everything disabled, and confirm step 1 produces a row before trusting any
  later "nothing sent" result.
