# Changelog

Notable changes per release. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/), with the 0.x caveat that
breaking changes are allowed in minors until 1.0.

Everything below is pre-publication. Nothing has been released to npm yet, so
this file starts at the first release rather than reconstructing the churn that
led to it — `git log` has that, and it carries the reasoning.

## [Unreleased] — 0.1.0

First release. The runtime, the CLI, and the porting skill.

### Runtime

- PJAX navigation over a single configurable container (`#MainContent` by
  default), with link interception, history, scroll restoration, and named
  transitions.
- Component registry — `setupGlobal()` once, `init(root)` on every load and
  swap, optional `destroy(root)`.
- Hooks: `onBeforeNav`, `onBeforeLeave`, `onAfterSwap`, `onAfterInit`,
  `onFirstLoad`, `onNavError`. Async handlers are awaited.
- Events on `document`: `pjax:before-nav`, `pjax:content-swap`,
  `pjax:islands-revalidated`, and `cart:mutated` as the cart contract.
- Prefetch with per-template TTLs, soft/hard staleness, hover, pointer-down,
  focus and viewport warming, and a concurrency cap of two so speculative work
  never starves a real request.
- Islands — `[data-island][data-section-id]` regions revalidated through the
  Section Rendering API after a cached navigation.
- Head sync for title, meta, `body[data-template]`, scripts and stylesheets.
- Analytics bridges: `shopify`, `customEvents`, `standardEvents`, `trekkie`,
  `ga4`, `dataLayer`. Standard Web Pixel events are **not** reachable on a soft
  navigation — this is a platform constraint, measured rather than assumed, and
  the README's "Analytics & tracking" section says what does and does not work.
- Standard storefront events — `shopify:page:view` is re-dispatched per
  navigation, which is the sanctioned way app code learns a soft navigation
  happened.
- Accessibility: focus moves to the hash target, then an `[autofocus]` element
  in the incoming content, then the container; an `aria-live` region announces
  the new title; `prefers-reduced-motion` skips transitions.
- Theme editor: PJAX is off under `designMode`; `shopify:section:load` and
  `shopify:section:unload` are handled.
- `appCompat.sectionEvents` and `appCompat.reexecuteExtensionScripts` —
  experimental theme-app-extension repairs, both **off by default**. Enabling
  both together compounds multiplicatively and warns at boot.

### CLI

- `pusha audit` — classifies every script in a theme into buckets A–H and K,
  plus the surface buckets J, L, M, P and X. `--json` makes the report
  addressable by an agent, narrowable with `--bucket`, `--action` and `--file`.
- `pusha init` — Path A (vendored `pusha.min.js` + snippet) or Path B (npm),
  detected from the theme.
- `pusha skill` — installs the porting skill for Claude Code, Cursor or Aider.

### Known limitations

- Pixels wired through Shopify admin (Meta, GA4, TikTok, Klaviyo) do not
  receive a pageview on a soft navigation. No supported theme-side fix exists
  today. See the README.
- Theme app extension code with no re-init hook goes inert after a swap,
  regardless of how it is loaded. Apps that listen for `shopify:page:view` or
  that ship custom elements recover for free.
- `<html lang>` and `<html dir>` are not synced. Route language switches
  through a full browser navigation.
