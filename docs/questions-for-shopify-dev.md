# Questions for shopify.dev AI / devrel

Ask one at a time. Each is written to be self-contained and to pre-empt a
conflation that has already produced one wrong answer: a prior reply slid from
"a theme app extension belongs to an app" and "you cannot get an App Store
listing for an extension alone" to "therefore you must host a backend." Those
are three separate claims and only the first two are established.

**Record every answer with its date and its cited source.** Answers without a
doc citation are weak evidence — the docs table and the assistant have already
disagreed with each other's implications once.

---

## Tier 1 — unblocks the probe rig (`pusha-probe`)

### Q1 — Can an extension-only app contain a theme app extension?

> I am building a **custom-distribution** app for internal testing on my own
> development store. It contains exactly one extension: a theme app extension
> with app blocks and app embed blocks. I need no App Store listing, no billing,
> no admin page, and no Admin API access. Nothing in the extension calls an API.
>
> Can I build this with `shopify app init` → "Build an extension-only app"?
> Specifically: does `shopify app generate extension` offer **Theme app
> extension** as a choice inside an extension-only app?
>
> To be clear about what I am **not** asking: I know a theme app extension
> belongs to an app, and I know an extension-only app cannot be publicly listed.
> My question is only whether the app it belongs to can be **extension-only with
> no developer-hosted backend**.
>
> The compatibility table at
> `apps/build/app-extensions/build-extension-only-app` lists Admin UI, App Home
> UI, Checkout UI, Functions, post-purchase, customer accounts, Flow and POS, and
> does **not** list theme app extensions. Is that omission intentional, or is the
> table incomplete? Please cite the doc that settles it.

> **ANSWERED 2026-09-11 — empirically, not from docs. YES.**
>
> `shopify app init` → "Build an extension-only app" produced a Shopify-hosted app
> (an `app-home` UI extension on `admin.app.home.render`, plus `app-tools`), and
> `shopify app generate extension` then offered **Theme app extension** and created
> one. `shopify app build` succeeds. No developer-hosted backend exists;
> `application_url` points at Shopify default app home.
>
> **The compatibility table is incomplete.** Devrel answered this both ways on
> consecutive asks — first "No, you must host a main app," then "Yes." The first
> answer reasoned from *listing* ("you cannot publish just a theme app extension")
> to *hosting*, which does not follow. The CLI settled it.
>
> Rig: `pusha-probe`.

### Q2 — Does a TAE keep working with an unreachable `application_url`?

> Suppose I use the standard app template instead of extension-only, install the
> app on a development store, and then stop hosting the backend entirely — so
> `application_url` resolves to nothing.
>
> After installation, does the app's **theme app extension continue to render on
> the storefront** and stay available in the theme editor? Which operations break
> when `application_url` is unreachable — is it only the embedded admin page and
> re-installation, or does anything on the storefront render path depend on it?

### Q3 — Does `deploy` persist the extension without a dev session?

> After `shopify app deploy`, are a theme app extension's app blocks and app
> embed blocks available in the theme editor and rendered on the storefront
> **without `shopify app dev` running**? I want the extension to stay usable
> across several days of testing without keeping a dev session alive.

---

## Tier 2 — the load-bearing runtime questions

These decide how a feature ships, not just how the rig is set up.

### Q4 — Is the theme editor's full reload on TAE changes intended?

> Measured on 2026-09-11: changing **any** setting on an app block or an app
> embed block in the theme editor causes a **full page reload** of the preview.
> Changing a setting on a *theme* section instead produces a section-level
> re-render with `shopify:section:unload` / `shopify:section:load`, as documented.
>
> Is the full reload for theme app extension changes **intended and expected to
> persist**, or is it incidental to how extension settings are saved? I am asking
> because I was using the editor's section-level re-render as a proxy measurement
> for how app code behaves when its DOM is replaced, and the reload makes that
> measurement impossible.

### Q5 — May theme code dispatch `shopify:section:load` on the storefront?

> On the **storefront** — not the theme editor — a theme replaces the contents of
> its main content container with HTML fetched over AJAX, a soft navigation with
> no document load. App block markup comes back, but the app's JavaScript already
> executed on the first document and does not re-initialize, so the block is
> inert.
>
> Is it supported for **theme code** to dispatch `shopify:section:unload` and
> `shopify:section:load` on `document` in that situation, so theme app extension
> code has a chance to re-initialize?
>
> Three parts:
> (a) Is the `shopify:` event namespace reserved for platform use?
> (b) Is dispatching these events from theme code documented as unsupported or
>     forbidden anywhere?
> (c) Is there any **other** signal a theme can emit that theme app extensions are
>     expected to observe?

### Q6 — Is there a sanctioned soft-navigation lifecycle?

> Is there any documented or planned mechanism by which a theme app extension can
> be notified that its host DOM was replaced without a document load? If none
> exists today, is one on the roadmap for themes doing client-side navigation?

### Q7 — Section Rendering API and app blocks

> Two parts.
>
> (a) Does a Section Rendering API response (`?sections=<section-id>`) include
>     **app blocks** rendered inside the requested section, with their Liquid
>     evaluated?
>
> (b) Does that response include the `<script async>` tag that the `javascript`
>     schema attribute normally injects, or is that tag emitted **only** on a full
>     document render? If it is included, where in the fragment does it appear?

### Q8 — Confirm the `javascript` schema attribute's injection contract

> The `javascript` attribute in a theme app extension block schema is documented
> as: "If the block is present on the page, then you can load this file
> automatically by adding a `<script async>` tag in the `<head>` section of the
> page. If a merchant adds multiple app blocks or app embed blocks that reference
> the same JavaScript file to a page, then the file is only included once when the
> page is loaded."
>
> Please confirm my reading: **Shopify's renderer** injects the tag — the app
> developer writes only the schema attribute, and the theme developer neither
> writes nor controls it. It lands in the rendered document's `<head>`, per
> request, only when the block is on the page, deduped to one occurrence.
>
> And: are the **placement** (`<head>` rather than inside the block's markup), the
> `async` attribute, and the dedupe **guaranteed behavior**, or implementation
> details that could change?

---

## Tier 3 — already measured; asking whether it is by design

### Q9 — Standard events on a soft navigation

> We have measured, on a published store with a custom pixel subscribed to
> `all_events`, that across 7 soft navigations zero `page_viewed` and zero
> `product_viewed` events arrive, while `clicked` events keep flowing.
> `Shopify.analytics.publish('page_viewed', …)` returns `false`, and
> re-dispatching `PageViewEvent` through `@shopify/standard-events` reaches no
> pixel.
>
> Is that by design and expected to remain so? Is there **any** supported way for
> theme code to cause a standard `page_viewed` Customer Event to be emitted for a
> soft navigation?

### Q10 — App embeds holding references into replaced DOM

> An app embed block (`target: body` or `target: head`) renders outside a theme's
> main content container and survives a soft navigation, but any DOM reference it
> captured into that container is destroyed when the container is replaced. Is
> there guidance for app developers on writing embeds that tolerate their host
> page's content being replaced without a document load?
