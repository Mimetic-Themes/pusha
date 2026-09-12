# Security

## Reporting

Use **GitHub's private vulnerability reporting** on this repository (Security →
Report a vulnerability). Please do not open a public issue for anything
exploitable.

Include what you did, what happened, and the theme shape it happened on. A
proof of concept helps; a working exploit against someone else's live store
does not — do not test against storefronts you do not control.

Expect an acknowledgement within a week. Pusha is maintained by a one-person
studio, so that is a realistic figure rather than an aspirational one.

## Scope

Pusha runs in the storefront, in the buyer's browser, with whatever privileges
the theme already has. What is in scope:

- Parsing fetched HTML into the live document — the swap path, head sync, and
  Section Rendering API island responses.
- The origin checks on navigation and prefetch. Pusha refuses cross-origin
  redirects rather than parsing another origin's markup as if it were the
  shop's; a way around that is a vulnerability.
- `syncHeadScripts` / `syncHeadStyles`, which execute script and style elements
  from a fetched document.
- The `appCompat.reexecuteExtensionScripts` flag, which re-executes bundles
  from `cdn.shopify.com/extensions/`. It is off by default and its known cost
  (unbounded listener accumulation) is documented, not a finding — but a way to
  make it execute from another origin is.
- `bin/pusha.js`, which writes into a developer's theme directory. Path
  traversal or writing outside the target theme is in scope.

What is not:

- Theme code Pusha navigates between. A theme that injects untrusted HTML is
  vulnerable whether or not it soft-navigates.
- Shopify's own platform, including Web Pixels, the Section Rendering API, and
  Standard storefront events. Report those to Shopify.
- The fact that a soft navigation does not re-run a third-party app's
  once-per-document script. That is a documented compatibility limitation with
  measurements behind it, not a security issue.

## Supported versions

Pre-1.0. Fixes land on the current minor; there are no backports. Breaking
changes are allowed in 0.x minors, so pinning an exact version is the right
move for production themes until 1.0.
