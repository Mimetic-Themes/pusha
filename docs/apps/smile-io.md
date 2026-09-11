# Smile.io — Loyalty & Rewards

**Status: partly safe.** The launcher and the panel survive. The in-page blocks
probably do not, and Smile publishes no call to repair them. Checked 2026-09-11
against Smile documentation. Not yet tested on a live store.

## What happens on a soft navigation

Smile installs in two places, and only one of them is inside the swap container.

| Part | Where it renders | Result |
| --- | --- | --- |
| App embed — launcher and loyalty panel | Outside the swap container | **Safe** |
| **Points on product page** app block | Inside the swap container | **Probably breaks** |
| **Points on account page** app block | Inside the swap container | **Probably breaks** |
| Manual `sweettooth-points-balance` snippet | Wherever you put it | **Probably breaks in the container** |

### The launcher and the panel are safe

Smile is added as an app embed:

> "Smile must be added as an app embed in your Shopify theme."
> — https://help.smile.io/en/articles/4036186-apply-smile-ui-to-shopify-theme

The embed loads one script:

> `<script async src="https://js.smile.io/v1/smile-ui.js"></script>`
> — https://dev.smile.io/ui/including

An app embed renders outside `#MainContent`. Pusha never swaps it. The launcher
button and the panel it opens stay on screen and stay working after every
navigation. **This is the part most customers touch, and it needs nothing from you.**

### The in-page blocks are the problem

Smile also ships app blocks that a merchant places inside page content:

> "In the Shopify theme editor sidebar, click the **Points on product page** app block."
> — https://help.smile.io/en/articles/8659115-embed-points-on-the-product-page

> "select Template > Add section and then select the **Points on account page** app block"
> — https://help.smile.io/en/articles/8659125-embed-points-on-customer-account

Those live inside the container. Pusha replaces them on every navigation.

**⚠ Smile documents a limitation that looks exactly like our problem:**

> "The **Points on product page** app block isn't supported in Shopify Quick View and
> may display as raw template code instead."
> — https://help.smile.io/en/articles/8659115-embed-points-on-the-product-page

Quick View injects product markup by AJAX. Smile's JavaScript does not run over that
markup, so the block shows its unfilled template. A container swap injects markup the
same way. **We read this as strong evidence the block is filled in by JavaScript and
does not refill itself.** It is an inference from Smile's own limitation note, not a
measurement. Test it before you promise anything.

The older manual snippet has the same shape — a `<span class="sweettooth-points-balance">`
that Smile's JavaScript fills in, and which needs the JavaScript SDK setting turned on.

## Is there a re-init call? No usable one

We read the whole JavaScript SDK and Smile UI reference. Smile publishes a large API
and **no method that re-draws its blocks.**

| Call | What it does | Use it? |
| --- | --- | --- |
| `SmileUI.initialize(options)` | Starts Smile UI. "must be called before you can interact with any other methods" | **No.** The app embed already called it. |
| `Smile.reset()` | "resets the SDK to an uninitialized state, clearing all stored data including the customer session" | **No.** Smile says it is "primarily intended for use during cleanup operations or during development". |
| `SmileUI.ready()` / `SmileUI.customerReady()` | Tell you initialization finished | Useful to wait. Draws nothing. |
| `smile-ui-loaded` DOM event | Fires "when initialization has completed" | Fires once, on the first page. Not per navigation. |

**Do not call `Smile.reset()` on a swap.** It clears the customer session and forces a
full re-initialize. That is worse than a stale points number.

## The fix — read the numbers yourself

Smile has no HTML endpoint and no refresh call, but it has a full data API in the
browser. You fetch the values and write them into the page yourself.

Smile says the SDK "gives you full control over the UI and works well in single-page
and headless setups" — https://dev.smile.io/guides/use-cases/custom-frontend

This is shape 4, with one difference from Judge.me: **Smile returns JSON, not HTML.**
You own the markup. Smile owns the numbers.

### Step 1 — turn on the JavaScript SDK

1. Open your Smile admin.
2. Go to **Settings**, then **Developer tools**.
3. Turn on the **JavaScript SDK** setting.

Smile loads the SDK with Smile UI on Shopify once this setting is on. You can also ask
for it with `includeSdk: true`, but on Shopify the app embed controls initialization.

### Step 2 — add the adapter

This example shows a points balance. Change the selector and the field for other
values.

```js
import { onAfterInit } from '@mimeticthemes/pusha/hooks';

onAfterInit(async (container) => {
  const el = container.querySelector('[data-smile-points-balance]');
  if (!el) return;

  const Smile = window.Smile;
  if (!Smile?.customerPointsWallet) return;   // SDK off, or not loaded yet

  try {
    const wallet = await Smile.customerPointsWallet.get();
    el.textContent = Smile.formatPoints(wallet.points_balance);
  } catch {
    // Leave the old value. A failed request must never stop navigation.
  }
});
```

⚠ **Check the field names against `dev.smile.io/js/resources/customer-points-wallet/object`
before you ship.** We read the method list, not the object shape.

### Step 3 — test it

1. Log in as a customer who has points.
2. Open a product page that shows a points value. Note the number.
3. Go to a second product page. **Do not reload.**
4. The number must be there, and must be right for the new product.
5. Open the launcher. The panel must open and show the same balance.
6. Open the network panel. Confirm you make one Smile request per navigation, not more.

## What is documented

| Question | Answer |
| --- | --- |
| Listens for `shopify:page:view`? | **No.** Nothing in the SDK or UI docs names it. |
| Public re-init call? | **No.** `initialize` starts it; `reset` destroys it. Neither re-draws a block. |
| Public data API? | **Yes** — points wallet, points products, VIP tiers, earning rules, customer. |
| Public HTML endpoint? | **No.** The browser API returns JSON. |
| Mount point for the panel | Created by `smile-ui.js`, outside the container. |
| Mount point for the blocks | Theme app extension blocks, inside the container. Markup not published. |
| SPA guidance? | **Yes, but for a different job** — build your own UI with the SDK. Nothing about the app blocks. |

## Severity

Low to medium.

The launcher, the panel, redemption and referrals all keep working. A customer can
still see their points and spend them. What breaks is the points value printed in the
page — a number that is stale, or a block that shows raw template text.

**Raw template text on a product page is the bad outcome.** It is visible and it looks
broken. If you cannot fix it, remove the app block and rely on the launcher, or add
`data-no-transition` to the links that reach those pages.

## Limits

- **The block markup is not published.** Smile documents how a merchant adds the app
  block, never what HTML it produces. Read your own rendered page to find the selector
  before you write an adapter. The example above invents `data-smile-points-balance`.
- **Customer identity comes from the app embed.** On Shopify, Smile issues the customer
  token during the embed's initialization. A swap does not change the logged-in
  customer. A login or logout does — route those through a full browser navigation.
- **The SDK is behind a setting.** Merchants who never turned on **Developer tools**
  have no `window.Smile` to call. The adapter must check for it, and must do nothing
  when it is absent.
- **Plan gating.** Smile's account-page block and headless use are documented as
  needing a paid plan. Confirm the merchant's plan before you design around the SDK.
- **Nudges and other UI are untested.** Smile ships promotional UI beyond the launcher.
  We did not trace where each piece renders.

## What we could not verify

- **Whether the app blocks are Liquid or JavaScript.** Two Smile help articles returned
  404 to us, and the theme app extension source is not public. The Quick View note is
  our only evidence, and it is indirect.
- **Whether `SmileUI.initialize` can be called twice.** Smile does not say. Do not try
  it on a live store to find out.
- **What `smile-ui-loaded` does on a page where the script already ran.** It is
  documented as firing at the end of initialization, which happens once.
- **Whether the panel holds stale data.** The panel is outside the container and never
  re-mounts, so a points balance changed by a purchase may not refresh until a full
  load. Not tested.

## Sources

- Add Smile to a Shopify theme (app embed) —
  https://help.smile.io/en/articles/4036186-apply-smile-ui-to-shopify-theme
- Points on the product page (app block, Quick View note) —
  https://help.smile.io/en/articles/8659115-embed-points-on-the-product-page
- Points on the customer account (app block) —
  https://help.smile.io/en/articles/8659125-embed-points-on-customer-account
- JavaScript SDK setting — https://help.smile.io/en/articles/4891875-javascript-sdk
- Including Smile UI — https://dev.smile.io/ui/including
- `SmileUI.initialize` — https://dev.smile.io/ui/initializing
- Loaded event (`smile-ui-loaded`) — https://dev.smile.io/ui/events/ui-loaded
- `Smile.reset()` — https://dev.smile.io/js/smile/reset
- Points wallet — https://dev.smile.io/js/resources/customer-points-wallet/get
- Custom frontend guidance — https://dev.smile.io/guides/use-cases/custom-frontend

Full research trail: `pusha-probe/results.md`.
