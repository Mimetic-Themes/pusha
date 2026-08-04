// jsdom bootstrap. Installs a fresh window/document into the global scope and
// returns helpers for resetting state between tests.

import { JSDOM } from 'jsdom';

export interface DomFixture {
  dom: JSDOM;
  reset: () => void;
}

const PAGE = (template: string, body = '<h1>Home</h1>') => `<!doctype html>
<html lang="en">
<head>
  <title>${template} page</title>
  <meta name="description" content="${template} description">
</head>
<body data-template="${template}">
  <header id="header-group"><a href="/products/foo">Foo</a></header>
  <main id="MainContent" data-page-container data-page-type="${template}">${body}</main>
</body>
</html>`;

export function setupDom(initialTemplate = 'index', initialBody = '<h1>Home</h1>'): DomFixture {
  const dom = new JSDOM(PAGE(initialTemplate, initialBody), {
    url: 'https://shop.test/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });

  const w = dom.window;

  // Install jsdom's globals onto Node's global scope so the runtime, which
  // freely references `window`/`document`/etc, resolves them correctly.
  const installs: Array<keyof typeof globalThis> = [
    'window',
    'document',
    'HTMLElement',
    'HTMLAnchorElement',
    'Node',
    'Element',
    'Event',
    'CustomEvent',
    'MouseEvent',
    'KeyboardEvent',
    'PointerEvent',
    'DOMParser',
    'Image',
    'fetch',
    'AbortController',
    'URL',
    'URLSearchParams',
    'history',
    'location',
    'requestAnimationFrame',
    'matchMedia',
    'CSS',
  ];
  for (const key of installs) {
    const value = (w as unknown as Record<string, unknown>)[key as string];
    if (value !== undefined) (globalThis as Record<string, unknown>)[key as string] = value;
  }

  // jsdom doesn't ship matchMedia — runtime uses it via prefersReducedMotion.
  // We claim reduced motion so the runtime skips its 350ms CSS-transition wait
  // and the test doesn't have to fight transition timing.
  const stubMatchMedia = (q: string) => ({
    matches: q.includes('reduce'),
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  } as MediaQueryList);
  (w as unknown as { matchMedia: typeof stubMatchMedia }).matchMedia = stubMatchMedia;
  (globalThis as Record<string, unknown>).matchMedia = stubMatchMedia;

  // jsdom lacks CSS.escape — islands.ts uses it for sectionId selectors.
  if (!(w as unknown as { CSS?: unknown }).CSS) {
    (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
  }

  // jsdom doesn't implement scrollTo; stub to avoid Not implemented warnings.
  w.scrollTo = (() => {}) as typeof w.scrollTo;

  // Reset history.scrollRestoration setter — jsdom allows it.
  (w.history as unknown as { scrollRestoration: ScrollRestoration }).scrollRestoration = 'auto';

  const reset = () => {
    dom.window.close();
  };

  return { dom, reset };
}

export function makePageHtml(template: string, body: string): string {
  return PAGE(template, body);
}
