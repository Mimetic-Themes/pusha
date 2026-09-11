# LoyaltyLion

**Status: breaks, and has a documented fix.** Checked 2026-09-11 against LoyaltyLion
documentation. Not yet tested on a live store.

The SDK survives a soft navigation. Every component it draws does not. LoyaltyLion
publishes the exact call you need — `window.loyaltylion.ui.refresh()`.

## What happens on a soft navigation

LoyaltyLion installs in two parts, and the parts behave differently.

| Part | Where it renders | Result |
| --- | --- | --- |
| App embed — loads and starts the SDK | Outside the swap container | **Survives** |
| Every `data-lion-*` component | Inside the swap container | **Breaks** |

The app embed is the good news:

> "you'll enable the LoyaltyLion App Embed Block on your store. This will load the
> LoyaltyLion SDK"
> — https://developers.loyaltylion.com/docs/installation/shopify

An app embed renders outside `#MainContent`. Pusha never swaps it. So
`window.loyaltylion` stays alive and stays initialized after every navigation.

**This matters, because you must not start the SDK twice.** LoyaltyLion is explicit:

> "`loyaltylion.init` should only be called once per page load."
> — https://developers.loyaltylion.com/sdk/initialize-sdk

> "Cannot call lion.init more than once"
> — https://developers.loyaltylion.com/sdk/installation

The components are the bad news. Each one is a plain div with a data attribute:

| Component | Markup |
| --- | --- |
| Loyalty page | `<div data-lion-integrated-page=""></div>` |
| Loyalty panel | `<div data-lion-account></div>` |
| Panel link (modal) | `<a data-lion-account-link>` |
| Points for a product | an element with `data-lion-points-for` |
| Rules, rewards, history, challenges, tiers | the same shape, one attribute each |

They are not custom elements. The browser starts nothing when they enter the page.
The SDK fills them in one time, when it starts. After a swap the empty divs come
back and stay empty.

**A `data-lion-account-link` in your header survives**, because the header is outside
the container. The same link inside page content does not.

## The fix — call `loyaltylion.ui.refresh()`

LoyaltyLion documents this call, and documents the exact reason you need it:

> "The SDK doesn't automatically observe our components or their inputs for changes."
> — https://developers.loyaltylion.com/sdk/live-updating

The same page lists "remove the component, render it again, then call
`window.loyaltylion.ui.refresh()`" as a supported flow. A container swap is that
flow. **This is the closest fit to our problem that any app documents.**

### Step 1 — add the adapter

Add this to your theme JavaScript:

```js
import { onAfterInit } from '@mimeticthemes/pusha/hooks';

onAfterInit((container) => {
  // Do nothing if this page has no LoyaltyLion component.
  if (!container.querySelector('[data-lion-integrated-page], [data-lion-account], [data-lion-account-link], [data-lion-points-for]')) {
    return;
  }

  // Never call loyaltylion.init here. The app embed did that already.
  window.loyaltylion?.ui?.refresh?.();
});
```

**Use the optional chain.** If LoyaltyLion is removed, or the SDK has not finished
loading, the call must do nothing. It must never stop navigation.

### Step 2 — test it

1. Open your loyalty page. Confirm the points, the rules and the rewards are there.
2. Go to a product page. **Do not reload.**
3. Go back to the loyalty page. Do not reload.
4. The points, the rules and the rewards must be there again.
5. Open a product page that shows points for that product. Confirm the number.
6. Go to a second product page. The number must change to the new product.

**Step 6 is the real test.** A component can come back with the previous product's
number, which looks correct and is wrong.

## What is documented

| Question | Answer |
| --- | --- |
| Listens for `shopify:page:view`? | **No.** Nothing in the SDK docs names it. |
| Public re-init call? | **Yes** — `window.loyaltylion.ui.refresh()`. |
| Can you call `init` again? | **No.** It throws. |
| Mount points | Plain divs with `data-lion-*` attributes. Not custom elements. |
| Server-rendered part? | **None.** Every component is drawn by JavaScript. |
| Public HTML endpoint? | **No.** The headless API returns JSON and needs a session token. |
| SPA guidance? | **None.** The word does not appear in the SDK docs. |

## Severity

Medium. Lower than Zapiet, higher than a badge.

An inert LoyaltyLion component shows nothing. It does not write bad data and it does
not block checkout. The customer sees a blank space where their points were.

**One case is worse.** `shopifyFrontend` is a documented configuration option that
"turns off some features which depend on those APIs, such as in-cart rewards". If your
store applies rewards in the cart, test the cart page by hand before you ship. We have
not traced how in-cart rewards re-apply after a swap.

## Limits

- **`ui.refresh()` is documented for a different job.** LoyaltyLion wrote it for a
  component whose attribute value changed, or one you removed and added back. A
  container swap replaces every component at once. The call should still work — it is
  a re-scan — but **nobody has confirmed it.** Test it.
- **The timing is not documented.** `refresh()` may return before the components are
  drawn. If you need to act after the draw, use a MutationObserver on the component.
  LoyaltyLion publishes no ready event for a refresh.
- **A refresh may cost a request.** LoyaltyLion does not publish a rate limit and does
  not say whether `refresh()` re-fetches customer data. Watch the network panel while
  you navigate.
- **Customer authentication is separate.** The `auth` object passed to `init` carries a
  server-generated token with a date. It is set once, at init, and the app embed keeps
  it. A swap does not change it. A login or logout does — route those through a full
  browser navigation.
- **The legacy install is not an app embed.** Stores that installed before December
  2023 have a `loyaltylion.liquid` file included from `theme.liquid`. That is still
  outside the container, so it still survives. Migrating to the app embed is
  LoyaltyLion's recommendation, not a Pusha requirement.

## What we could not verify

- Whether `ui.refresh()` is safe to call on a page with no components. The adapter
  above guards for this. Remove the guard only after you test without it.
- Whether the loyalty panel modal (`data-lion-account-link`) needs the refresh, or
  rebinds by delegation. Test a link inside page content, not only one in the header.
- Whether LoyaltyLion's customer account extensions are affected. They render in
  Shopify's customer accounts, which Pusha does not swap.

## Sources

- SDK installation — https://developers.loyaltylion.com/sdk/installation
- Initialize the SDK — https://developers.loyaltylion.com/sdk/initialize-sdk
- Live updating (`ui.refresh`) — https://developers.loyaltylion.com/sdk/live-updating
- Configuration — https://developers.loyaltylion.com/sdk/configuration
- Loyalty page component — https://developers.loyaltylion.com/sdk/embeddable-components/loyalty-page
- Loyalty panel component — https://developers.loyaltylion.com/sdk/embeddable-components/loyalty-panel
- Shopify installation — https://developers.loyaltylion.com/docs/installation/shopify
- App embed install — https://help.loyaltylion.com/en/articles/8608718-enable-loyaltylion-via-shopify-app-embeds

Full research trail: `pusha-probe/results.md`.
