# Third-party app compatibility

One file per app. Each file tells you what breaks under soft navigation, what does
not, and what to do about it.

**Scope.** These files cover apps that install a theme app extension. They do not
cover apps that only use the Admin API, and they do not cover Script Tag apps, which
a static audit cannot see.

**How to use them.** Run `pusha audit`. Bucket X lists the app blocks in your swap
container. For each app it names, open the file here with the same name. If no file
exists, use [the triage procedure](#triage-a-new-app) below.

## Files

| App | Status | Summary |
| --- | --- | --- |
| [judge-me.md](judge-me.md) | Partly safe | Star ratings and most widgets survive. The review widget needs an API re-fetch — no re-init call exists. |
| [zapiet.md](zapiet.md) | ⚠ Breaks, high severity | Widget goes inert. Checkout data is lost. Fix with `Zapiet.start()`. |
| [klaviyo.md](klaviyo.md) | Partly safe, mixed | Tracking is repairable with `klaviyo.track`. Forms break, and Klaviyo states it does not support this navigation. |
| [loyaltylion.md](loyaltylion.md) | Breaks, documented fix | Every `data-lion-*` component goes blank. Fix with `loyaltylion.ui.refresh()`. |
| [smile-io.md](smile-io.md) | Partly safe | Launcher and panel survive. In-page points blocks probably break, and no re-init call exists. |

---

## The six recovery shapes

An app surface survives a soft navigation in one of six ways. Learn these and you can
triage a new app quickly. Shapes 1-3 were measured (`pusha-probe`); 4 and 5
come from app documentation and are not yet tested on a store. Shape 0 is structural —
it follows from where Shopify renders the code.

**0. The surface is outside the swap container.**
An app embed renders in `layout/theme.liquid`, not in a section. Pusha never swaps it,
so its script loads once and keeps running. Klaviyo's `klaviyo.js`, Smile's launcher
and panel, and LoyaltyLion's whole SDK are all this shape. **Check this first** — it
decides half the question before you read a line of app documentation.

⚠ **Surviving is not the same as staying correct.** Code outside the container that
reads *into* the container goes stale, and nothing tells it to look again. Klaviyo's
*Viewed Product* is the example: the script is alive on every page and fires on none
of them after the first.

**1. The app listens for `shopify:page:view`.**
Pusha sends this event on every swap. The app hears it and starts again. This is the
best shape. It needs nothing from you. Measured to work — see
`pusha-probe/results.md`, run 0.

**2. The app block is a custom element.**
The browser calls `connectedCallback` when the block enters the page. The app starts
again by itself. This also needs nothing from you. Measured to work.

**3. The app has no JavaScript.**
Some blocks are only Liquid. They print a metafield and stop. These blocks always come
back correct, because they have no code to lose. Most Judge.me widgets are this shape.

**4. The app publishes a public API you can call from the browser.**
You fetch again after each swap and put the result back in the page.

- **It returns HTML** — the app keeps its data and its rendering, and you control only
  the timing. Judge.me's review widget is this variant.
- **It returns JSON** — the app keeps its data, and you own the markup. More work, and
  you must keep your markup in step with theirs. Smile is this variant.

This is the newest shape and the most work, but many apps qualify.

**5. The app publishes a re-init call you can make.**
Some apps expose a method or event that reloads their widget. They usually built it
for AJAX cart drawers, not for navigation, but a reload call is a reload call. Zapiet
is this shape: `Zapiet.start(config)`, or dispatch `zapiet:start`. This is the
cheapest fix when it exists, because you write two lines and the app does the work.

**If an app fits none of these, you cannot repair it from the theme.** Add
`data-no-transition` to the links that go to those pages, or turn Pusha off for those
routes.

---

## Triage a new app

Do these steps in order. Stop when you get an answer.

1. **Find out where each part of the app renders.** An app embed is outside the
   container and survives. An app block or an app section is inside it and is swapped.
   Most apps have both, and only the second kind needs work. This is shape 0.
   `pusha audit` prints the split for you.
2. **Open the app's theme documentation.** Search for `shopify:page:view` and for
   `custom element`. A match means shape 1 or 2. You are done.
3. **Read the block markup the app documents.** If the markup contains a Liquid
   metafield and no script, the block is shape 3. It is safe.
4. **Open the app's API documentation.** Look for a public token and for an endpoint
   that returns HTML or JSON. A match means shape 4. Write the adapter.
5. **Search their JS API docs for a reload call** — `start`, `reload`, `refresh`,
   `init`. Apps often ship one for AJAX cart drawers. That is shape 5.
6. **If none match, test it.** Install the app on a test store with Pusha. Navigate
   twice. Look at the block.

**Record what you find in a new file here.** Use `judge-me.md` as the model.

---

## Rules for these files

- **Say what you measured. Say what you did not.** Mark every unverified claim.
- **Give the source.** Link the app's own documentation for each fact.
- **Separate what survives from what breaks.** Merchants need the severity, not only
  the fix.
- **Write the procedure in Simplified Technical English.** Short sentences. Active
  voice. One word for one idea.
