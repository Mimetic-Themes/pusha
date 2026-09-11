# Judge.me

**Status: partly safe.** Six widgets survive a soft navigation. One does not.
Checked 2026-09-11 against Judge.me documentation. Not yet tested on a live store.

## What happens on a soft navigation

Judge.me installs a theme app extension. Its blocks render inside the swap container.

| Widget | How it renders | Result |
| --- | --- | --- |
| Star Rating Badge | `{{ product.metafields.judgeme.badge }}` | **Safe** |
| Reviews Carousel | `{{ shop.metafields.judgeme.featured_carousel }}` | **Safe** |
| Judge.me Medals | `{{ shop.metafields.judgeme.medals }}` | **Safe** |
| UGC Media Grid | `{{ shop.metafields.judgeme.ugc_media_grid }}` | **Safe** |
| Verified Reviews Counter | `{{ shop.metafields.judgeme.verified_badge }}` | **Safe** |
| All Reviews Counter | `{{ shop.metafields.judgeme.all_reviews_rating }}` | **Safe** |
| **Review Widget** | JavaScript builds it | **Breaks** |
| Floating Tab, All Reviews Page | Not documented for Shopify | **Unknown** |

The six safe widgets print a metafield. They have no JavaScript. They come back
correct after every swap.

The Review Widget is different. Its JavaScript runs one time, on the first page.
After a swap the markup comes back and the widget stays empty.

**Star ratings on product cards are safe.** This is the widget most buyers see.

## The fix for the Review Widget

Judge.me has a public API. One endpoint returns the widget as HTML. You get the HTML
again after each swap and put it in the page.

This is not a headless build. Judge.me keeps the data and makes the HTML. You control
only when it arrives.

### Step 1 — get a public API token

1. Open your Judge.me admin.
2. Go to **Settings**, then **Advanced**.
3. Copy the **public** API token.

**Use the public token only.** The private token gives write access. Never put a
private token in theme code.

### Step 2 — put the token in your theme

Add this to `layout/theme.liquid`, before you render the Pusha snippet:

```liquid
<script>
  window.theme = window.theme || {};
  window.theme.judgeMe = {
    token: 'YOUR_PUBLIC_TOKEN',
    shop: '{{ shop.permanent_domain }}',
  };
</script>
```

### Step 3 — add the adapter

Add this to your theme JavaScript:

```js
import { onAfterInit } from '@mimeticthemes/pusha/hooks';

onAfterInit(async (container) => {
  const el = container.querySelector('#judgeme_product_reviews');
  if (!el) return;

  const { token, shop } = window.theme.judgeMe ?? {};
  const productId = el.getAttribute('data-id');
  if (!token || !shop || !productId) return;

  // ⚠ Check the parameter names against judge.me/api/docs before you ship.
  const url =
    `https://api.judge.me/api/v1/widgets/product_review` +
    `?shop_domain=${encodeURIComponent(shop)}` +
    `&external_id=${encodeURIComponent(productId)}`;

  try {
    const res = await fetch(url, { headers: { 'X-Api-Token': token } });
    if (!res.ok) return;              // leave the old markup, do not clear it
    const data = await res.json();
    if (data?.widget) el.innerHTML = data.widget;
  } catch {
    // A failed request must never stop navigation.
  }
});
```

### Step 4 — test it

1. Open a product page. Look at the review widget.
2. Go to a second product page. Do not reload.
3. Look at the review widget again. The reviews must be there.
4. Open the network panel. Confirm one request to `api.judge.me` for each navigation.

## Is there a re-init call? No — searched, 2026-09-11

Zapiet publishes one (`Zapiet.start()`), so we looked hard for a Judge.me
equivalent across Shopify Community, Stack Overflow, Reddit, GitHub, page-builder
integration docs (Replo, PageFly, GemPages, Shogun, Boost Commerce) and agency
blogs. **Nothing exists for the full review widget**, in official docs or
community knowledge.

**One call does exist, and it does not help us.** Judge.me documents
`judgeme.badge()` then `judgeme.customizeBadges()` — note the namespace is
`judgeme.*`, not `jdgm.*` — for **badges only**, on collection pages whose theme
injects more product cards by AJAX:

> Setup Preview Badge for products rendered by JavaScript (AJAX) —
> `help.judge.me/knowledge_base/topics/setup-preview-badge-for-products-rendered-by-javascript-ajax`

Two reasons it is not our fix. It targets the Preview Badge, not the review
widget. And under Pusha the badge does not need it: a container swap re-renders
the badge's Liquid server-side, so it comes back correct on its own. That call is
for markup injected *without* a Liquid render — infinite scroll appending cards —
which is a different problem.

**Judge.me's own headless SDK has the same trouble.** Their
`@judgeme/shopify-hydrogen` package ships a `JudgemeProviderWrapper` that
"automatically re-renders widgets after they are loaded", and notes widgets "may
flash" on Hydrogen 2. Their own tooling works around non-full-page-load rendering
rather than exposing a clean re-mount.

**`data-auto-install='false'` stays unexplained.** Multiple sources confirm the
attribute is in their markup. **None — official or community — says what it
does.** Nobody has published a reverse-engineered manual-install call. Do not
build on the hypothesis that one is reachable.

**A caveat on the search itself.** GitHub code search needed sign-in, and
grep.app and Sourcegraph both rate-limited. Public code-search coverage for
literal `jdgm.` call sites in real theme repos was **not achieved**. Read the
GitHub findings as "not found with available tools", not as confirmed absence.

**So the API re-fetch above remains the only route** for the review widget. It is
shape 4, not shape 5.

## Limits

Read these before you promise the merchant full parity.

- **The HTML may not be interactive.** Judge.me documents a related endpoint as HTML
  that shows "essential parts of widgets before the JS and CSS files are loaded". The
  fragment probably gives you the reviews and the appearance. Controls such as
  pagination, sorting and the photo viewer may need the app's own code, which does not
  run again. **Test the controls, not only the appearance.**
- **CORS is not confirmed.** Judge.me says the public token is "designed for use in
  public JavaScript environments". Nobody has confirmed that `api.judge.me` accepts a
  browser request from a `myshopify.com` origin. Test this first — it decides whether
  the fix works at all.
- **One request per navigation costs time and quota.** Cache the response per product
  and give it a TTL. Judge.me does not publish a rate limit.
- **Review submission is separate.** `POST /reviews` needs no token. Moderation needs
  the private token and must stay on a server.
- **Two widgets are unknown.** Judge.me publishes no Shopify Liquid snippet for the
  Floating Tab or the All Reviews Page. Test them by hand.

## What we could not verify

- `data-auto-install='false'` appears in Judge.me markup but in no prose. The manual
  install call it implies is never named. Do not build on it.
- The headless loader script is made per shop, behind the Judge.me admin login. We
  could not read it, so we do not know if it exposes a global function.
- An old help article about badges in AJAX content still appears in search results.
  Its URL now redirects to the help home. Do not cite it.

## Sources

All facts above come from Judge.me's own documentation:

- Liquid snippets for every widget —
  https://judge.me/help/en/articles/12058208-liquid-code-for-judge-me-widgets
- Public and private token rules —
  https://judge.me/help/en/articles/8409180-using-judge-me-api
- Widget endpoints and security schemes — https://judge.me/api/docs and
  `judge.me/api/docs.yaml`
- Platform-independent widgets —
  https://judge.me/help/en/articles/8394958-installing-judge-me-widgets-on-external-platforms

Full research trail, including what was rejected: `pusha-probe/results.md`.
