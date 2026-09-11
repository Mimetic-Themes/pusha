// Experimental app-compatibility interventions for theme app extensions.
//
// A soft navigation replaces the swap container, and app block markup comes back
// with dead JavaScript: the app's bundle already executed on the first document
// and nothing re-runs it. These are the candidate repairs, each behind its own
// flag, all DEFAULTED OFF.
//
// They exist to be measured, not to be switched on. The rig that measures them
// is pusha-probe, and the result decides which (if any) ships on by
// default. See docs/proposals/bucket-x-brief.md → "The runtime half".
//
// ⚠ None of this is a Shopify-blessed lifecycle. `shopify:section:*` are theme
// EDITOR events; no doc says theme code may dispatch them on the storefront, and
// no doc forbids it either (checked 2026-08-06, re-checked 2026-09-11). The
// documented alternative is the Standard Storefront Events vocabulary, which
// Pusha already dispatches through the standardEvents bridge in analytics.ts —
// that is the sanctioned path, and this module is the fallback for apps that
// don't listen to it.

import { log as dlog } from './diagnostics.js';
import type { AppCompatConfig } from './types.js';

const SECTION_ID_PREFIX = 'shopify-section-';

// Shopify serves theme app extension assets from a stable CDN path. Matching on
// it is what keeps intervention 2 from re-executing THEME scripts, which is the
// thing head-sync's dedupe exists to prevent (top-level `class` redeclaration —
// see src/head-sync.ts and commit fd7ec17).
// Host-anchored on purpose. As a bare substring this matched
// `https://evil.example//cdn.shopify.com/extensions/x.js`, which would carve an
// attacker-controlled URL out of head-sync's dedupe and re-execute it on every
// navigation. Reaching it needs an already-injected script tag, but the narrow
// scoping IS the safety story for this flag.
function isExtensionAsset(rawSrc: string): boolean {
  try {
    const url = new URL(rawSrc, window.location.href);
    return url.host === 'cdn.shopify.com' && url.pathname.startsWith('/extensions/');
  } catch {
    return false;
  }
}

function sectionElements(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[id^="${SECTION_ID_PREFIX}"]`));
}

// The full dynamic section ID — `template--5678__image_banner`, not the JSON key.
// Derived from the wrapper id, per api/ajax/section-rendering.md:116-126. No
// JSON-key parsing belongs in this path.
function sectionIdOf(el: HTMLElement): string {
  return el.id.slice(SECTION_ID_PREFIX.length);
}

function dispatchSectionEvent(el: HTMLElement, type: 'load' | 'unload'): void {
  el.dispatchEvent(
    new CustomEvent(`shopify:section:${type}`, {
      bubbles: true,
      detail: { sectionId: sectionIdOf(el) },
    }),
  );
}

/** Intervention 1a — fire `shopify:section:unload` on every outgoing section.
 *
 *  Must be called BEFORE the container is replaced, while the old nodes are
 *  still connected, so a listener can still reach its own DOM to clean up.
 *
 *  Unload is not optional when load is dispatched. Firing load alone leaks one
 *  listener set per navigation, compounding across a session — strictly worse
 *  than doing nothing. Both live behind the same flag for that reason. */
export function dispatchSectionUnload(container: HTMLElement, cfg?: AppCompatConfig): void {
  if (!cfg?.sectionEvents) return;
  const sections = sectionElements(container);
  dlog('app-compat', `shopify:section:unload ×${sections.length}`);
  for (const el of sections) dispatchSectionEvent(el, 'unload');
}

/** Intervention 1b — fire `shopify:section:load` on every incoming section.
 *
 *  Called AFTER insertion and after customElements.upgrade(), so a listener sees
 *  a connected, upgraded tree. Ordering across the pair is
 *  unload → remove → insert → load; nothing guarantees 1:1 pairing. */
export function dispatchSectionLoad(container: HTMLElement, cfg?: AppCompatConfig): void {
  if (!cfg?.sectionEvents) return;
  const sections = sectionElements(container);
  dlog('app-compat', `shopify:section:load ×${sections.length}`);
  for (const el of sections) dispatchSectionEvent(el, 'load');
}

/** Intervention 2 — re-execute theme-app-extension bundles.
 *
 *  head-sync skips any script URL it has already loaded. That dedupe is
 *  load-bearing for theme scripts and must stay. This deliberately bypasses it
 *  for extension-origin scripts ONLY, on the theory that an app bundle is
 *  usually module- or IIFE-scoped and so survives a second execution where a
 *  theme section script would throw.
 *
 *  ⚠ MEASURED HARMFUL (pusha-probe run 2, 2026-09-11). It is the only mechanism
 *  measured that revives a block with no re-init hook — and the cost is UNBOUNDED
 *  ACCUMULATION, not a single extra bind. Re-executing a script does not replace
 *  the previous execution, it adds another one, listeners included. Over 4
 *  navigations a variant holding ONE page:view listener finished with FIVE, and a
 *  single click fired all of them. It compounds per navigation and never resets
 *  until a hard load. Nothing throws.
 *
 *  Apps that only scan on execute look clean but are being reinstalled wholesale
 *  once per nav. The probe harness itself was duplicated this way, which is how
 *  the defect was found: 4 navigations counted as 14.
 *
 *  Ship-on only after auditing by hand that nothing on the page registers
 *  listeners on document/window.
 *
 *  Runs AFTER the swap, not at head-sync time: the re-executed bundle queries the
 *  DOM on execution, and at head-sync time the new container isn't in it yet. */
export async function reexecuteExtensionScripts(
  newDoc: Document,
  cfg?: AppCompatConfig,
): Promise<void> {
  if (!cfg?.reexecuteExtensionScripts) return;

  const sources = Array.from(newDoc.querySelectorAll<HTMLScriptElement>('script[src]')).filter(
    (el) => isExtensionAsset(el.getAttribute('src')!),
  );
  if (sources.length === 0) return;

  dlog(
    'app-compat',
    `re-executing ${sources.length} extension script(s)`,
    sources.map((s) => s.getAttribute('src')),
  );

  await Promise.all(
    sources.map(
      (source) =>
        new Promise<void>((resolve) => {
          const el = document.createElement('script');
          // Copy every attribute — type="module", crossorigin, async all change
          // how the browser fetches and parses. Same reasoning as head-sync's
          // loadScript; see the comment there.
          for (const attr of Array.from(source.attributes)) {
            el.setAttribute(attr.name, attr.value);
          }
          // A module script executes at most once per URL per document, no matter
          // how many times the tag is added. Re-adding it is a silent no-op
          // rather than an error, so this path cannot repair a module bundle.
          el.onload = () => resolve();
          el.onerror = () => resolve();
          document.head.appendChild(el);
        }),
    ),
  );
}

/** Warn once at boot when both flags are set.
 *
 *  Measured 2026-09-11 (pusha-probe run 3): the two interact MULTIPLICATIVELY.
 *  reexecuteExtensionScripts creates N copies of every script, each registering
 *  its own listeners; sectionEvents then fires all N, once per section, per
 *  navigation. A variant that was completely clean under EITHER flag alone
 *  (0 double-inits) recorded 14 under both, and the shell-resident repairer
 *  received 42 section:load events across 4 navigations.
 *
 *  The combination is never correct: the only population re-execution uniquely
 *  serves (an app with no re-init hook) gains nothing from section events, and
 *  every population section events serves is damaged by re-execution.
 *
 *  This warns rather than refuses — the flags are experimental and someone
 *  measuring deliberately should not be blocked. It is gated on `debug`. */
export function warnOnConflictingAppCompat(cfg?: AppCompatConfig): void {
  if (cfg?.sectionEvents && cfg?.reexecuteExtensionScripts) {
    dlog(
      'app-compat',
      'BOTH appCompat flags are on. Measured to compound multiplicatively — ' +
        're-execution accumulates listeners and section events then fire all of ' +
        'them, once per section, per navigation. Enable at most one.',
    );
  }
}
