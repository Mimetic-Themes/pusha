# Platform asks — making the new storefront work for client-side runtimes

*From the Pusha project (Mimetic Themes, LLC). Constructive feedback on the
new-Liquid / Standard Events + Actions developer preview, from the perspective of
a small drop-in runtime that keeps the storefront shell and JS runtime warm across
navigations.*

## Context in one paragraph

The July '26 preview moves page structure back into readable Liquid and — bigger
for us — introduces a **standard communication layer**: themes emit Standard
Events, apps and agents call Standard Actions (`Shopify.actions.updateCart`,
`openCart`, `getCart`), and successful actions auto-emit the matching events. This
is exactly the substrate a soft-navigation runtime needs. The pattern runs in
production today (yatseen.com, on an earlier in-theme build); the packaged
runtime is alpha, with a new-Liquid test bed and a measured native-vs-runtime
comparison behind it. Five asks would let client-side runtimes, third-party apps,
and browser agents **compose** on the new storefront instead of fighting each
other.

## The one that matters: a navigation Standard Event

**Ask:** add a `navigation` / `page_rendered` event to the Standard Events
vocabulary — fired by the platform on a full document load **and** re-fireable by
a client runtime after a soft (client-side) content swap.

**Why:** today's vocabulary is all *content* events — product views, cart
updates, collection-filter changes. There is **no soft-navigation lifecycle
event.** Apps initialize on `DOMContentLoaded` and have no signal that the page
content changed under a client-side runtime. The moment a theme does *any*
client-side navigation (Pusha, or a merchant's own fetch-and-swap), every app
that inits on load goes silent after the first page.

This is the missing *verb* in a vocabulary that already has the nouns. Bless one
navigation event, tell apps to (re-)init from it instead of `DOMContentLoaded`,
and the entire "apps break under client-side nav" class of bugs dissolves at the
contract level — for us and for anyone building on the new declarative storefront.

## The other four

2. **Emit `shopify:section:load` whenever section HTML is replaced — not only on
   theme-editor edits.** The contract already exists and is documented. The
   editor's own guidance describes exactly the soft-navigation problem
   ("their HTML is dynamically added, removed, or re-rendered directly onto the
   existing DOM, without reloading the entire page. However, any associated
   JavaScript that runs when the page loads won't run again") and answers it with
   `shopify:section:load` / `shopify:section:unload`, with `detail.sectionId` and
   a documented expected action: *re-execute any JavaScript needed for the
   section to work, as if the page had just been loaded.*

   The event, its payload, and its semantics are all specified. Only the
   **trigger** is scoped too narrowly. Today at least three mechanisms Shopify
   itself owns replace section HTML without firing it: the Section Rendering API,
   `partials.apply()`, and the theme editor's own path is the only one that does.
   Widening the trigger — and stating that app blocks should register the
   listener unconditionally rather than gating on `Shopify.designMode` — would
   let a re-rendered block come back to life anywhere, instead of returning as
   inert HTML the moment anything but the editor swaps it.

   This is the same shape as ask #1: the vocabulary is built, the verb is
   missing. Both are one branch, not one design.

3. **A coordination seam for `partials.apply()` vs. third-party DOM swaps.**
   `{% partial %}` + `partials.fetch/apply` and a container-level runtime both
   mutate the DOM; a navigation mid-partial-refresh has undefined ordering. Emit
   `partials:before-apply` / `after-apply` events, or expose a way to register a
   swap coordinator, so the two don't race.

4. **Make Standard Actions the required cart path for apps, with a guaranteed
   auto-emit.** If cart-mutating apps must go through `Shopify.actions.updateCart`
   (auto-emitting the cart standard event), then any SPA/runtime observing that
   event stays in sync with app-driven cart changes for free — no per-theme
   bridge, no missed mutations. This is the single highest-leverage interop win
   after ask #1.

5. **Document the standard-events channel admin reads, and the double-count
   semantics.** When a runtime re-fires `PageViewEvent` (via
   `@shopify/standard-events`) on a soft nav, does it double-count against a
   `<s-view-event view-event-trigger="connect">` element that re-mounts on the
   same swap? Right now that's unknowable without the Web Pixels sandbox. A short
   spec of "which channel admin reads + what re-firing does" lets every
   client-side runtime get analytics right by construction.

## Why this is credible feedback, not a wishlist

Every ask comes from a working runtime that already implements the workarounds:
Pusha ships an analytics bridge that re-fires page-view + page-type events on
every swap, a `cart:mutated` contract, a persistent-shell close-on-nav model, and
an audit that classifies every theme script by how it behaves under a swap — with
a designed bucket for the app surfaces above, whose remediation column is exactly
what ask #2 would let us stop hand-writing. The asks are the handful of
primitives that only Shopify can provide — the ones that would let us *delete*
those workarounds and let apps, themes, agents, and runtimes share one contract.

The framing for the room: *the storefront just went declarative and agent-first —
a soft-navigation event is the one primitive that lets apps, themes, and agents
survive a client-rendered page.* WebMCP already gives browser agents a semantic
path via Standard Actions; a navigation event extends the same courtesy to the
apps and runtimes that render the page those agents act on.
