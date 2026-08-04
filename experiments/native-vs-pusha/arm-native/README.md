# Arm A — native fast-MPA (zero runtime)

Full-page navigations, made smooth by native cross-document View Transitions and
made near-instant on Chromium by Speculation Rules. No Pusha, no custom nav JS.

## Apply

1. **View Transitions.** Append `view-transitions.css` to the theme's main
   stylesheet (or add it as a new `assets/*.css` and `{{ 'x.css' | stylesheet_tag }}`
   it in `layout/theme.liquid` `<head>`). base-theme-next already ships
   `view-transition-name` declarations on cart total / line items, so those
   regions get morph transitions for free once navigation VTs are enabled.

2. **Speculation Rules.** Add `{% render 'speculation-rules' %}` to
   `layout/theme.liquid` `<head>` (copy `speculation-rules.liquid` into
   `snippets/`). This prerenders same-origin links on moderate hover intent,
   excluding cart/checkout/account/localization routes.

3. Confirm no Pusha snippet is rendered on this arm.

## Verify it's live

- Chrome DevTools → **Application → Speculative loads** shows prerendered URLs on
  hover.
- DevTools → **Rendering → "Highlight view-transition"**, or just watch: nav
  should cross-fade instead of hard-cutting.
- Safari: expect the View Transition to work (cross-document VT is supported),
  but **no prerender** — this is the arm's known Safari weakness to measure.
