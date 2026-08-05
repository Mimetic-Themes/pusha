# A/B/C session test — does Shopify admin COUNT soft navigations?

The last open correctness question about Pusha. Everything upstream is settled:
`ShopifyAnalytics.lib.page()` fires on every swap with the right `pageType` and
`resourceId` (measured 8/8 on a live store, `monorail-admin-probe.md`). What is
**not** settled is whether Shopify admin counts those emissions as pageviews and
sessions, or discards them.

A Monorail row proves an event was *sent*. Only this test proves it was *counted*.

> Referenced from `monorail-admin-probe.md` for two sessions before it was ever
> written down. If you are re-deriving this from a session log again, stop and
> fix this file instead.

---

## The design

Three arms. **Identical click path, identical page count, identical browser.**
The only thing that changes between arms is one line of theme config.

| Arm | Config | Asks |
| --- | --- | --- |
| **A** — control | `pjax: false` | What does admin record for 8 real page loads? This is "correct". |
| **B** — Pusha, no bridge | `pjax: true`, `trekkie: false` | Does admin count soft navs on its own? |
| **C** — Pusha + bridge | `pjax: true`, `trekkie: true` | Does the Trekkie bridge make them count? |

Using `pjax: false` for arm A rather than typing URLs into the address bar is
deliberate: the same links get the same clicks, so referrer chains and entry
points stay identical across all three arms. Only the navigation mechanism
differs.

Config lives in `snippets/pusha.liquid` on `pusha-dawn`.

---

## Pre-flight

Do these in order. Step 0 can save you the entire run.

**0. Prove the venue tracks at all.** Open admin → Analytics → **Live View**.
Hard-load one page on the storefront. Confirm it appears within a few seconds.

`mimetic-speed` is a password-protected development store. If password-gated
traffic isn't recorded, nothing downstream works and every arm will read as a
false negative. Two minutes here beats a day of waiting on numbers that were
never going to arrive.

**1. Deploy the current build.** The theme must run a `pusha.min.js` built from
`1a5b352` or later. An earlier run was invalidated by a stale asset. Confirm the
asset URL's `?v=` changed after upload.

Why it matters for this test specifically: before `1a5b352`, the `shopify`
bridge and the `trekkie` bridge could both fire on the same swap. On a theme
where `Shopify.analytics.page` exists that is two pageviews per navigation —
which would make arm C look like a success when it was a double-count.

**2. Disable ad blockers and tracking protection.** They eat Monorail requests
silently. Use a clean profile if you have one.

**3. Fix the click path.** Eight pageviews: one landing plus seven navigations.
Four page types, no back-to-back repeats.

| # | URL | Type |
| --- | --- | --- |
| 1 | `/` | index — landing |
| 2 | `/collections/all` | collection |
| 3 | product A | product |
| 4 | `/collections/all` | collection |
| 5 | product B | product |
| 6 | `/pages/contact` | page |
| 7 | `/collections/all` | collection |
| 8 | `/` | index |

⚠ **Never click a link to the page you are already on.** As of `1a5b352` Pusha
short-circuits same-URL clicks — no swap, no pageview — so a repeat would
silently make an arm come up one short. The path above never does this.

⚠ The count must match exactly across arms. A previous arm C ran 9 pageviews
against a planned 7 and could not be compared to anything.

---

## Running one arm

1. Set the config in `snippets/pusha.liquid`, push the theme, confirm it's live.
2. **Clear all site data** for the storefront domain. Re-enter the store
   password if prompted — do this *before* starting the count.
3. Land on the storefront.

   ⚠ **UTM tagging does not work on a password-protected store** — a catch-22
   that bites from both sides. A tag on the session's *first* request is
   stripped by the `/password` redirect. A tag applied *after* the gate arrives
   too late: the session already started when the password landed you on index,
   and Shopify attributes sessions on **first touch**, so a mid-session UTM is
   just another pageview. Every `utm_campaign` row came back blank.

   Two ways around it: **turn off store password protection** (one toggle, and
   closer to real conditions — then `/?utm_campaign=arm-b2` genuinely starts the
   session), or **run one arm per hour** and let `TIMESERIES hour` separate them.
4. Open DevTools. **Network** tab, filter `monorail`, enable **Preserve log**.
5. In the Console, install the soft-nav counter:

   ```js
   window.__softNavs = 0;
   document.addEventListener('pjax:content-swap', () =>
     console.log('soft nav', ++window.__softNavs));
   ```

   On arms B and C this must reach **7**. On arm A it stays **0** — every
   navigation is a real page load, so the listener dies with each document.
   That is the check that the arm ran the mechanism you intended.

6. Walk the seven clicks **by hand**. Not Playwright — automation is bot-shaped
   and this store's traffic is already thin.
7. Watch the Network panel throughout. **Any 503 or 504 on `monorail-edge`
   voids the arm.** That is what killed the first run. Re-run with a fresh tag.
8. Open **Live View** and confirm pageviews are arriving as you browse.

Then wait ~30 minutes before starting the next arm, so the session closes and
so three identical-looking visitors don't arrive from one IP inside a few
minutes.

---

## ✅ RESULT (2026-08-05) — the bridge works

| Arm | Config | Swaps | `pageviews_per_session` |
| --- | --- | --- | --- |
| **C** | `trekkie: true` | 7–8 | **8.5** (6 sessions / 51 pageviews) |
| **B** | `trekkie: false` | 7–8 | **~1** |

**Admin counts soft navigations when the bridge is on.** Arm B is what makes it
conclusive: it emits nothing on a swap but **prefetches identically**, so if
prefetch requests were being counted, or if hard loads were the real source, B
would have been inflated too. It wasn't — only the landing hard-load registered.

The whole difference is the bridge. Inverted: **without it a Pusha storefront
undercounts admin pageviews by roughly 8×, silently.**

Arm A (`pjax: false`) was never run. It would confirm the absolute number, but B
vs C already isolates the variable, so A is now a nice-to-have.

---

## Reading it

⚠ **Live View cannot answer this.** It shows visitors and locations, not a
countable pageview stream. An earlier version of this runbook named it as the
primary read; that was wrong and cost a full test cycle.

Query the ShopifyQL `sessions` schema instead — it exposes `pageviews`,
`pageviews_per_session`, and a `human_or_bot_session` filter that settles the
bot-filtering worry directly rather than by guesswork:

```shopifyql
FROM sessions
  SHOW sessions, pageviews, pageviews_per_session
  WHERE human_or_bot_session = 'human'
  TIMESERIES hour DURING today
```

Run it with `shopify store execute`, or paste it into the admin's ShopifyQL
editor. Data is queryable within the hour — the "~2 days elapsed" estimate in
earlier notes was over-cautious.

The number that matters is **pageviews per session**, per arm.

| Result | Meaning | What to do |
| --- | --- | --- |
| **B ≈ C** | Admin counts soft navs unaided | Drop the `trekkie` bridge — it's solving a problem that doesn't exist |
| **C ≫ B**, B ≈ 1 | The bridge works | ✅ **This is what happened.** Ship `trekkie` as the documented opt-in. |
| **C ≫ B**, B partial | Admin counts some, bridge completes it | Ship the bridge; document what B alone gets |
| Both ≈ 1 | Admin cannot be fixed from theme code | Stop building admin-correctness as a Pusha property. Publish the measured platform boundary instead. |

---

## Caveats

- **Bot filtering is the most likely source of a false negative.** Clearing site
  data between arms makes each arm look like a new visitor from one IP in quick
  succession. If arms come back mysteriously uncounted, suspect filtering before
  concluding anything about soft navigation. Live View is pre-filtering, which
  is why it's the primary read and the report is the confirmation.
- **Low absolute numbers.** Eight pageviews is a small signal. If the store has
  any other traffic, the campaign tag is what keeps the arms separable — don't
  skip it.
- **Day boundaries.** Reports bucket by day in the store's timezone. Don't run
  an arm near midnight.
- `ShopifyAnalytics.lib.page()` is undocumented-but-long-stable. Whatever this
  test returns, never describe that call as documented in a public writeup.
