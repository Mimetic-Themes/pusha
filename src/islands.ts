// Section Rendering API revalidation. After a cached PJAX nav (page HTML came
// from prefetch cache), inventory- and price-sensitive sections may be stale.
// Sections opt in by marking themselves with `data-island data-section-id="..."`.
// Pusha fetches `?sections=id1,id2`, receives `{ id1: '<html>', ... }`, and
// hot-swaps the section markup in place.
//
// The registry dependency is injected so the islands subpath stays standalone —
// users importing only `@mimetic/pusha/islands` aren't forced to pull in the
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

  const params = new URLSearchParams({
    sections: islands.map((i) => i.sectionId).join(','),
  });
  const sep = currentUrl.includes('?') ? '&' : '?';
  const url = `${currentUrl}${sep}${params.toString()}`;

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

  Object.entries(json).forEach(([sectionId, html]) => {
    const selector = `#shopify-section-${CSS.escape(sectionId)}`;
    document.querySelectorAll<HTMLElement>(selector).forEach((wrapper) => {
      hooks.onBeforeSwap?.(wrapper);

      const tmp = document.createElement('div');
      tmp.innerHTML = html.trim();
      const fresh = tmp.firstElementChild as HTMLElement | null;
      if (!fresh) return;

      wrapper.replaceWith(fresh);
      hooks.onAfterSwap?.(fresh);
    });
  });

  const elapsed = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started);
  dlog('islands', `swapped ${Object.keys(json).length} in ${elapsed}ms`);

  document.dispatchEvent(
    new CustomEvent('pjax:islands-revalidated', { detail: { sectionIds: Object.keys(json) } }),
  );
}
