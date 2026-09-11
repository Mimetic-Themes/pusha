# Zapiet — Store Pickup + Delivery

**Status: breaks, but has a documented fix.** Checked 2026-09-11 against Zapiet
documentation. Not yet tested on a live store.

**⚠ Severity: high.** This is not a cosmetic widget. Read [Severity](#severity)
before you put Pusha on a store that uses it.

## What happens on a soft navigation

The widget mounts into a plain `<div id="storePickupApp">`. It is not a custom
element. Its calendar, location picker and time picker are built by JavaScript. That
JavaScript runs one time, on the first page.

After a swap the div comes back empty. The buyer cannot choose pickup or delivery.

Zapiet also says the selection clears by itself:

> "When the cart page is left or reloaded, the widget also refreshes and clears the
> customer's selection."
> — https://support.zapiet.com/en/articles/12577087-restoring-widget-selection

## The fix — call `Zapiet.start()`

Zapiet publishes a public method to reload the widget:

> "The following method can be used to reload the widget. Primarily used for ajax cart
> support.
> `Zapiet.start(ZapietWidgetConfig);`"
> — https://docs.zapiet.com/javascript-api/methods

There is an event form too. Zapiet's own cart-drawer guide uses it:

```js
document.dispatchEvent(new CustomEvent('zapiet:start'));
```
— https://support.zapiet.com/en/articles/10301708-slide-cart-drawer-by-amp

### Step 1 — add the adapter

Add this to your theme JavaScript:

```js
import { onAfterInit } from '@mimeticthemes/pusha/hooks';

onAfterInit((container) => {
  // Zapiet mounts into this div. If it is not on the page, do nothing.
  if (!container.querySelector('#storePickupApp')) return;

  // The event form needs no config object and is what Zapiet's own
  // cart-drawer guide uses.
  document.dispatchEvent(new CustomEvent('zapiet:start'));
});
```

### Step 2 — test it, on the cart page

1. Open a product page. Add a product to the cart.
2. Go to the cart page. **Do not reload.**
3. Look at the widget. The calendar and the location picker must be there.
4. Choose a delivery method, a date and a time.
5. Open devtools. Run `fetch('/cart.js').then(r => r.json()).then(c => console.log(c.attributes))`.
6. You must see `Checkout-Method`, and a date and a time.
7. Go to checkout. Confirm the delivery rates are correct.

**Step 6 is the real test.** The widget can look correct and still write nothing.

## Severity

An inert Zapiet widget writes no cart attributes and no `_ZapietId` line item
property. Zapiet's rates engine needs that property:

> "At least one item in your customers basket must contain a valid \_ZapietId line
> item property otherwise rates will fail to generate correctly."
> — https://docs.zapiet.com/guides/zapiet_id

Two failure modes, both documented by Zapiet:

- **The checkout button stays locked.** The buyer cannot complete the order.
- **The checkout button unlocks without data.** Orders "come through without any
  attributes from Zapiet" — no pickup location, no delivery window, no fulfilment
  instruction. The merchant finds out when the order needs picking.
  — https://support.zapiet.com/en/articles/7995066-theme-troubleshooting

**Do not put Pusha on a Zapiet store until you have tested the cart page by hand.**
Until then, add `data-no-transition` to every link that goes to the cart.

## What is documented

| Question | Answer |
| --- | --- |
| Listens for `shopify:page:view`? | **No.** Its event list uses no `shopify:` prefix. |
| Public re-init call? | **Yes** — `Zapiet.start(config)` and the `zapiet:start` event. |
| AJAX guidance? | **Yes, but only for cart drawers and quantity changes.** |
| Mount point | `<div id="storePickupApp">` — a plain div, not a custom element. |
| Server-rendered part? | **None.** The widget UI is all JavaScript. |
| Persistence | Cart attributes (`Checkout-Method`, `Pickup-Date`, …) plus the `_ZapietId` line item property. |
| Public HTML endpoint? | **No.** The REST API returns JSON and needs a per-merchant key. |

## Limits

- **The documented AJAX scope is narrower than our problem.** Zapiet's guidance covers
  a cart drawer re-rendering or a quantity change on the same page. It does not cover
  a swap from one template to another. `Zapiet.start()` may still work — it is a
  reload call — but **nobody has confirmed it**. Test it.
- **`ZapietWidgetConfig` is not documented.** The event form avoids needing it. If the
  event form fails, you have no documented config shape to fall back on.
- **Selection restore has gaps.** Zapiet's opt-in restore is "not compatible with the
  Checkout widget or the Checkout delivery options widget", and cannot restore if the
  cart contents changed or the slot is gone.
- Two per-theme guides (Craft, Symmetry) now redirect to the help-centre home and
  could not be read.

## Sources

- JS methods — https://docs.zapiet.com/javascript-api/methods
- Events — https://docs.zapiet.com/javascript-api/events
- `_ZapietId` — https://docs.zapiet.com/guides/zapiet_id
- Cart attributes — https://docs.zapiet.com/guides/note-attributes
- Theme troubleshooting — https://support.zapiet.com/en/articles/7995066-theme-troubleshooting
- Cart drawer fix — https://support.zapiet.com/en/articles/10301708-slide-cart-drawer-by-amp
- Selection restore — https://support.zapiet.com/en/articles/12577087-restoring-widget-selection

Full research trail: `pusha-probe/results.md`.
