# Klaviyo

**Status: partly safe, and mixed.** Tracking survives with two lines of theme code.
Forms do not, and Klaviyo says it does not support this kind of navigation. Checked
2026-09-11 against Klaviyo documentation. Not yet tested on a live store.

**⚠ Read [Tracking](#tracking--better-news-than-we-wrote-down) first.** It corrects a
claim in Pusha's own README.

## What happens on a soft navigation

| Part | Where it renders | Result |
| --- | --- | --- |
| App embed — `klaviyo.js` | Outside the swap container | **Survives** |
| The `klaviyo` object and its methods | `window` | **Survives** |
| *Active on Site* / *Viewed Product* tracking | Runs when the document loads | **Stops after the first page** |
| **Klaviyo Embedded Form** app section | Inside the swap container | **Breaks** |
| Back in stock trigger (`klaviyo-bis-trigger`) | Inside the swap container | **Probably breaks** |
| Popups and flyouts | Drawn by `klaviyo.js` over the page | **Survive, but stop re-triggering** |

Klaviyo installs as an app embed:

> "Klaviyo's onsite JavaScript, known as Klaviyo.js, is automatically added ... through
> the Klaviyo app embed if it's toggled on."
> — https://help.klaviyo.com/hc/en-us/articles/360020342232

An app embed renders outside `#MainContent`. Pusha never swaps it. `window.klaviyo`
stays alive, and every method on it stays callable. **The tooling survives. What stops
is the thing that called it.**

## Tracking — better news than we wrote down

Klaviyo splits its Shopify events across two channels, and says so plainly:

> "Shopify-branded tracking events are tracked via a Shopify pixel, while gear events
> are tracked by Klaviyo via a snippet installed by our app embed"
> — https://help.klaviyo.com/hc/en-us/articles/4425956184731

*Active on Site* and *Viewed Product* are gear events. **They come from `klaviyo.js`,
not from the web pixel.**

### Why this matters

Pusha's README says browse abandonment breaks because *Viewed Product* is "delivered by
its app pixel — the exact channel that stops". **On the evidence above that is the
wrong channel, and the fix is much cheaper than the README implies.** The outcome is
still a loss — `klaviyo.js` fires *Viewed Product* when the document loads, and under
Pusha the document loads once — but the repair is two lines of theme code, not a
companion pixel.

⚠ **This is a documentation reading, not a measurement.** Nobody has watched Klaviyo's
network traffic across a soft navigation on a published store. Do that before you
change the README. The probe rig is the place for it.

Events that *are* pixel-tracked — Klaviyo names *Added to Cart* and *Viewed Collection* —
are on the channel Pusha cannot reach. Nothing here repairs those. See the README's
"Analytics & tracking" section.

### The fix — re-fire the event yourself

`klaviyo.track` is public, documented, and built for exactly this:

> `track(event: string, properties?: Object, callback?: Function)`

> you can "identify the customer as well as track any onsite event without having to
> reload the page"
> — https://developers.klaviyo.com/en/docs/introduction_to_the_klaviyo_object

#### Step 1 — print the product data into the page

Add this to your product section, inside the swap container:

```liquid
{%- if template.name == 'product' -%}
  <script type="application/json" data-klaviyo-viewed-item>
    {{ product | json }}
  </script>
{%- endif -%}
```

**Put it inside the container.** A swap must bring the new product's data with it.

#### Step 2 — add the adapter

Add this to your theme JavaScript:

```js
import { onAfterInit } from '@mimeticthemes/pusha/hooks';

onAfterInit((container, meta) => {
  if (meta.template !== 'product') return;

  const node = container.querySelector('[data-klaviyo-viewed-item]');
  if (!node || !window.klaviyo) return;

  let product;
  try {
    product = JSON.parse(node.textContent);
  } catch {
    return;
  }

  // ⚠ Check the property names against Klaviyo's Viewed Product reference
  // before you ship. Klaviyo expects its own key names, not Shopify's.
  window.klaviyo.track('Viewed Product', {
    ProductName: product.title,
    ProductID: product.id,
    SKU: product.variants?.[0]?.sku,
    URL: window.location.href,
    Categories: product.tags,
    ImageURL: product.featured_image,
    Price: product.price / 100,
  });
});
```

**Do not re-fire on the first page.** `klaviyo.js` already sent that one. `onAfterInit`
does not run on the initial load, so this is correct as written — but confirm it in the
network panel, because a duplicate *Viewed Product* inflates the metric and can double
a browse-abandonment flow.

#### Step 3 — test it

1. Open a product page. Look in the network panel for the Klaviyo request.
2. Go to a second product page. **Do not reload.**
3. You must see one more Klaviyo request, carrying the second product.
4. Open Klaviyo. Go to the profile's activity feed.
5. Both products must appear, as two separate *Viewed Product* events.

**Step 5 is the real test.** A request that leaves the browser is not the same as an
event Klaviyo records against a profile.

## Forms — Klaviyo says it does not support this

The **Klaviyo Embedded Form** is an app section a merchant adds inside page content:

> "In the left-hand menu under *Apps*, select **Add section > Apps > Klaviyo Embedded Form**."
> — https://help.klaviyo.com/hc/en-us/articles/32004602396443

It is inside the container. Pusha replaces it. `klaviyo.js` does not draw it again.

Klaviyo's position is on the record:

> "at this time, Klaviyo doesn't support SPA, so this use case is beyond the scope of
> Community/Support."
> — a Klaviyo employee,
> https://community.klaviyo.com/developer-group-64/issue-klaviyo-embed-forms-only-appearing-once-per-session-in-next-remix-gatsby-etc-9574

**There is no supported fix.** Three options, in order of preference.

### Option 1 — move the form out of the container

Put the signup form in the footer or another region outside `#MainContent`. It then
renders once and lives for the whole session. **This is the only option with no
unknowns.** Take it when the form does not need to be on a specific page.

### Option 2 — trigger a popup instead of an embed

Klaviyo documents a public trigger for popup and flyout forms:

> `window._klOnsite.push(['openForm', 'FormID']);`
> — https://developers.klaviyo.com/en/docs/how_to_custom_trigger_a_popup_or_flyout_form

Klaviyo notes the `push` form "can execute before Klaviyo.js loads", while
`_klOnsite.openForm(['FormID'])` "will only execute if Klaviyo.js has loaded". Use
`push`.

```js
import { onAfterInit } from '@mimeticthemes/pusha/hooks';

onAfterInit((container, meta) => {
  if (meta.template !== 'collection') return;
  window._klOnsite = window._klOnsite || [];
  window._klOnsite.push(['openForm', 'YOUR_FORM_ID']);
});
```

⚠ **Klaviyo's own display rules still apply, and they are session-based.** A form set
to show once per session shows once, whatever you call. Expect this to fight you.

### Option 3 — the community workaround. Not supported. Read the warning.

Developers report forcing a re-evaluation with an internal Klaviyo event:

```js
window.dispatchEvent(new CustomEvent('onsite-event-publish', {
  detail: {
    type: 'PAGE_CHANGE',
    payload: { currentPageUrl: location.href },
  },
}));
```

**This is reverse-engineered, undocumented, and unsupported.** Klaviyo can remove it in
any release, without notice and without an error. It is in this file because you will
find it anyway, and you should find the warning with it.

**Do not ship it to a client store** unless the client accepts that it can stop working
silently. If you use it, monitor the form's submission rate — that is the only signal
you will get.

## Back in stock

Klaviyo renders the "Notify me when available" button from an element you mark:

> "Add this attribute to the specific HTML element where you want the 'Notify me'
> button to be rendered" — using the `klaviyo-bis-trigger` class
> — https://help.klaviyo.com/hc/en-us/articles/38767539287323

That element is on the product page, inside the container. `klaviyo.js` attaches to it
when the document loads. After a swap the element comes back unattached.

**We did not find a documented re-attach call.** Treat back in stock as broken until you
test it. A sold-out product with a dead button loses a signup and shows nothing wrong.

## What is documented

| Question | Answer |
| --- | --- |
| Listens for `shopify:page:view`? | **No.** Nothing in Klaviyo's docs names it. |
| Public re-init call? | **No.** But `klaviyo.track` and `openForm` let you drive it. |
| Official SPA support? | **No** — stated by a Klaviyo employee. |
| Public API in the browser | `track`, `identify`, `trackViewedItem`, `openForm`, `account`, `cookieDomain`, `isIdentified`, `push`. |
| Tracking channel | Gear events (*Active on Site*, *Viewed Product*) — the app embed's snippet. Shopify-branded events — the web pixel. |
| Mount point for forms | A plain div in an app section. Not a custom element. |

## Severity

Medium for tracking. **Recoverable, and it fails silently** — the flow just stops
sending. Wire the adapter and check the profile feed.

Medium for forms. A signup form that never shows costs list growth every day, and
nothing in the store looks broken.

Low for popups, if you accept they trigger less often.

## Limits

- **Every claim here is read from documentation.** Nothing is measured on a store.
  Klaviyo's channel split is the load-bearing fact and it deserves a probe run.
- **`trackViewedItem` is a second, separate call.** It feeds Klaviyo's recently-viewed
  block, not the *Viewed Product* metric. If your store uses that block, fire both.
- **Identity is not our problem here, and that is lucky.** `klaviyo.js` keeps the
  profile cookie for the session. A swap does not disturb it. A login does — route
  customer-account navigations through a full browser navigation.
- **Consent tooling is untested.** Stores using a consent banner to gate `klaviyo.js`
  may load it after the first navigation. The adapter's `if (!window.klaviyo) return`
  guard handles the absence, but the missed events are gone.
- **SMS checkout blocks are out of scope.** They render on checkout and order status
  pages, which Pusha never touches.

## What we could not verify

- **Whether *Viewed Product* actually stops.** It is the obvious consequence of a
  once-per-document snippet, and we did not watch it happen.
- **Whether re-firing creates duplicates.** `onAfterInit` does not run on the first
  load, so it should not. Confirm in the network panel.
- **Klaviyo's exact *Viewed Product* property names.** The adapter above uses the shape
  from Klaviyo's own example. Check their current reference.
- **Whether the back in stock button can be re-attached.** No documented call was found.
- **How long `onsite-event-publish` keeps working.** It is internal. Assume it can stop.

## Sources

- Onsite tracking for Shopify, and the pixel-vs-snippet split —
  https://help.klaviyo.com/hc/en-us/articles/4425956184731
- Manually installing Klaviyo.js —
  https://help.klaviyo.com/hc/en-us/articles/360020342232
- The `klaviyo` object API —
  https://developers.klaviyo.com/en/docs/introduction_to_the_klaviyo_object
- Custom-triggering a popup or flyout —
  https://developers.klaviyo.com/en/docs/how_to_custom_trigger_a_popup_or_flyout_form
- Embed form on Shopify —
  https://help.klaviyo.com/hc/en-us/articles/32004602396443
- Back in stock form —
  https://help.klaviyo.com/hc/en-us/articles/38767539287323
- Viewed Product troubleshooting —
  https://help.klaviyo.com/hc/en-us/articles/4416172774939
- "Klaviyo doesn't support SPA", plus the community workaround —
  https://community.klaviyo.com/developer-group-64/issue-klaviyo-embed-forms-only-appearing-once-per-session-in-next-remix-gatsby-etc-9574

Full research trail: `pusha-probe/results.md`.
