// Head sync — required, automatic. On every PJAX nav we sync from the fetched
// document to the live one:
//   - <title>
//   - meta description, og:title, og:description, og:url, link rel=canonical
//   - <body data-template> attribute
//   - <link rel="stylesheet"> (newly required ones, awaited up to 2s)
//   - <script src> (newly required, fire-and-forget but awaited)

import { log as dlog } from './diagnostics.js';

const META_SELECTORS = [
  'meta[name="description"]',
  'meta[property="og:title"]',
  'meta[property="og:description"]',
  'meta[property="og:url"]',
  'link[rel="canonical"]',
];

export function updateMetadata(doc: Document): void {
  const prevTitle = document.title;
  document.title = doc.title;
  if (prevTitle !== doc.title) dlog('head', `title: "${doc.title}"`);

  let updated = 0;
  let added = 0;
  for (const sel of META_SELECTORS) {
    const next = doc.head.querySelector(sel);
    const current = document.head.querySelector(sel);
    if (next && current) {
      const attr = sel.startsWith('link') ? 'href' : 'content';
      const value = next.getAttribute(attr) ?? '';
      if (current.getAttribute(attr) !== value) {
        current.setAttribute(attr, value);
        updated++;
      }
    } else if (next && !current) {
      document.head.appendChild(next.cloneNode(true));
      added++;
    }
  }
  if (updated || added) dlog('head', `meta: ${updated} updated, ${added} added`);
}

export function updateBodyTemplateAttribute(doc: Document): void {
  const newTemplate = doc.body?.getAttribute('data-template');
  const prev = document.body.getAttribute('data-template');
  if (newTemplate != null) {
    document.body.setAttribute('data-template', newTemplate);
    if (prev !== newTemplate) dlog('head', `body[data-template]: ${prev ?? '(none)'} → ${newTemplate}`);
  } else {
    document.body.removeAttribute('data-template');
    if (prev != null) dlog('head', `body[data-template] removed (was ${prev})`);
  }
}

// Clone a source <script> element into the live document so it executes.
// We can't appendChild the source directly (cross-document) and cloneNode
// produces a non-executing copy — must createElement + copy attrs.
//
// Copying ALL attributes is load-bearing: type="module", crossorigin,
// integrity, nonce, defer, async, fetchpriority all change how the browser
// parses or fetches the script. The original head-sync only copied `src`,
// which silently broke Shopify-provided ESM bundles (loader.payment-terms,
// portable-wallets) by stripping their type="module" — the browser then
// parsed module syntax as a classic script and threw "Cannot use import
// statement outside a module".
function loadScript(source: HTMLScriptElement): Promise<void> {
  return new Promise<void>((resolve) => {
    const el = document.createElement('script');
    for (const attr of Array.from(source.attributes)) {
      el.setAttribute(attr.name, attr.value);
    }
    el.onload = () => resolve();
    el.onerror = () => resolve();
    document.head.appendChild(el);
  });
}

// Sync <script src> tags from the fetched document into the live <head>.
//
// Scans the WHOLE new document (head + body), because Shopify section JS
// commonly lives inside section bodies as <script src> tags rather than
// content_for_header. Section-body scripts imported via DOM don't execute
// on their own — they're inert until appended fresh — so we re-add them
// to the live <head>. Already-loaded scripts (matched by absolute URL) are
// skipped. Load errors are swallowed so a broken third-party script never
// blocks navigation.
//
// (Function name kept for backwards compat; behavior is "syncScripts" now.)
// Scripts already executed in this document, tracked across swaps.
//
// The DOM alone can't answer "have I loaded this?" — a script inside the swapped
// container is destroyed with it, while its side effects (top-level `class`,
// `const`, custom-element definitions) survive in the global scope forever.
// Re-injecting on a return visit therefore re-executes and throws
// "Identifier 'X' has already been declared", which kills the rest of that file.
// Dawn hits this immediately: facets.js, show-more.js and product-info.js all
// declare top-level classes from inside the section markup.
//
// Seeded once from the initial document, then union'd with the live DOM on every
// pass so scripts added by other means still count. Mirrors __pushaSyncedStyles.
function loadedScripts(): Set<string> {
  window.__pushaLoadedScripts ??= new Set<string>();
  const set = window.__pushaLoadedScripts;
  for (const s of Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))) {
    set.add(new URL(s.src, window.location.href).href);
  }
  return set;
}

export async function syncHeadScripts(newDoc: Document): Promise<void> {
  const loaded = loadedScripts();

  const toLoad = Array.from(newDoc.querySelectorAll<HTMLScriptElement>('script[src]'))
    .map((el) => ({
      el,
      href: new URL(el.getAttribute('src')!, window.location.href).href,
    }))
    .filter(({ href }) => !loaded.has(href));

  if (toLoad.length > 0) {
    dlog(
      'head',
      `scripts: +${toLoad.length} new`,
      toLoad.map((s) => s.href),
    );
    // Recorded before awaiting so two swaps in flight can't both queue the same
    // file, which would race into the same redeclaration error.
    for (const { href } of toLoad) loaded.add(href);
    await Promise.all(toLoad.map(({ el }) => loadScript(el)));
  }
}

// Sync <link rel="stylesheet"> tags. Returns when newly added stylesheets
// have loaded (or the 2s timeout elapses, so a broken sheet doesn't pin
// navigation forever).
export async function syncHeadStyles(newDoc: Document): Promise<void> {
  const newLinks = Array.from(newDoc.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'));

  window.__pushaSyncedStyles = window.__pushaSyncedStyles ?? new Set<string>();

  const loadPromises: Promise<void>[] = [];

  newLinks.forEach((newLink) => {
    const href = newLink.getAttribute('href');
    if (!href) return;

    const alreadyPresent = document.head.querySelector(`link[rel="stylesheet"][href="${href}"]`);
    if (!alreadyPresent) {
      const clone = newLink.cloneNode(true) as HTMLLinkElement;
      loadPromises.push(
        new Promise<void>((resolve) => {
          clone.addEventListener('load', () => resolve(), { once: true });
          clone.addEventListener('error', () => resolve(), { once: true });
          document.head.appendChild(clone);
        }),
      );
    }
    window.__pushaSyncedStyles!.add(href);
  });

  if (loadPromises.length > 0) {
    dlog('head', `stylesheets: +${loadPromises.length} new`);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000));
    await Promise.race([Promise.all(loadPromises), timeout]);
  }
}

// Wait for above-fold images in the new container to paint before revealing.
// Only the FIRST fetchpriority="high" image is treated as the LCP candidate —
// by spec the LCP is a single element, and themes that mark a whole gallery
// hi-pri (misuse) shouldn't compound the wait. Cap at 800ms; beyond that the
// fade-in runs and the image pops in when it lands. Other non-lazy images get
// 300ms. Layout stability is guaranteed by aspect-ratio + width/height, so
// images that miss the cap paint in cleanly after the transition.
export async function waitForEagerImages(container: HTMLElement): Promise<void> {
  const waitForImage = (img: HTMLImageElement) =>
    new Promise<void>((resolve) => {
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
    });

  const lcp = container.querySelector<HTMLImageElement>('img[fetchpriority="high"]');
  const critical = lcp && !lcp.complete ? [lcp] : [];

  const eager = Array.from(
    container.querySelectorAll<HTMLImageElement>(
      'img:not([loading="lazy"]):not([fetchpriority="high"])',
    ),
  ).filter((img) => !img.complete);

  const races: Promise<unknown>[] = [];
  if (critical.length) {
    races.push(
      Promise.race([
        Promise.all(critical.map(waitForImage)),
        new Promise<void>((resolve) => setTimeout(resolve, 800)),
      ]),
    );
  }
  if (eager.length) {
    races.push(
      Promise.race([
        Promise.all(eager.map(waitForImage)),
        new Promise<void>((resolve) => setTimeout(resolve, 300)),
      ]),
    );
  }
  if (!races.length) return;
  await Promise.all(races);
}
