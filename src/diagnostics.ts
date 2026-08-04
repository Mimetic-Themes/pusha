// Dev-mode diagnostics. Always shipped in the bundle but only invoked when
// `window.theme.config.debug` is true. The diagnostic surface is small enough
// (~1KB minified) that the runtime-flag DX wins over a separate dev build.
//
// Two surfaces:
//   - log(category, ...) / warn(category, ...) — tracing, prefixed for easy
//     console filtering (paste `[pusha/` into the browser filter to see only
//     framework output).
//   - checkContainer / recordNavigation — validation passes that catch theme
//     mistakes (sections without data-section-type, inline scripts in swapped
//     containers, etc).

import type { NavMeta } from './types.js';

let enabled = false;

export function setDebug(value: boolean): void {
  enabled = value;
}

export function isDebugEnabled(): boolean {
  return enabled;
}

export function log(category: string, ...args: unknown[]): void {
  if (!enabled) return;
  console.log(`[pusha/${category}]`, ...args);
}

export function warn(category: string, ...args: unknown[]): void {
  if (!enabled) return;
  console.warn(`[pusha/${category}]`, ...args);
}

// ─── Validation passes ────────────────────────────────────────────────────────

const observerCount = new Map<string, number>();

function hasCustomElementDescendant(el: Element): boolean {
  // Fast path: most themes wrap a single web component as the section's
  // first child (Dawn's <product-info>, <header-menu>, etc).
  const first = el.firstElementChild;
  if (first && first.tagName.includes('-')) return true;
  // Deep walk fallback. querySelectorAll('*') is cheap on real sections
  // (<100 nodes) and only runs when debug is on.
  for (const child of el.querySelectorAll('*')) {
    if (child.tagName.includes('-')) return true;
  }
  return false;
}

// Selector for inline procedural scripts — same shape used by both the
// section-init check (does this section need a sectionInits wrapper?) and the
// "inline script in swapped container" warning. Excludes `application/json`
// and `application/ld+json` data blocks, which are bucket B (non-executable)
// in the audit and shouldn't fire either warning.
const PROCEDURAL_SCRIPT_SELECTOR =
  'script:not([src]):not([type="application/json"]):not([type="application/ld+json"])';

function hasProceduralScript(el: Element): boolean {
  return el.querySelector(PROCEDURAL_SCRIPT_SELECTOR) !== null;
}

export function checkContainer(container: HTMLElement, meta: NavMeta): void {
  const sections = container.querySelectorAll<HTMLElement>('section, [data-section-id]');
  const unmarked: string[] = [];
  sections.forEach((section) => {
    const tag = section.tagName.toLowerCase();
    if (tag.includes('-')) return; // section root IS a custom element
    if (section.hasAttribute('data-section-type')) return;
    if (hasCustomElementDescendant(section)) return; // wrapper contains a self-mounting web component
    if (!hasProceduralScript(section)) return; // pure-presentational section, no init logic to wire up
    const id = section.id || section.getAttribute('data-section-id') || tag;
    unmarked.push(id);
  });
  if (unmarked.length) {
    console.warn(
      '[pusha/dev] sections without [data-section-type] or custom-element shape — ' +
        "they won't initialize on PJAX swap:",
      unmarked,
      'on',
      meta.url,
    );
  }

  const inlineScripts = container.querySelectorAll(PROCEDURAL_SCRIPT_SELECTOR);
  if (inlineScripts.length) {
    console.warn(
      '[pusha/dev] inline <script> tags found in swapped container — these will NOT execute. ' +
        'Lift them into window.theme.sectionInits[handle].',
      inlineScripts,
      'on',
      meta.url,
    );
  }
}

export function recordNavigation(meta: NavMeta): void {
  const count = (observerCount.get(meta.template) ?? 0) + 1;
  observerCount.set(meta.template, count);
  if (count > 0 && count % 10 === 0) {
    console.info(`[pusha/dev] ${count} navigations to template "${meta.template}" this session.`);
  }
}
