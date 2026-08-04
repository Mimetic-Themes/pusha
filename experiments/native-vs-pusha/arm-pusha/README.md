# Arm B — Pusha SPA

Persistent shell + warm runtime; only `#main-content` swaps. This arm exercises
the runtime seams the review flagged, so treat any breakage as data, not failure.

## Apply

1. **Build the runtime** (from the pusha repo root): `npm run build` → produces
   `dist/pusha.min.js`. Copy it to `base-theme-next/assets/pusha.min.js`.

2. **Copy the snippets** into `base-theme-next/snippets/`:
   - `pusha.liquid` (from the pusha repo `snippets/`), and
   - `pusha-config.liquid` (this folder) — the base-theme-next-specific override.

3. **Wire the container.** base-theme-next's swap target is
   `<main id="main-content" data-template="{{ request.page_type }}">`. Pusha
   reads `[data-page-container]` for transitions and `[data-page-type]` for
   template matching, so add them (keep `data-template` for the theme's own CSS):

   ```liquid
   <main class="flex-1" id="main-content" tabindex="-1"
         data-template="{{ request.page_type }}"
         data-page-container data-page-type="{{ request.page_type }}">
   ```

   > This attribute duplication is itself a finding — the review notes the
   > runtime should learn to read `data-template` on the container directly.
   > For the experiment, add the attributes; for the product, fix the runtime.

4. **Render in `<head>`**, config first so it wins the `|| {}` in `pusha.liquid`:

   ```liquid
   {% render 'pusha-config' %}
   {% render 'pusha' %}
   ```

5. Do **not** apply Arm A's files here. `pusha.liquid` already pins
   `@view-transition { navigation: none }` so native cross-doc VT doesn't fight
   Pusha's swap.

## Known seams to watch (expected, log them)

- **Analytics**: the bridge fires `Shopify.analytics` + `publish('page_viewed')`;
  this theme's convention is `@shopify/standard-events`. Watch for under- or
  double-counting (this is Move 4).
- **Islands**: `@mimetic/pusha/islands` targets the Section Rendering API
  (`?sections=`), which this theme doesn't use — expect islands to no-op.
- **Dual swap**: cart mutations go through `s-cart` + `partials.apply()`; a Pusha
  nav mid-refresh has no defined ordering. Try navigating right after an
  add-to-cart.
