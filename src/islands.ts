// Section Rendering API revalidation. After a cached PJAX nav (page HTML came
// from prefetch cache), inventory- and price-sensitive sections may be stale.
// Sections opt in by marking themselves with `data-island data-section-id="..."`.
// Pusha fetches `?sections=id1,id2`, receives `{ id1: '<html>', ... }`, and
// hot-swaps the section markup in place.
//
// The registry dependency is injected so the islands subpath stays standalone —
// users importing only `@mimeticthemes/pusha/islands` aren't forced to pull in the
// whole runtime tree.

import { log as dlog } from './diagnostics.js';

type Island = { sectionId: string; islandEl: HTMLElement };

export interface RevalidateHooks {
  /** Called before a section wrapper is replaced with fresh HTML. */
  onBeforeSwap?: (wrapper: HTMLElement) => void;
  /** Called after fresh section HTML is in place. */
  onAfterSwap?: (fresh: HTMLElement) => void;
}

function findIslands(container: ParentNode): Island[] {
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>('[data-island][data-section-id]'),
  );
  const seen = new Map<string, Island>();
  for (const el of nodes) {
    const id = el.getAttribute('data-section-id');
    if (!id || seen.has(id)) continue;
    seen.set(id, { sectionId: id, islandEl: el });
  }
  return Array.from(seen.values());
}

export async function revalidateIslands(
  container: HTMLElement,
  currentUrl: string,
  hooks: RevalidateHooks = {},
): Promise<void> {
  const islands = findIslands(container);
  if (islands.length === 0) return;
  const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  dlog('islands', `revalidating ${islands.length}: ${islands.map((i) => i.sectionId).join(', ')}`);

  // Build through URL, not string concatenation. `currentUrl` carries the
  // fragment, so appending `?sections=…` to it put the query INSIDE the hash —
  // the server saw a plain page request, returned HTML, res.json() threw, and
  // the catch below swallowed it. Islands silently never revalidated on any
  // #hash URL. The fragment is dropped here because it never changes what the
  // Section Rendering API returns.
  const target = new URL(currentUrl, window.location.href);
  target.hash = '';
  target.searchParams.set('sections', islands.map((i) => i.sectionId).join(','));
  const url = target.href;

  islands.forEach(({ islandEl }) => islandEl.classList.add('is-revalidating'));

  let json: Record<string, string>;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`sections=${res.status}`);
    json = (await res.json()) as Record<string, string>;
  } catch (err) {
    console.warn('[pusha/islands] revalidation failed', err);
    islands.forEach(({ islandEl }) => islandEl.classList.remove('is-revalidating'));
    return;
  }

  // The response is supposed to be keyed by the ids we asked for. When it is
  // not, every downstream symptom is confusing — the swap loop iterates keys
  // that name no wrapper and reports "no target", which reads like a theme
  // markup problem rather than a response that did not answer the question.
  // Measured on `shopify theme dev`: asked for `template--<id>__main`, got back
  // a key of `product`.
  const askedFor = islands.map((i) => i.sectionId);
  const cameBack = Object.keys(json);
  const missing = askedFor.filter((id) => !cameBack.includes(id));
  if (missing.length) {
    dlog(
      'islands',
      `RESPONSE MISMATCH — asked for [${askedFor.join(', ')}], got [${cameBack.join(', ')}]. ` +
        `Missing: ${missing.join(', ')}. The server did not key the response by the requested section ids.`,
    );
  }

  const applied = new Set<string>();
  Object.entries(json).forEach(([sectionId, html]) => {
    const selector = `#shopify-section-${CSS.escape(sectionId)}`;
    const wrappers = document.querySelectorAll<HTMLElement>(selector);
    if (wrappers.length === 0) {
      // The server rendered the section but there is no `#shopify-section-<id>`
      // wrapper in this document to put it in. A theme block, a section the
      // swap removed, or an id that never had a wrapper. Silence here is what
      // made this look like a success.
      dlog('islands', `NO TARGET for ${sectionId} — no #shopify-section-${sectionId} in the document`);
      return;
    }
    wrappers.forEach((wrapper) => {
      hooks.onBeforeSwap?.(wrapper);

      const tmp = document.createElement('div');
      tmp.innerHTML = html.trim();
      const fresh = tmp.firstElementChild as HTMLElement | null;
      if (!fresh) {
        dlog('islands', `EMPTY response for ${sectionId} — keeping the current markup`);
        return;
      }

      wrapper.replaceWith(fresh);
      applied.add(sectionId);
      hooks.onAfterSwap?.(fresh);
    });
  });

  // Remove the class explicitly. It used to come off only because
  // `wrapper.replaceWith()` destroyed the node carrying it, which meant every
  // path that did NOT swap — no wrapper, empty response, an island marker that
  // sits outside the wrapper being replaced — stranded `.is-revalidating` on a
  // live element forever. A theme styling it as a dim or skeleton got a region
  // that never came back. Removing from detached nodes too is harmless and
  // keeps the rule one line instead of a liveness check.
  islands.forEach(({ islandEl }) => islandEl.classList.remove('is-revalidating'));

  const elapsed = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started);
  const requested = Object.keys(json);
  // Count what was APPLIED, not what came back. The old line reported the
  // number of keys in the response, so "swapped 1" was printed whether or not a
  // single node had been touched — the diagnostic that should have caught the
  // stranded class instead certified the run as clean.
  dlog('islands', `swapped ${applied.size}/${requested.length} in ${elapsed}ms`);
  if (applied.size !== requested.length) {
    dlog('islands', `NOT applied: ${requested.filter((id) => !applied.has(id)).join(', ')}`);
  }

  document.dispatchEvent(
    new CustomEvent('pjax:islands-revalidated', {
      detail: { sectionIds: Array.from(applied), requestedIds: requested },
    }),
  );
}
