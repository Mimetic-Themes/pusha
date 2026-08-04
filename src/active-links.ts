// @mimetic/pusha/active-links — drop-in helper for bucket L-A findings.
//
// Server-rendered Liquid like `link.current`, `link.child_active`, and body
// `class="template-{{ template.name }}"` freezes on first load in the
// persistent layout shell (header, footer, layout/theme.liquid) because Pusha
// only swaps #MainContent. This helper re-derives that URL-/template-dependent
// state in JS on every PJAX swap, so a header nav reflects the current page
// and body classes stay in sync with the current template.
//
// Usage:
//   import { initActiveLinks } from '@mimetic/pusha/active-links';
//   initActiveLinks();
//
// Themes opt into the active-link toggle by marking nav containers:
//   <nav data-pusha-active-links> ... </nav>
//
// On every swap (and once on initial load), the helper:
//   - Strips `template-*` classes from <body> and adds `template-{template}`
//     using meta.template (sourced from data-page-type on the swap container).
//   - Walks `a[href]` inside any `[data-pusha-active-links]` ancestor, sets
//     aria-current="page" on the link matching the current URL, and toggles
//     class names per-link based on these (opt-in) data attributes, falling
//     back to opinionated defaults when neither attribute is present:
//
//       data-pusha-current-class="X"       toggle X when path == current URL
//                                         (default class: "is-current")
//       data-pusha-active-class="Y"        toggle Y when current OR ancestor
//                                         (default class: "is-ancestor",
//                                          ancestor-only — the default split
//                                          is preserved for back-compat)
//
//   - Walks any element carrying data-pusha-child-active-class inside an
//     [data-pusha-active-links] container, scopes to the nearest <details> or
//     <a> ancestor (or the container as fallback), and toggles the declared
//     class when any descendant <a> in that scope matches the current URL.
//     Useful for the "highlight the parent menu item if any child is current"
//     pattern (mega-menu, drawer, dropdown).
//
// The data-attribute overrides exist for themes whose CSS already uses a
// theme-specific active-state class (e.g. Dawn's `mega-menu__link--active`):
// they let the theme keep its existing CSS untouched while still re-deriving
// state on PJAX nav.
//
// The body-class portion runs even without `[data-pusha-active-links]` present
// — it's a no-op when the theme already uses `body[data-template]` for CSS.

import { onAfterSwap } from './hooks.js';
import type { NavMeta } from './types.js';

function normalizePath(path: string): string {
  const trimmed = path.replace(/\/$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function bodyUsesTemplateClass(): boolean {
  const body = document.body;
  if (!body) return false;
  return body.className.split(/\s+/).some((c) => c.startsWith('template-'));
}

function syncBodyTemplateClass(template: string | null | undefined): void {
  const body = document.body;
  if (!body) return;
  // Only touch body class if the theme is using `template-*` classes. Themes
  // that style only via `body[data-template]` are unaffected; auto-init won't
  // inject a `template-foo` class out of nowhere.
  if (!bodyUsesTemplateClass()) return;
  // Strip any existing template-* tokens (preserve other classes).
  const remaining = body.className
    .split(/\s+/)
    .filter((c) => c && !c.startsWith('template-'))
    .join(' ');
  body.className = template ? `${remaining} template-${template}`.trim() : remaining;
}

function toggleClassList(el: Element, classString: string, on: boolean): void {
  for (const cls of classString.split(/\s+/)) {
    if (cls) el.classList.toggle(cls, on);
  }
}

function normalizeAnchorPath(a: HTMLAnchorElement): string | null {
  try {
    const u = new URL(a.href, window.location.origin);
    if (u.origin !== window.location.origin) return null;
    return normalizePath(u.pathname);
  } catch {
    return null;
  }
}

function syncActiveLinks(): void {
  const containers = document.querySelectorAll<HTMLElement>('[data-pusha-active-links]');
  if (containers.length === 0) return;
  const here = normalizePath(window.location.pathname);
  for (const container of containers) {
    const links = container.querySelectorAll<HTMLAnchorElement>('a[href]');
    for (const a of links) {
      const path = normalizeAnchorPath(a);
      if (path === null) continue;
      const isCurrent = path === here;
      const isAncestor = !isCurrent && path !== '/' && here.startsWith(path + '/');

      if (isCurrent) a.setAttribute('aria-current', 'page');
      else if (a.getAttribute('aria-current') === 'page') a.removeAttribute('aria-current');

      const currentOverride = a.getAttribute('data-pusha-current-class');
      const activeOverride = a.getAttribute('data-pusha-active-class');
      const anyOverride = currentOverride !== null || activeOverride !== null;

      if (currentOverride) toggleClassList(a, currentOverride, isCurrent);
      if (activeOverride) toggleClassList(a, activeOverride, isCurrent || isAncestor);
      if (!anyOverride) {
        a.classList.toggle('is-current', isCurrent);
        a.classList.toggle('is-ancestor', isAncestor);
      }
    }

    // Wrapper elements that want to highlight when any descendant link is current.
    const wrappers = container.querySelectorAll<HTMLElement>('[data-pusha-child-active-class]');
    for (const el of wrappers) {
      const cls = el.getAttribute('data-pusha-child-active-class');
      if (!cls) continue;
      const scope =
        el.closest('details') ||
        el.closest('a') ||
        container;
      let hasCurrent = false;
      if (scope.tagName === 'A' && (scope as HTMLAnchorElement).hasAttribute('href')) {
        hasCurrent = normalizeAnchorPath(scope as HTMLAnchorElement) === here;
      }
      if (!hasCurrent) {
        const inner = scope.querySelectorAll<HTMLAnchorElement>('a[href]');
        for (const a of inner) {
          if (normalizeAnchorPath(a) === here) { hasCurrent = true; break; }
        }
      }
      toggleClassList(el, cls, hasCurrent);
    }
  }
}

function syncFromMeta(meta?: NavMeta | null): void {
  const template = meta?.template ?? document.body?.getAttribute('data-template');
  syncBodyTemplateClass(template);
  syncActiveLinks();
}

let initialized = false;

export function initActiveLinks(): void {
  if (initialized) return;
  initialized = true;
  onAfterSwap((_container, meta) => {
    syncFromMeta(meta);
  });
  // Run once on initial mount in case the body class needs to be set up from
  // the data-template attribute, or active-link state needs initial sync.
  syncFromMeta(null);
}

/** Test-only — reset the one-shot init flag so tests can call initActiveLinks again. */
export function _resetActiveLinksForTests(): void {
  initialized = false;
}
