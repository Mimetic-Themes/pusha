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

---

## The five recovery shapes

An app block survives a soft navigation in one of five ways. Learn these and you can
triage a new app quickly. Shapes 1-3 were measured (`~/Work/pusha-probe`); 4 and 5
come from app documentation and are not yet tested on a store.

**1. The app listens for `shopify:page:view`.**
Pusha sends this event on every swap. The app hears it and starts again. This is the
best shape. It needs nothing from you. Measured to work — see
`~/Work/pusha-probe/pusha-probe/results.md`, run 0.

**2. The app block is a custom element.**
The browser calls `connectedCallback` when the block enters the page. The app starts
again by itself. This also needs nothing from you. Measured to work.

**3. The app has no JavaScript.**
Some blocks are only Liquid. They print a metafield and stop. These blocks always come
back correct, because they have no code to lose. Most Judge.me widgets are this shape.

**4. The app publishes a public API that returns HTML.**
You fetch the HTML again after each swap and put it back in the page. The app keeps its
data and its rendering. You control only the timing. This is the newest shape and the
most work, but many apps qualify.

**5. The app publishes a re-init call you can make.**
Some apps expose a method or event that reloads their widget. They usually built it
for AJAX cart drawers, not for navigation, but a reload call is a reload call. Zapiet
is this shape: `Zapiet.start(config)`, or dispatch `zapiet:start`. This is the
cheapest fix when it exists, because you write two lines and the app does the work.

**If an app fits none of these, you cannot repair it from the theme.**

**If an app fits none of these, you cannot repair it from the theme.** Add
`data-no-transition` to the links that go to those pages, or turn Pusha off for those
routes.

---

## Triage a new app

Do these steps in order. Stop when you get an answer.

1. **Open the app's theme documentation.** Search for `shopify:page:view` and for
   `custom element`. A match means shape 1 or 2. You are done.
2. **Read the block markup the app documents.** If the markup contains a Liquid
   metafield and no script, the block is shape 3. It is safe.
3. **Open the app's API documentation.** Look for a public token and for an endpoint
   that returns HTML. A match means shape 4. Write the adapter.
4. **Search their JS API docs for a reload call** — `start`, `reload`, `refresh`,
   `init`. Apps often ship one for AJAX cart drawers. That is shape 5.
5. **If none match, test it.** Install the app on a test store with Pusha. Navigate
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
