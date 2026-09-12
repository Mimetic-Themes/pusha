// Smoke test for the Pusha runtime. Drives the navigation lifecycle through
// jsdom and asserts hooks fire, the container swaps, registered components
// re-init, and the analytics bridge fires.
//
// Run with: npm test
//
// Strategy: jsdom is set up per test (fresh document, URL, listeners) but
// runtime modules are loaded once and reset via _resetForTests() helpers
// so module-level state (hooks, registry, runtime singletons) doesn't leak.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, makePageHtml, type DomFixture } from './dom.ts';

const runtime = await import('../src/runtime.ts');
const hooks = await import('../src/hooks.ts');
const registryModule = await import('../src/registry.ts');
const activeLinksModule = await import('../src/active-links.ts');
const prefetchModuleTop = await import('../src/prefetch.ts');
const analyticsModule = await import('../src/analytics.ts');

let fixture: DomFixture;

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}
let fetchCalls: FetchCall[] = [];
let fetchResponder: (url: string) => { status: number; body: string };

function installFetch() {
  fetchCalls = [];
  fetchResponder = (url) => ({
    status: 200,
    body: makePageHtml('product', `<h1>Product</h1><div>at ${url}</div>`),
  });
  (globalThis as Record<string, unknown>).fetch = async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({
      url,
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
    });
    const { status, body } = fetchResponder(url);
    return new Response(body, {
      status,
      headers: { 'Content-Type': 'text/html' },
    });
  };
}

let analyticsPageCalls = 0;
let analyticsPublishCalls: string[] = [];
let analyticsPublishPayloads: Array<{ event: string; payload: unknown }> = [];

beforeEach(() => {
  fixture = setupDom('index');
  installFetch();
  analyticsPageCalls = 0;
  analyticsPublishCalls = [];
  analyticsPublishPayloads = [];
  (window as unknown as { Shopify: unknown }).Shopify = {
    analytics: {
      page: () => {
        analyticsPageCalls++;
      },
      publish: (event: string, payload?: unknown) => {
        analyticsPublishCalls.push(event);
        analyticsPublishPayloads.push({ event, payload });
      },
    },
  };
  // Reset shared module-level state.
  runtime._resetForTests();
  hooks._resetHooksForTests();
  registryModule.registry._resetForTests();
  activeLinksModule._resetActiveLinksForTests();
  prefetchModuleTop._resetPrefetchForTests();
  analyticsModule._resetAnalyticsForTests();
});

afterEach(() => {
  fixture.reset();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

test('initRuntime boots without error and exposes window.theme.initPage', () => {
  runtime.initRuntime();
  assert.equal(typeof window.theme.initPage, 'function');
  assert.equal((history as History).scrollRestoration, 'manual');
});

test('registered component setupGlobal + init runs on initRuntime', () => {
  let setupCalls = 0;
  let initCalls = 0;
  registryModule.registry.register('hero', {
    setupGlobal() {
      setupCalls++;
    },
    init() {
      initCalls++;
    },
  });
  runtime.initRuntime();
  assert.equal(setupCalls, 1);
  assert.equal(initCalls, 1, 'init runs once on boot');
});

test('onFirstLoad registered before initRuntime fires once on boot', async () => {
  let fireCount = 0;
  let receivedContainer: HTMLElement | null = null;
  hooks.onFirstLoad((container) => {
    fireCount++;
    receivedContainer = container;
  });

  runtime.initRuntime();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(fireCount, 1, 'fires once');
  assert.ok(receivedContainer, 'receives container');
  assert.equal((receivedContainer as HTMLElement).id, 'MainContent');
});

test('onFirstLoad registered AFTER initRuntime fires immediately (Path A defer-script order)', async () => {
  runtime.initRuntime();
  await new Promise((r) => setTimeout(r, 0));

  // Late registration — simulates a `<script defer>` adapter loaded after pusha.min.js.
  let fireCount = 0;
  let receivedContainer: HTMLElement | null = null;
  hooks.onFirstLoad((container) => {
    fireCount++;
    receivedContainer = container;
  });

  assert.equal(fireCount, 1, 'late-registered handler fires immediately');
  assert.ok(receivedContainer, 'late handler still receives container');
});

test('link click triggers fetch, swaps container, fires hooks in order', async () => {
  const sequence: string[] = [];
  hooks.onBeforeNav((url) => {
    sequence.push(`beforeNav:${new URL(url).pathname}`);
  });
  hooks.onBeforeLeave(() => {
    sequence.push('beforeLeave');
  });
  hooks.onAfterSwap((_, meta) => {
    sequence.push(`afterSwap:${meta.template}`);
  });
  hooks.onAfterInit((_, meta) => {
    sequence.push(`afterInit:cached=${meta.cached}`);
  });

  runtime.initRuntime();

  const link = document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!;
  link.click();

  // Yield for the async navigation chain.
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(fetchCalls.length >= 1, 'fetch was called for the link');
  assert.equal(fetchCalls[0]!.headers['X-Requested-With'], 'XMLHttpRequest');

  const container = document.querySelector<HTMLElement>('#MainContent');
  assert.ok(container, 'container present after swap');
  assert.equal(container!.getAttribute('data-page-type'), 'product');
  assert.match(container!.innerHTML, /Product/);

  assert.deepEqual(sequence, [
    'beforeNav:/products/foo',
    'beforeLeave',
    'afterSwap:product',
    'afterInit:cached=false',
  ]);
});

test('PJAX swap re-runs registered component init on new container', async () => {
  const initRoots: string[] = [];
  registryModule.registry.register('badge', {
    init(root) {
      const el = root as HTMLElement;
      initRoots.push(el.getAttribute?.('data-page-type') ?? 'doc');
    },
  });

  runtime.initRuntime();
  assert.equal(initRoots.length, 1, 'init runs once on boot');

  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(initRoots.length, 2, 'init re-runs after PJAX swap');
  assert.equal(initRoots[1], 'product');
});

test('analytics bridge fires Shopify.analytics.page on every swap', async () => {
  runtime.initRuntime();

  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(analyticsPageCalls, 1);
  // Only the prefixed custom event goes out. Publishing under the standard name
  // is fenced by the platform ("partners and merchants cannot publish standard
  // events"), so Pusha no longer makes a call it knows will be rejected.
  assert.deepEqual(analyticsPublishCalls, ['pusha:page_viewed']);
});

test('the shopify bridge stands down when trekkie is on (no double pageview)', async () => {
  // Both bridges exist to re-fire the one storefront pageview. On a theme where
  // Shopify.analytics.page IS defined, running both sends two pageviews per
  // navigation — which inflates admin counts and would read as a success in the
  // A/B/C measurement this was built for.
  const calls = installTrekkie();

  fetchResponder = () => ({
    status: 200,
    body: makePageHtml(
      'product',
      `<h1>Product</h1>
       <script type="application/json" data-pusha-trekkie-page>{"pageType":"product"}</script>`,
    ),
  });

  runtime.initRuntime({ analytics: { shopify: true, trekkie: true } });
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(calls.length, 1, 'trekkie sends the pageview');
  assert.equal(analyticsPageCalls, 0, 'Shopify.analytics.page() does NOT also fire');
});

test('the shopify bridge still fires when trekkie is off', async () => {
  installTrekkie();

  runtime.initRuntime({ analytics: { shopify: true, trekkie: false } });
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(analyticsPageCalls, 1, 'the bridge is trimmed, not removed');
});

test('analytics re-publishes theme-serialized page-type Customer Events on swap', async () => {
  // On a native load Shopify auto-fires product_viewed; on a PJAX swap only the
  // theme-supplied payload carries it. The page serializes it in #MainContent.
  fetchResponder = () => ({
    status: 200,
    body: makePageHtml(
      'product',
      `<h1>Product</h1>
       <script type="application/json" data-pusha-analytics-event>
         {"name":"product_viewed","data":{"productVariant":{"id":42}}}
       </script>`,
    ),
  });

  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  // Prefixed only — `product_viewed` under its standard name is rejected, so
  // that call is gone. The theme's serialized payload rides the prefixed copy,
  // which is the one a companion pixel actually receives.
  assert.deepEqual(analyticsPublishCalls, ['pusha:page_viewed', 'pusha:product_viewed']);
  const prefixed = analyticsPublishPayloads.find((p) => p.event === 'pusha:product_viewed');
  assert.deepEqual(prefixed?.payload, { productVariant: { id: 42 } });
});

test('analytics accepts an array of serialized page-type events', async () => {
  fetchResponder = () => ({
    status: 200,
    body: makePageHtml(
      'collection',
      `<h1>Collection</h1>
       <script type="application/json" data-pusha-analytics-event>
         [{"name":"collection_viewed","data":{"id":7}},{"name":"search_submitted","data":{"q":"x"}}]
       </script>`,
    ),
  });

  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.deepEqual(analyticsPublishCalls, [
    'pusha:page_viewed',
    'pusha:collection_viewed',
    'pusha:search_submitted',
  ]);
});

test('analytics ignores malformed data-pusha-analytics-event JSON (no throw, page_viewed still fires)', async () => {
  fetchResponder = () => ({
    status: 200,
    body: makePageHtml(
      'product',
      `<h1>Product</h1>
       <script type="application/json" data-pusha-analytics-event>{ not json }</script>`,
    ),
  });

  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.deepEqual(analyticsPublishCalls, ['pusha:page_viewed']);
});

test('analytics ga4 bridge fires gtag page_view when enabled', async () => {
  const gtagCalls: unknown[][] = [];
  (window as unknown as { gtag: (...a: unknown[]) => void }).gtag = (...args) => {
    gtagCalls.push(args);
  };

  runtime.initRuntime({ analytics: { ga4: true } });
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(gtagCalls.length, 1);
  assert.equal(gtagCalls[0][0], 'event');
  assert.equal(gtagCalls[0][1], 'page_view');
  const params = gtagCalls[0][2] as Record<string, string>;
  assert.equal(params.page_path, '/products/foo');
});

test('analytics ga4 with a measurement id targets the stream via send_to', async () => {
  const gtagCalls: unknown[][] = [];
  (window as unknown as { gtag: (...a: unknown[]) => void }).gtag = (...args) => {
    gtagCalls.push(args);
  };

  runtime.initRuntime({ analytics: { ga4: 'G-ABC123' } });
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(gtagCalls.length, 1);
  assert.equal((gtagCalls[0][2] as Record<string, string>).send_to, 'G-ABC123');
});

test('analytics dataLayer bridge pushes a GTM event when enabled', async () => {
  const dataLayer: unknown[] = [];
  (window as unknown as { dataLayer: unknown[] }).dataLayer = dataLayer;

  runtime.initRuntime({ analytics: { dataLayer: true } });
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(dataLayer.length, 1);
  const push = dataLayer[0] as Record<string, string>;
  assert.equal(push.event, 'pusha.page_view');
  assert.equal(push.page_path, '/products/foo');
});

test('analytics ga4/dataLayer stay OFF by default (no double-count with Shopify bridge)', async () => {
  const gtagCalls: unknown[][] = [];
  const dataLayer: unknown[] = [];
  (window as unknown as { gtag: (...a: unknown[]) => void }).gtag = (...args) => gtagCalls.push(args);
  (window as unknown as { dataLayer: unknown[] }).dataLayer = dataLayer;

  runtime.initRuntime(); // analytics: true → shopify only
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(gtagCalls.length, 0, 'gtag is not auto-fired');
  assert.equal(dataLayer.length, 0, 'dataLayer is not auto-pushed');
  assert.deepEqual(analyticsPublishCalls, ['pusha:page_viewed']);
});

test('custom-event bridge publishes a prefixed page_viewed by default', async () => {
  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  // The unprefixed 'page_viewed' is rejected by Shopify (standard names are
  // fenced); the prefixed one is the only call that reaches pixels.
  assert.ok(analyticsPublishCalls.includes('pusha:page_viewed'));
});

test('custom-event bridge honours a custom prefix', async () => {
  runtime.initRuntime({ analytics: { customEvents: 'softnav' } });
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(analyticsPublishCalls.includes('softnav:page_viewed'));
  assert.ok(!analyticsPublishCalls.includes('pusha:page_viewed'));
});

test('custom-event bridge can be disabled without disabling the rest', async () => {
  runtime.initRuntime({ analytics: { customEvents: false } });
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.deepEqual(analyticsPublishCalls, [], 'nothing is published at all');
  // "the rest" is now checked on the Shopify bridge, since the custom events
  // were the only publish() calls left once the fenced standard names went.
  assert.equal(analyticsPageCalls, 1, 'the Shopify bridge still ran');
});

test('customEvents off leaves publish() untouched — Pusha makes no rejected calls', async () => {
  // Guards the trim: a future change that reintroduces a standard-name publish
  // would show up here as a call the platform is documented to reject.
  fetchResponder = () => ({
    status: 200,
    body: makePageHtml(
      'product',
      `<h1>Product</h1>
       <script type="application/json" data-pusha-analytics-event>
         {"name":"product_viewed","data":{"productVariant":{"id":42}}}
       </script>`,
    ),
  });

  runtime.initRuntime({ analytics: { customEvents: false } });
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.deepEqual(
    analyticsPublishCalls,
    [],
    'a serialized product_viewed must NOT be published under its standard name',
  );
});

test('[autofocus] in the incoming content takes focus instead of the container', async () => {
  // The browser will not do this for us: swapped-in content arrives while the
  // document already has a focused element, so autofocus processing is
  // declined. Without this, the attribute is silently dead on every soft
  // navigation and a search template loads with focus on the container.
  fetchResponder = () => ({
    status: 200,
    body: makePageHtml('search', '<h1>Search</h1><input id="q" autofocus>'),
  });

  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(document.activeElement?.id, 'q', 'the authored target has focus');
});

test('a hash target still outranks [autofocus] — the click is the later intent', async () => {
  fetchResponder = () => ({
    status: 200,
    body: makePageHtml('search', '<input id="q" autofocus><div id="results">R</div>'),
  });

  document.body.innerHTML += '<a id="deep" href="/search#results">Results</a>';
  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('#deep')!.click();
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(document.activeElement?.id, 'results', 'hash wins over autofocus');
});

test('an [autofocus] that cannot take focus falls through to the container', async () => {
  // autofocus on a disabled input, a hidden element or a plain <div> is a
  // no-op. Trusting it without checking would leave focus on the outgoing
  // page's link, which is worse than the default.
  fetchResponder = () => ({
    status: 200,
    body: makePageHtml('search', '<input id="q" autofocus disabled><h1>Search</h1>'),
  });

  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(document.activeElement?.id, 'MainContent', 'container took focus');
});

test('data-no-transition on link skips PJAX', async () => {
  const link = document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!;
  link.setAttribute('data-no-transition', '');

  runtime.initRuntime();
  link.click();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(fetchCalls.length, 0, 'fetch is NOT called for opt-out links');
});

test('design mode disables PJAX nav but wires shopify:section:load', async () => {
  (window as unknown as { Shopify: { designMode: boolean } }).Shopify = { designMode: true };

  let sectionLoadInit = 0;
  registryModule.registry.register('s1', {
    init() {
      sectionLoadInit++;
    },
  });

  runtime.initRuntime();
  assert.equal(sectionLoadInit, 1, 'boot init');

  const target = document.createElement('div');
  document.body.appendChild(target);
  target.dispatchEvent(new window.Event('shopify:section:load', { bubbles: true }));
  assert.equal(sectionLoadInit, 2, 'section:load re-runs init');

  // PJAX off — click does nothing.
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetchCalls.length, 0);
});

test('Pusha.go programmatic navigation calls hooks and swaps container', async () => {
  let afterInitFired = false;
  hooks.onAfterInit(() => {
    afterInitFired = true;
  });

  runtime.initRuntime();
  await runtime.go('/products/bar');

  assert.ok(afterInitFired);
  assert.equal(window.location.pathname, '/products/bar');
});

test('Shopify-reserved links are not intercepted (cart IS intercepted)', async () => {
  document.body.innerHTML += `
    <a id="checkout" href="/checkout">Checkout</a>
    <a id="checkouts" href="/checkouts/abc">Checkouts</a>
    <a id="login" href="/account/login">Login</a>
    <a id="register" href="/account/register">Register</a>
    <a id="logout" href="/account/logout">Logout</a>
    <a id="recover" href="/account/recover">Recover</a>
    <a id="activate" href="/account/activate/123/abc">Activate</a>
    <a id="customer-auth" href="/customer_authentication/login">Customer auth</a>
    <a id="password" href="/password">Password</a>
    <a id="localization" href="/localization?country=US&language=en">Localization</a>
    <a id="giftcard" href="/gift_cards/abc/xyz">Gift card</a>
    <a id="appproxy" href="/a/some-app/page">App proxy</a>
    <a id="cart-add" href="/cart/add?id=123">Add to cart</a>
    <a id="cart-change" href="/cart/change?line=1&quantity=0">Remove</a>
    <a id="cart-update" href="/cart/update?updates[]=0">Update</a>
    <a id="cart-clear" href="/cart/clear">Clear</a>
    <a id="cart-permalink" href="/cart/40000001:1">Permalink</a>
    <a id="discount" href="/discount/SAVE10">Discount</a>
    <a id="cart-page" href="/cart">Cart page</a>
  `;

  runtime.initRuntime();
  for (const id of [
    'checkout', 'checkouts', 'login', 'register', 'logout', 'recover', 'activate',
    'customer-auth', 'password', 'localization', 'giftcard', 'appproxy',
    // GET requests that MUTATE server state. Intercepting these performs the
    // mutation over fetch and, worse, repeats it when the buyer hits Back.
    'cart-add', 'cart-change', 'cart-update', 'cart-clear', 'cart-permalink',
    'discount',
  ]) {
    document.getElementById(id)!.click();
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetchCalls.length, 0, 'no reserved link triggers a PJAX fetch');

  // /cart itself only READS cart state, so it stays a regular themed page.
  document.getElementById('cart-page')!.click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetchCalls.length, 1, '/cart is still a PJAX navigation');
  assert.match(fetchCalls[0].url, /\/cart$/);
});

test('href="#" and href="" are left alone for the theme to handle', async () => {
  // Regression: both resolve to the current URL with an EMPTY hash, so the
  // same-URL branch used to preventDefault() and scroll to top from the capture
  // phase — before the theme's own click handler ran. Stock Dawn ships this
  // shape in its localization form triggers.
  document.body.innerHTML += `
    <a id="hash-only" href="#">Toggle</a>
    <a id="empty-href" href="">Empty</a>
  `;
  runtime.initRuntime();

  for (const id of ['hash-only', 'empty-href']) {
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    document.getElementById(id)!.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, `${id}: Pusha must not preventDefault`);
  }

  await new Promise((r) => setTimeout(r, 30));
  console.error('DEBUG_FETCHES', JSON.stringify(fetchCalls.map((c) => c.url)));
  assert.equal(fetchCalls.length, 0, 'neither navigates nor warms the current page');

  // A real link to the page you are already on is a different case: it still
  // gets the scroll-to-top treatment rather than a pointless re-fetch.
  document.body.insertAdjacentHTML('beforeend', `<a id="same-url" href="/">Home</a>`);
  const sameUrlEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  document.getElementById('same-url')!.dispatchEvent(sameUrlEvent);
  assert.equal(sameUrlEvent.defaultPrevented, true, 'same-URL link is still handled');
});

test('cleanup runs on every swap, not only in the theme editor', async () => {
  // Both of these were documented as firing before the container is replaced and
  // in fact only ran on shopify:section:unload. A section cleaning up through
  // sectionDestroy leaked on every navigation while looking correct in preview.
  const calls: string[] = [];
  let connectedAtDestroy: boolean | null = null;

  registryModule.registry.register('leaky', {
    init() {},
    destroy(root) {
      calls.push('registry.destroy');
      connectedAtDestroy = (root as HTMLElement).isConnected;
    },
  });
  window.theme = window.theme ?? {};
  window.theme.sectionDestroy = {
    hero: (root: HTMLElement) => {
      calls.push('sectionDestroy.hero');
      connectedAtDestroy = root.isConnected;
    },
  };

  document.querySelector('#MainContent')!.innerHTML =
    '<div data-section-type="hero">hero</div>';

  runtime.initRuntime();
  await runtime.go('/products/bar');

  assert.deepEqual(calls, ['sectionDestroy.hero', 'registry.destroy']);
  assert.equal(connectedAtDestroy, true, 'cleanup sees still-connected DOM');
});

test('a cleanup handler that throws does not abort the navigation', async () => {
  registryModule.registry.register('broken-cleanup', {
    init() {},
    destroy() {
      throw new Error('observer already gone');
    },
  });
  window.theme = window.theme ?? {};
  window.theme.sectionDestroy = {
    hero: () => {
      throw new Error('interval already cleared');
    },
  };
  document.querySelector('#MainContent')!.innerHTML =
    '<div data-section-type="hero">hero</div>';

  let navError: unknown = null;
  hooks.onNavError((error) => {
    navError = error;
  });

  runtime.initRuntime();
  await runtime.go('/products/bar');

  assert.equal(navError, null, 'the swap still completed');
  assert.equal(window.location.pathname, '/products/bar');
});

test('cleanup does not run when the navigation is about to fall back', async () => {
  // The response has no container, so this nav hard-reloads. Tearing the page
  // down first would leave the buyer looking at a dead page until it reloads.
  let destroyed = 0;
  registryModule.registry.register('counted', {
    init() {},
    destroy() {
      destroyed++;
    },
  });
  fetchResponder = () => ({ status: 200, body: '<!doctype html><html><body><p>no container</p></body></html>' });

  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(destroyed, 0, 'nothing was torn down');
});

test('islands revalidate on a #hash URL', async () => {
  // Regression: the section query was appended to a URL that still carried its
  // fragment, so `?sections=` landed INSIDE the hash. The server returned HTML,
  // res.json() threw, and the catch swallowed it — islands silently never
  // revalidated on any hash URL.
  const requested: string[] = [];
  const islandHtml = '<div data-island data-section-id="price"><span id="p">£20</span></div>';

  (globalThis as Record<string, unknown>).fetch = async (input: string | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('sections=')) {
      return new Response(JSON.stringify({ price: islandHtml }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      makePageHtml('product', '<div data-island data-section-id="price"><span id="p">£10</span></div>'),
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    );
  };

  document.body.insertAdjacentHTML('beforeend', '<a id="hashed" href="/products/foo#reviews">Foo</a>');
  runtime.initRuntime({ prefetchConfig: { product: { soft: 1, hard: 60_000 } } });

  // Warm the cache so the nav is a cached one — islands only revalidate then.
  const prefetch = await import('../src/prefetch.ts');
  await prefetch.prefetchPage('/products/foo');
  document.getElementById('hashed')!.click();
  await new Promise((r) => setTimeout(r, 80));

  const sectionsCall = requested.find((u) => u.includes('sections='));
  assert.ok(sectionsCall, `a ?sections= request was made — got ${JSON.stringify(requested)}`);
  const parsed = new URL(sectionsCall!, 'https://shop.test');
  assert.equal(parsed.searchParams.get('sections'), 'price', 'the param is a real query param');
  assert.equal(parsed.hash, '', 'the fragment is dropped, not carried into the query');
  assert.equal(parsed.pathname, '/products/foo');
});

test('islands: .is-revalidating is cleared even when nothing was swapped', async () => {
  // Found in a browser. The class used to come off only because
  // `wrapper.replaceWith()` destroyed the node carrying it, so any path that
  // did not swap left it on a live element forever — and a theme styling it as
  // a dim or skeleton got a region that never came back.
  //
  // This fixture has the island marker but no `#shopify-section-price` wrapper
  // to swap into, which is the exact shape the pre-existing hash test already
  // had without anyone noticing.
  const islandHtml = '<div data-island data-section-id="price">£20</div>';
  (globalThis as Record<string, unknown>).fetch = async (input: string | URL) => {
    const url = String(input);
    if (url.includes('sections=')) {
      return new Response(JSON.stringify({ price: islandHtml }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      makePageHtml('product', '<div data-island data-section-id="price">£10</div>'),
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    );
  };

  runtime.initRuntime({ prefetchConfig: { product: { soft: 1, hard: 60_000 } } });
  const prefetch = await import('../src/prefetch.ts');
  await prefetch.prefetchPage('/products/foo');
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(
    document.querySelectorAll('.is-revalidating').length,
    0,
    'no element is left dimmed after the cycle finishes',
  );
});

test('islands: the event reports what was applied, not what was requested', async () => {
  // The old diagnostic counted keys in the response, so "swapped 1" printed
  // whether or not a node had been touched. Same for the event's sectionIds.
  // A listener re-initialising the regions it names would have been re-running
  // against markup that never changed.
  const detail: Array<Record<string, unknown>> = [];
  document.addEventListener('pjax:islands-revalidated', (e) => {
    detail.push((e as CustomEvent).detail);
  });

  (globalThis as Record<string, unknown>).fetch = async (input: string | URL) => {
    const url = String(input);
    if (url.includes('sections=')) {
      // Two sections come back; only `price` has somewhere to go.
      return new Response(
        JSON.stringify({
          price: '<div id="shopify-section-price"><div data-island data-section-id="price">£20</div></div>',
          ghost: '<div id="shopify-section-ghost">nowhere</div>',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(
      makePageHtml(
        'product',
        '<div id="shopify-section-price"><div data-island data-section-id="price">£10</div></div>' +
          '<div data-island data-section-id="ghost">no wrapper for me</div>',
      ),
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    );
  };

  runtime.initRuntime({ prefetchConfig: { product: { soft: 1, hard: 60_000 } } });
  const prefetch = await import('../src/prefetch.ts');
  await prefetch.prefetchPage('/products/foo');
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(detail.length, 1, 'the event fires once');
  assert.deepEqual(detail[0].sectionIds, ['price'], 'only the section that actually swapped');
  assert.deepEqual(
    (detail[0].requestedIds as string[]).sort(),
    ['ghost', 'price'],
    'what was asked for is still reported, separately',
  );
  assert.equal(document.querySelectorAll('.is-revalidating').length, 0, 'nothing left dimmed');
});

test('stylesheets in section bodies are synced, and only once', async () => {
  // Shopify's stylesheet_tag emits the link inside the section body, so a
  // head-only scan missed every section stylesheet and the first visit to each
  // template rendered unstyled.
  fetchResponder = () => ({
    status: 200,
    body: makePageHtml(
      'product',
      '<link rel="stylesheet" href="/section-price.css"><h1>Product</h1>',
    ),
  });

  runtime.initRuntime();
  await runtime.go('/products/bar');
  const links = () =>
    Array.from(document.head.querySelectorAll('link[rel="stylesheet"]'))
      .filter((l) => l.getAttribute('href') === '/section-price.css');
  assert.equal(links().length, 1, 'the section stylesheet reached <head>');

  // Returning to the same template must not append it again — the link lives in
  // the swapped container, so it is destroyed while its rules stay applied.
  await runtime.go('/products/baz');
  assert.equal(links().length, 1, 'not re-appended on a return visit');
});

test('a stylesheet href containing a quote does not abort the navigation', async () => {
  // Unescaped in a selector this throws SyntaxError, which drops the page to a
  // full browser load with no explanation.
  fetchResponder = () => ({
    status: 200,
    body: makePageHtml('product', `<link rel="stylesheet" href='/a"b.css'><h1>Product</h1>`),
  });
  let navError: unknown = null;
  hooks.onNavError((error) => {
    navError = error;
  });

  runtime.initRuntime();
  await runtime.go('/products/bar');
  assert.equal(navError, null, 'no error — the swap completed');
  assert.equal(window.location.pathname, '/products/bar');
});

test('prefetch never runs more than two requests at once', async () => {
  // Live finding: nav-link warmup plus viewport warming burst against
  // `shopify theme dev` and it starts returning 502s — which then break the
  // theme's own fetches. Speculative work must never be why a real request
  // fails. Fetches here resolve on their own timer rather than on demand, so
  // the test can never strand a promise the way a manual gate can.
  let inFlight = 0;
  let peak = 0;
  let served = 0;

  (globalThis as Record<string, unknown>).fetch = () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    return new Promise<Response>((resolve) => {
      setTimeout(() => {
        inFlight--;
        served++;
        resolve(new Response(makePageHtml('product', '<h1>x</h1>'), {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }));
      }, 15);
    });
  };

  // No initRuntime: nav-link warmup would add its own traffic and blur the
  // measurement. The limiter is what is under test.
  const prefetch = await import('../src/prefetch.ts');
  await Promise.all(['/a', '/b', '/c', '/d', '/e', '/f'].map((path) => prefetch.prefetchPage(path)));

  assert.equal(served, 6, 'every warm was served — none dropped');
  assert.equal(peak, 2, `at most two concurrent — saw ${peak}`);
  assert.equal(inFlight, 0, 'no slot left held');
});

test('peekInFlight ignores a warm that is still queued for a slot', async () => {
  // The stall that motivated this: two warms hold both slots of
  // MAX_CONCURRENT_PREFETCH and never resolve, so a third is queued with no
  // bytes on the wire. navigate() must not await it — it has not started.
  const release: Array<() => void> = [];
  (globalThis as Record<string, unknown>).fetch = () =>
    new Promise<Response>((resolve) => {
      release.push(() =>
        resolve(new Response(makePageHtml('product', '<h1>x</h1>'), {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })),
      );
    });

  const prefetch = await import('../src/prefetch.ts');
  void prefetch.prefetchPage('/a');
  void prefetch.prefetchPage('/b');
  void prefetch.prefetchPage('/queued');
  // Let the two that won slots reach fetch().
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(release.length, 2, 'exactly two warms are on the wire');
  assert.notEqual(prefetch.peekInFlight('/a'), null, 'a started warm is still offered');
  assert.equal(
    prefetch.peekInFlight('/queued'),
    null,
    'a queued warm is withheld — awaiting it would stall the navigation',
  );

  // Once a slot frees and the queued warm starts, it becomes dedup-worthy.
  release[0]();
  await new Promise((r) => setTimeout(r, 0));
  assert.notEqual(prefetch.peekInFlight('/queued'), null, 'offered once it starts');

  release.forEach((fn) => fn());
});

test('a redirect log fires only when the page actually moved', async () => {
  // `response.url` never carries a fragment, so comparing before restoring it
  // made every #hash navigation report as a redirect.
  const logs: string[] = [];
  const originalWarn = console.warn;
  fetchResponder = () => ({ status: 200, body: makePageHtml('product', '<h1>Product</h1>') });

  const diagnostics = await import('../src/diagnostics.ts');
  diagnostics.setDebug(true);
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    document.body.insertAdjacentHTML('beforeend', '<a id="hashed" href="/products/foo#reviews">Foo</a>');
    runtime.initRuntime({ debug: true });
    document.getElementById('hashed')!.click();
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    diagnostics.setDebug(false);
  }

  assert.equal(
    logs.some((l) => l.includes('redirected')),
    false,
    `a hash navigation is not a redirect — got ${JSON.stringify(logs.filter((l) => l.includes('redirect')))}`,
  );
  assert.equal(window.location.pathname, '/products/foo');
  assert.equal(window.location.hash, '#reviews', 'the fragment survives');
});

test('a navigation that never resolves falls back to a full browser load', async () => {
  // Without a cap the container sits faded at opacity 0 forever: the fetch never
  // settles, so neither the swap nor the error path ever runs.
  (globalThis as Record<string, unknown>).fetch = () => new Promise<Response>(() => {});

  let navError: unknown = null;
  hooks.onNavError((error) => {
    navError = error;
  });

  runtime.initRuntime({ timeout: 60 });
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 250));

  assert.ok(navError, 'onNavError fired');
  assert.equal((navError as Error).name, 'TimeoutError');
  assert.match((navError as Error).message, /timed out after 60ms/);
});

test('a cross-origin redirect is refused rather than parsed into this origin', async () => {
  // fetch() follows redirects transparently. Parsing the result would inject
  // another origin's <script src> tags into the shop's own document.
  (globalThis as Record<string, unknown>).fetch = async () => {
    const res = new Response(makePageHtml('product', '<h1>Elsewhere</h1>'), {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    Object.defineProperty(res, 'url', { value: 'https://evil.example/products/foo' });
    return res;
  };

  let navError: unknown = null;
  hooks.onNavError((error) => {
    navError = error;
  });

  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 60));

  assert.ok(navError, 'onNavError fired instead of swapping');
  assert.match((navError as Error).message, /cross-origin redirect to https:\/\/evil\.example/);
  assert.equal(document.querySelector('h1')?.textContent, 'Home', 'container never swapped');
});

test('a same-origin redirect records the URL the buyer actually landed on', async () => {
  // Shopify issues these on every handle change. Pushing the requested path
  // would leave the address bar on a page that no longer exists.
  (globalThis as Record<string, unknown>).fetch = async () => {
    const res = new Response(makePageHtml('product', '<h1>Renamed</h1>'), {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    Object.defineProperty(res, 'url', { value: 'https://shop.test/products/foo-v2' });
    return res;
  };

  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(window.location.pathname, '/products/foo-v2', 'final URL is in history');
  assert.equal(document.querySelector('h1')?.textContent, 'Renamed');
});

test('a component that throws does not take down the rest, or PJAX itself', async () => {
  // At boot initAll runs before the click listener is installed, so an uncaught
  // throw here used to mean PJAX silently never started.
  let goodInits = 0;
  registryModule.registry.register('bad', {
    init() {
      throw new Error('component is broken');
    },
  });
  registryModule.registry.register('good', {
    init() {
      goodInits++;
    },
  });

  runtime.initRuntime();
  assert.equal(goodInits, 1, 'the component after the thrower still initialized');

  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(fetchCalls.length, 1, 'link interception was still installed');
  assert.equal(window.location.pathname, '/products/foo', 'navigation completed');
  assert.equal(goodInits, 2, 'the good component re-initialized on swap');
});

test('a transition that throws falls back to CSS instead of reloading the page', async () => {
  const transitionsModule = await import('../src/transitions.ts');
  transitionsModule.registerTransition({
    name: 'broken',
    leave() {
      throw new Error('anime is not defined');
    },
    enter() {
      throw new Error('anime is not defined');
    },
  });

  let navError: unknown = null;
  hooks.onNavError((error) => {
    navError = error;
  });

  runtime.initRuntime({ transitions: true });
  await runtime.go('/products/bar', { transition: 'broken' });

  assert.equal(navError, null, 'no navigation error — the swap still happened');
  assert.equal(window.location.pathname, '/products/bar');
});

test('a superseded navigation does not release state the live one still owns', async () => {
  // Regression: nav A's `finally` reset isTransitioning/currentNavigation
  // unconditionally after B aborted it. The runtime then believed nothing was
  // in flight, so a third click never aborted B — B and C both swapped, and the
  // URL bar and the content ended up from different pages.
  const seen: Array<{ url: string; signal: AbortSignal }> = [];
  const releases: Array<() => void> = [];

  (globalThis as Record<string, unknown>).fetch = (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const signal = init!.signal as AbortSignal;
    seen.push({ url, signal });
    return new Promise<Response>((resolve, reject) => {
      releases.push(() =>
        resolve(new Response(makePageHtml('product', `<h1>${url}</h1>`), {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })),
      );
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };

  document.body.innerHTML += `
    <a id="nav-a" href="/products/a">A</a>
    <a id="nav-b" href="/products/b">B</a>
    <a id="nav-c" href="/products/c">C</a>
  `;
  runtime.initRuntime();

  document.getElementById('nav-a')!.click();
  await new Promise((r) => setTimeout(r, 10));
  document.getElementById('nav-b')!.click();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(seen.length, 2, 'A and B both reached fetch');
  assert.equal(seen[0].signal.aborted, true, 'B aborted A');
  assert.equal(seen[1].signal.aborted, false, 'B is still in flight');

  // A's rejection has settled and run its finally block by now.
  document.getElementById('nav-c')!.click();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(seen.length, 3, 'C reached fetch');
  assert.equal(seen[1].signal.aborted, true, 'C aborted B — A did not clear the live controller');

  releases.forEach((release) => release());
  await new Promise((r) => setTimeout(r, 20));
});

test('data-pusha-close-on-nav strips [open] from <details> on PJAX leave', async () => {
  document.body.insertAdjacentHTML('afterbegin', `
    <header>
      <details id="search-modal" open data-pusha-close-on-nav>
        <summary>Search</summary>
        <a href="/products/foo" id="result-link">Result</a>
      </details>
    </header>
  `);

  runtime.initRuntime();
  assert.equal(document.getElementById('search-modal')!.hasAttribute('open'), true, 'modal starts open');

  document.getElementById('result-link')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(
    document.getElementById('search-modal')!.hasAttribute('open'),
    false,
    'PJAX nav strips [open] when data-pusha-close-on-nav is set',
  );
});

test('data-pusha-close-on-nav toggles aria-expanded + strips body classes on leave', async () => {
  document.body.insertAdjacentHTML('afterbegin', `
    <header>
      <div id="menu-drawer" data-pusha-close-on-nav data-pusha-body-class-on-open="overflow-hidden menu-open" aria-expanded="true">
        <a href="/collections/all" id="nav-link">Nav</a>
      </div>
    </header>
  `);
  document.body.classList.add('overflow-hidden', 'menu-open');

  runtime.initRuntime();
  assert.equal(document.body.classList.contains('overflow-hidden'), true, 'pre-nav body has scroll lock');

  document.getElementById('nav-link')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(
    document.getElementById('menu-drawer')!.getAttribute('aria-expanded'),
    'false',
    'aria-expanded reset to false on nav',
  );
  assert.equal(document.body.classList.contains('overflow-hidden'), false, 'body scroll lock removed');
  assert.equal(document.body.classList.contains('menu-open'), false, 'body open-marker class removed');
});

test('data-pusha-close-on-nav calls custom closeOnNav() method when present', async () => {
  let calledOnModal = false;
  document.body.insertAdjacentHTML('afterbegin', `
    <header>
      <custom-modal id="custom" data-pusha-close-on-nav open>
        <a href="/products/foo" id="custom-link">Link</a>
      </custom-modal>
    </header>
  `);
  // Hang the method directly on the instance (simpler than registering a custom element).
  (document.getElementById('custom') as unknown as { closeOnNav: () => void }).closeOnNav = function () {
    calledOnModal = (this as unknown as Element).id === 'custom';
  };

  runtime.initRuntime();
  document.getElementById('custom-link')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(calledOnModal, 'closeOnNav() called with the modal element as this');
  // Standard shapes should be skipped when custom method is present — [open] stays
  // because the theme's method is responsible for whatever close behavior it wants.
  assert.equal(
    document.getElementById('custom')!.hasAttribute('open'),
    true,
    'standard [open] strip skipped when closeOnNav() handles it',
  );
});

test('persistent modal WITHOUT data-pusha-close-on-nav is left alone (cart-drawer pattern)', async () => {
  document.body.insertAdjacentHTML('afterbegin', `
    <header>
      <details id="cart-drawer" open>
        <summary>Cart</summary>
        <a href="/products/foo" id="cart-link">Continue</a>
      </details>
    </header>
  `);

  runtime.initRuntime();
  document.getElementById('cart-link')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(
    document.getElementById('cart-drawer')!.hasAttribute('open'),
    true,
    'modal without opt-in marker stays open — preserves cart-drawer UX',
  );
});

test('nav-link warmup excludes SHOPIFY_RESERVED routes (incl. /customer_authentication)', async () => {
  const prefetchModule = await import('../src/prefetch.ts');

  // Existing fixture has <header id="header-group"><a href="/products/foo"> — replace
  // it with a header full of reserved-route links, mimicking Dawn's account/locale nav.
  document.querySelector('#header-group')!.innerHTML = `
    <a href="/customer_authentication/redirect?locale=en">Account</a>
    <a href="/account/login">Login</a>
    <a href="/localization?country=US">Locale</a>
    <a href="/password">Password</a>
    <a href="/gift_cards/abc">Gift card</a>
    <a href="/a/app-proxy">App proxy</a>
    <a href="/checkout">Checkout</a>
    <a href="/cart">Cart</a>
    <a href="/collections/all">Collections</a>
  `;

  prefetchModule.warmupNavLinks();
  // Force the requestIdleCallback fallback to fire — jsdom has no idle.
  await new Promise((r) => setTimeout(r, 250));

  const warmedUrls = fetchCalls.map((c) => c.url);
  for (const blocked of ['customer_authentication', '/account/login', '/localization', '/password', '/gift_cards', '/a/app-proxy', '/checkout', '/cart']) {
    assert.ok(
      !warmedUrls.some((u) => u.includes(blocked)),
      `nav warmup must not prefetch ${blocked}`,
    );
  }
  assert.ok(warmedUrls.some((u) => u.includes('/collections/all')), 'normal links still warmed');
});

test('a scheduled nav-link warmup does not survive a reset', async () => {
  // The leak this pins: warmup schedules a callback 200ms out and nothing held
  // the handle, so a warmup scheduled by one test fired inside a later one and
  // spent a fetch on the fresh document's nav links. It surfaced as the
  // concurrency test seeing a seventh request it had not accounted for —
  // intermittently, and only on the node version whose timing lined the two up.
  // Asserting on fetch traffic after a reset is the honest shape: the stray
  // request is the damage, wherever it lands.
  const prefetchModule = await import('../src/prefetch.ts');

  prefetchModule.warmupNavLinks();
  prefetchModule._resetPrefetchForTests();

  const before = fetchCalls.length;
  await new Promise((r) => setTimeout(r, 250));

  assert.equal(
    fetchCalls.length,
    before,
    'a warmup cancelled by reset must not reach the wire',
  );
});

test('/cart IS intercepted (regular themed page)', async () => {
  document.body.innerHTML += `<a id="cart" href="/cart">Cart</a>`;
  runtime.initRuntime();
  document.getElementById('cart')!.click();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(fetchCalls.some((c) => c.url.endsWith('/cart')), 'cart link goes through PJAX');
});

test('custom element connectedCallback fires on the swapped-in container', async () => {
  // Regression test for the Dawn variant-picker class of bug: nested custom
  // elements inside the swapped container must be upgraded against the live
  // registry. Requires document.importNode + customElements.upgrade in runtime.
  const w = window as unknown as { HTMLElement: typeof HTMLElement; customElements: CustomElementRegistry };
  let connectedCount = 0;
  class FakeVariant extends w.HTMLElement {
    connectedCallback() {
      connectedCount++;
    }
  }
  if (!w.customElements.get('fake-variant')) {
    w.customElements.define('fake-variant', FakeVariant);
  }

  const initial = document.createElement('fake-variant');
  document.querySelector('#MainContent')!.appendChild(initial);
  const baseline = connectedCount;

  fetchResponder = () => ({
    status: 200,
    body: makePageHtml('product', `<h1>Product</h1><fake-variant id="post-swap"></fake-variant>`),
  });

  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  const post = document.querySelector<HTMLElement>('#post-swap');
  assert.ok(post, 'custom element exists in swapped DOM');
  assert.ok(post instanceof FakeVariant, 'custom element is upgraded to its class');
  assert.ok(connectedCount > baseline, 'connectedCallback fired for the swapped-in custom element');
});

test('script[src] in section body is loaded on swap (not just <head>)', async () => {
  // Shopify section JS commonly lives in section bodies, not content_for_header.
  // Pusha has to scan the whole new doc — not just <head> — and re-add those
  // scripts to the live <head> so they execute. Without this, a custom element
  // defined in a section's <script src> never registers after PJAX nav.
  fetchResponder = () => ({
    status: 200,
    body: makePageHtml(
      'product',
      `<h1>Product</h1>
       <script src="/cdn/section-product-info.js?v=1"></script>`,
    ),
  });

  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  // The new <head> should contain a script tag for the section-body script.
  const found = Array.from(document.head.querySelectorAll<HTMLScriptElement>('script[src]'))
    .some((s) => s.src.includes('section-product-info.js'));
  assert.ok(found, 'section-body <script src> was re-added to <head>');
});

test('syncHeadScripts preserves type="module" and other attributes', async () => {
  // Shopify injects ESM bundles (loader.payment-terms.esm.js, portable-wallets.en.js)
  // as <script src=... type="module">. The previous loadScript impl dropped every
  // attribute except src, so the browser parsed module syntax as a classic script
  // and threw "Cannot use import statement outside a module" on every PDP swap.
  fetchResponder = () => ({
    status: 200,
    body: makePageHtml(
      'product',
      `<h1>Product</h1>
       <script src="/cdn/payment-terms.esm.js" type="module" crossorigin="anonymous"></script>
       <script src="/cdn/classic.js" defer></script>`,
    ),
  });

  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  const scripts = Array.from(document.head.querySelectorAll<HTMLScriptElement>('script[src]'));
  const esm = scripts.find((s) => s.src.includes('payment-terms.esm.js'));
  const classic = scripts.find((s) => s.src.includes('classic.js'));

  assert.ok(esm, 'ESM script was re-added');
  assert.equal(esm!.getAttribute('type'), 'module', 'type="module" preserved');
  assert.equal(esm!.getAttribute('crossorigin'), 'anonymous', 'crossorigin preserved');

  assert.ok(classic, 'classic script was re-added');
  assert.equal(classic!.hasAttribute('defer'), true, 'defer attribute preserved');
});

test('custom element defined AFTER initRuntime still upgrades on next swap', async () => {
  // The "Dawn product-info" case: script that defines the element either lives
  // in section body (not <head>) or loads asynchronously, so the registry may
  // not have the definition when the FIRST swap happens. The element should
  // still upgrade via the explicit customElements.upgrade() walk on later swaps.
  const w = window as unknown as { HTMLElement: typeof HTMLElement; customElements: CustomElementRegistry };
  let connectedCount = 0;
  class LateDefined extends w.HTMLElement {
    connectedCallback() {
      connectedCount++;
    }
  }

  runtime.initRuntime();

  // Define AFTER initRuntime but BEFORE the nav.
  if (!w.customElements.get('late-defined')) {
    w.customElements.define('late-defined', LateDefined);
  }

  fetchResponder = () => ({
    status: 200,
    body: makePageHtml('product', `<late-defined id="late"></late-defined>`),
  });

  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  const post = document.querySelector<HTMLElement>('#late');
  assert.ok(post, 'late-defined element present');
  assert.ok(post instanceof LateDefined, 'late-defined element upgraded to class');
  assert.equal(connectedCount, 1, 'connectedCallback fired exactly once');
});

test('elements with data-pusha-cleanup are removed before nav', async () => {
  // Dawn's <product-modal> portals to body in connectedCallback and survives
  // PJAX swaps. Marking the element with data-pusha-cleanup tells Pusha to
  // remove it before each nav.
  const portal = document.createElement('div');
  portal.id = 'leaked-modal';
  portal.setAttribute('data-pusha-cleanup', '');
  document.body.appendChild(portal);

  runtime.initRuntime();
  assert.ok(document.getElementById('leaked-modal'), 'portal present before nav');

  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(document.getElementById('leaked-modal'), null, 'portal removed during nav');
});

test('transitions: false skips the class dance', async () => {
  // No CSS in jsdom anyway, but assert no class is added when the flag is off.
  let sawTransitionClass = false;
  const observer = new (window as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver(
    (mutations) => {
      for (const m of mutations) {
        if (m.attributeName === 'class') {
          const cls = (m.target as Element).className;
          if (typeof cls === 'string' && cls.includes('is-transitioning-')) {
            sawTransitionClass = true;
          }
        }
      }
    },
  );
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  runtime.initRuntime({ transitions: false });
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));
  observer.disconnect();

  assert.equal(sawTransitionClass, false, 'no is-transitioning-* class added with transitions: false');
});

test('updateMetadata syncs title and meta description on swap', async () => {
  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(document.title, 'product page');
  const desc = document.querySelector('meta[name="description"]');
  assert.equal(desc?.getAttribute('content'), 'product description');
  assert.equal(document.body.getAttribute('data-template'), 'product');
});

test('onBeforeNav returning false cancels navigation', async () => {
  hooks.onBeforeNav(() => false);

  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(fetchCalls.length, 0, 'fetch skipped when onBeforeNav returns false');
});

test('nav with in-flight prefetch for same URL awaits it (no duplicate fetch)', async () => {
  // The hover-prefetch race: user hovers a link (prefetch starts), then clicks
  // before the warmup finishes. Pre-fix, the nav fired a fresh fetch in parallel
  // — two requests for the same bytes. Post-fix, the nav awaits the in-flight
  // prefetch instead.
  const prefetchModule = await import('../src/prefetch.ts');
  prefetchModule.invalidateCache();

  let resolveFetch: ((body: string) => void) | null = null;
  let fetchCount = 0;
  (globalThis as Record<string, unknown>).fetch = async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    void url;
    fetchCount++;
    return new Promise<Response>((resolve) => {
      resolveFetch = (body: string) => {
        resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } }));
      };
    });
  };

  runtime.initRuntime({
    prefetchConfig: { product: { soft: 30000, hard: 300000 } },
  });

  // Step 1: simulate hover-warmup kicking off a prefetch for the URL.
  void prefetchModule.prefetchPage('/products/foo');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(fetchCount, 1, 'prefetch started exactly one fetch');

  // Step 2: user clicks the same URL while prefetch is still in-flight.
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetchCount, 1, 'nav did NOT fire a second fetch — awaited in-flight prefetch');

  // Step 3: resolve the in-flight prefetch and let nav complete.
  resolveFetch!(makePageHtml('product', '<h1>Product</h1>'));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fetchCount, 1, 'still exactly one fetch after nav fully completes');
  assert.equal(window.location.pathname, '/products/foo', 'nav landed on the target URL');
});

test('checkContainer ignores sections with no procedural scripts (pure presentational)', async () => {
  // Dawn pattern: image_banner / rich_text / collage are pure markup sections
  // with no client-side JS at all. Pre-fix, debug noisily flagged them as
  // "won't initialize on swap" even though there was nothing to initialize.
  const diag = await import('../src/diagnostics.ts');

  const container = document.createElement('div');
  container.innerHTML = `
    <section id="shopify-section-image-banner" data-section-id="image-banner">
      <h2>Welcome</h2>
      <p>Some marketing copy</p>
    </section>
    <section id="shopify-section-rich-text" data-section-id="rich-text">
      <div>{{ section.settings.text }}</div>
    </section>
    <section data-section-id="needs-init">
      <div>This one has procedural code</div>
      <script>console.log('hi')</script>
    </section>
  `;

  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    diag.checkContainer(container as HTMLElement, { url: '/', template: 'index', cached: false });
  } finally {
    console.warn = origWarn;
  }

  const message = warns.join('\n');
  assert.ok(!message.includes('image-banner'), 'pure presentational section NOT flagged');
  assert.ok(!message.includes('rich-text'), 'pure presentational section NOT flagged');
  assert.ok(message.includes('needs-init'), 'section with procedural script IS flagged');
});

test('checkContainer treats application/json and application/ld+json as data, not code', async () => {
  // Dawn PDP has `<script id="ProductJSON-..." type="application/json">` for the
  // 3D viewer payload and `<script type="application/ld+json">` for SEO. Both
  // are bucket B (non-executable data) in the audit. The runtime warning was
  // matching by tag name only, which fired false positives on every PDP swap.
  const diag = await import('../src/diagnostics.ts');

  const container = document.createElement('div');
  container.innerHTML = `
    <section data-section-type="product">
      <script type="application/json" id="ProductJSON-123">{"variant":"foo"}</script>
      <script type="application/ld+json">{"@context":"https://schema.org"}</script>
    </section>
    <section data-section-type="needs-wrap">
      <script>console.log('procedural — should fire warning')</script>
    </section>
  `;

  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    diag.checkContainer(container as HTMLElement, { url: '/products/x', template: 'product', cached: false });
  } finally {
    console.warn = origWarn;
  }

  // Exactly one inline-script warning (the procedural one), and it shouldn't
  // mention the ProductJSON or ld+json scripts in the NodeList summary.
  const inlineWarnings = warns.filter((w) => w.includes('inline <script>'));
  assert.equal(inlineWarnings.length, 1, 'one inline-script warning fires');
});

test('initActiveLinks toggles aria-current and is-current on swap, syncs body template class', async () => {
  const { initActiveLinks } = await import('../src/active-links.ts');

  // Persistent header with two opt-in nav containers and links.
  document.body.insertAdjacentHTML('afterbegin', `
    <header>
      <nav data-pusha-active-links>
        <a href="/" id="link-home">Home</a>
        <a href="/collections/all" id="link-coll">Collections</a>
        <a href="/collections/all/products/foo" id="link-prod">Product</a>
      </nav>
    </header>
  `);
  document.body.setAttribute('data-template', 'index');
  document.body.className = 'theme-default template-stale';

  runtime.initRuntime();
  initActiveLinks();

  // Initial mount: location is "/", so home link is current, body class fixed.
  assert.equal(document.getElementById('link-home')!.getAttribute('aria-current'), 'page');
  assert.equal(document.getElementById('link-home')!.classList.contains('is-current'), true);
  assert.equal(document.getElementById('link-coll')!.hasAttribute('aria-current'), false);
  assert.equal(document.body.classList.contains('template-stale'), false, 'old template-* class stripped');
  assert.equal(document.body.classList.contains('template-index'), true, 'new template class from data-template');

  // Navigate to /collections/all. After swap, collection link should be current,
  // home link should become ancestor (path "/" never matches as ancestor by design),
  // product link should be ancestor of collection.
  fetchResponder = () => ({
    status: 200,
    body: makePageHtml('collection', `<h1>Collection</h1>`),
  });
  document.getElementById('link-coll')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(document.getElementById('link-home')!.hasAttribute('aria-current'), false);
  assert.equal(document.getElementById('link-coll')!.getAttribute('aria-current'), 'page');
  assert.equal(document.getElementById('link-coll')!.classList.contains('is-current'), true);
  assert.equal(document.body.classList.contains('template-collection'), true, 'body template class swapped to collection');
  assert.equal(document.body.classList.contains('template-index'), false, 'previous template class removed');
});

test('initActiveLinks does NOT inject template-* body class for themes that do not use the convention', async () => {
  const { initActiveLinks } = await import('../src/active-links.ts');

  // Body has data-template but no template-* class on it — theme styles via
  // [data-template] selectors only. We must not inject `template-index`.
  document.body.setAttribute('data-template', 'index');
  document.body.className = 'theme-default color-scheme-light';

  runtime.initRuntime();
  initActiveLinks();

  assert.equal(
    document.body.classList.contains('template-index'),
    false,
    'no template-* class injected on a theme that does not opt in',
  );
  assert.equal(
    document.body.classList.contains('theme-default'),
    true,
    'pre-existing non-template classes preserved',
  );
});

test('initActiveLinks honors per-link data-pusha-current-class override (skips is-current default)', async () => {
  const { initActiveLinks } = await import('../src/active-links.ts');

  document.body.insertAdjacentHTML('afterbegin', `
    <header>
      <nav data-pusha-active-links>
        <a href="/" id="link-home" data-pusha-current-class="theme-home-active">Home</a>
        <a href="/collections/all" id="link-coll">Collections</a>
      </nav>
    </header>
  `);

  runtime.initRuntime();
  initActiveLinks();

  const home = document.getElementById('link-home')!;
  const coll = document.getElementById('link-coll')!;
  assert.equal(home.classList.contains('theme-home-active'), true, 'override class set when current');
  assert.equal(home.classList.contains('is-current'), false, 'default class skipped when override present');
  assert.equal(home.getAttribute('aria-current'), 'page', 'aria-current still set via override');
  assert.equal(coll.classList.contains('is-current'), false);
  assert.equal(coll.classList.contains('is-ancestor'), false, 'no default classes on non-overridden non-current');
});

test('initActiveLinks honors data-pusha-active-class for current-OR-ancestor', async () => {
  const { initActiveLinks } = await import('../src/active-links.ts');

  document.body.insertAdjacentHTML('afterbegin', `
    <header>
      <nav data-pusha-active-links>
        <a href="/collections/all" id="link-coll" data-pusha-active-class="menu-item--active">Collections</a>
      </nav>
    </header>
  `);

  runtime.initRuntime();
  initActiveLinks();

  // Initial location is "/", so collections is neither current nor ancestor — class off.
  assert.equal(document.getElementById('link-coll')!.classList.contains('menu-item--active'), false);

  // Navigate to a descendant — collections should become ancestor and toggle the class on.
  fetchResponder = () => ({
    status: 200,
    body: makePageHtml('product', `<h1>Product</h1>`),
  });
  // Insert and click a link to the descendant URL.
  document.querySelector('nav')!.insertAdjacentHTML(
    'beforeend',
    `<a href="/collections/all/products/foo" id="jump">Jump</a>`,
  );
  document.getElementById('jump')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(
    document.getElementById('link-coll')!.classList.contains('menu-item--active'),
    true,
    'active-class toggles on for ancestor link after PJAX nav to descendant',
  );
});

test('initActiveLinks handles data-pusha-child-active-class on <summary> in <details> scope', async () => {
  const { initActiveLinks } = await import('../src/active-links.ts');

  document.body.insertAdjacentHTML('afterbegin', `
    <header>
      <nav data-pusha-active-links>
        <details>
          <summary id="summary-cat" data-pusha-child-active-class="menu-item--active">Catalog</summary>
          <a href="/collections/all" id="link-coll">Collections</a>
          <a href="/collections/sale" id="link-sale">Sale</a>
        </details>
      </nav>
    </header>
  `);

  fetchResponder = () => ({
    status: 200,
    body: makePageHtml('collection', `<h1>Collection</h1>`),
  });
  runtime.initRuntime();
  initActiveLinks();

  // Initial path "/" — no descendant matches.
  assert.equal(document.getElementById('summary-cat')!.classList.contains('menu-item--active'), false);

  // Navigate to /collections/sale — summary lights up.
  document.getElementById('link-sale')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(
    document.getElementById('summary-cat')!.classList.contains('menu-item--active'),
    true,
    'child-active class toggles when any descendant <a> matches current URL',
  );
});

test('checkContainer ignores section wrappers that contain a custom-element descendant', async () => {
  // The Dawn PDP pattern: <div class="shopify-section ..."><product-info>...</product-info></div>
  // The wrapper itself has no [data-section-type] and isn't a custom element,
  // but its child IS — initialization is self-mounting via the web component.
  // Pre-fix, debug noisily flagged these wrappers as bucket E candidates.
  const diag = await import('../src/diagnostics.ts');

  const container = document.createElement('div');
  // Both sections have a script (so the new "section has no init logic, skip"
  // exemption doesn't apply); the one with a custom-element descendant should
  // still be skipped because the custom element self-mounts.
  container.innerHTML = `
    <section id="shopify-section-with-ce">
      <product-info><div>inner</div></product-info>
      <script>doInit()</script>
    </section>
    <section id="shopify-section-bare">
      <div>no custom element here</div>
      <script>doInit()</script>
    </section>
  `;

  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    diag.checkContainer(container as HTMLElement, { url: '/', template: 'index', cached: false });
  } finally {
    console.warn = origWarn;
  }

  const message = warns.join('\n');
  assert.ok(message.includes('shopify-section-bare'), 'bare section with a script IS flagged');
  assert.ok(!message.includes('shopify-section-with-ce'), 'section wrapping a custom element is NOT flagged');
});

// ─── standardEvents bridge ──────────────────────────────────────────────────
// Coverage note: the bridge resolves the library two ways, and only one of them
// is reachable from here.
//
// The GLOBAL path (window.StandardEvents, for themes without an importmap) is
// covered positively below — a fake namespace on the global is exactly the shape
// a non-module theme installs, so the dispatch, the payload, and the malformed-
// global no-op are all observed rather than inferred.
//
// The IMPORTMAP path is not. The bare specifier resolves through the *theme's*
// importmap at runtime, and there is no honest way to fake that in jsdom without
// shipping a fake @shopify package into node_modules or making the specifier
// injectable in production code. It stays verified by hand:
// experiments/native-vs-pusha/standard-events-probe.md, Stage A.
//
// The two paths share everything after resolution — same dispatch, same payload
// — so the global tests do exercise that code. What they cannot prove is that a
// real importmap resolves.

test('standardEvents: a missing @shopify/standard-events module never breaks navigation', async () => {
  // Node cannot resolve the specifier, so the dynamic import rejects — the same
  // shape as a classic theme with no importmap entry.
  (window as unknown as { theme: { config: Record<string, unknown> } }).theme = {
    config: { analytics: { shopify: true, standardEvents: true } },
  };

  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };

  try {
    runtime.initRuntime();
    document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    console.warn = origWarn;
  }

  // The swap completed and the other bridges still fired.
  assert.equal(document.querySelector('#MainContent')?.getAttribute('data-page-type'), 'product');
  assert.deepEqual(analyticsPublishCalls, ['pusha:page_viewed']);
  // The rejected import is swallowed by design — no warning, no throw.
  assert.equal(
    warns.filter((w) => w.includes('standard-events') || w.includes('PageViewEvent')).length,
    0,
    'a missing standard-events module is a silent no-op, not a warning',
  );
});

test('standardEvents: falls back to window.StandardEvents when the importmap has no entry', async () => {
  // The non-module path from the dispatch guide: a theme without an importmap
  // entry assigns the namespace to a global instead. Node cannot resolve the bare
  // specifier here, so the dynamic import rejects and the global is the only way
  // the bridge can resolve — which is exactly the production shape this covers.
  const seen: Array<{ template: unknown; url: unknown }> = [];
  class FakePageViewEvent extends Event {
    page: { template?: unknown; url?: unknown };
    constructor(detail: { page: { template?: unknown; url?: unknown } }) {
      super('shopify:page:view', { bubbles: true });
      this.page = detail.page;
    }
  }
  (window as unknown as { StandardEvents: unknown }).StandardEvents = {
    PageViewEvent: FakePageViewEvent,
  };
  const onPageView = (e: Event) => {
    const page = (e as FakePageViewEvent).page;
    seen.push({ template: page.template, url: page.url });
  };
  document.addEventListener('shopify:page:view', onPageView);

  (window as unknown as { theme: { config: Record<string, unknown> } }).theme = {
    config: { analytics: { shopify: true, standardEvents: true } },
  };

  try {
    runtime.initRuntime();
    document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    document.removeEventListener('shopify:page:view', onPageView);
    delete (window as unknown as { StandardEvents?: unknown }).StandardEvents;
  }

  assert.equal(seen.length, 1, 'one shopify:page:view per swap, via the global fallback');
  // The payload is the documented StandardEventPage shape, and `template` comes
  // from the swapped container rather than the page we navigated away from.
  assert.equal(seen[0].template, 'product');
  assert.match(String(seen[0].url), /\/products\/foo$/);
});

test('standardEvents: a global without PageViewEvent is ignored, not called', async () => {
  // A theme could assign something else to the global, or assign it before the
  // module finishes loading. Duck-typing on PageViewEvent is what keeps that from
  // throwing mid-navigation.
  (window as unknown as { StandardEvents: unknown }).StandardEvents = { notTheRightShape: true };
  (window as unknown as { theme: { config: Record<string, unknown> } }).theme = {
    config: { analytics: { shopify: true, standardEvents: true } },
  };

  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };

  try {
    runtime.initRuntime();
    document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    console.warn = origWarn;
    delete (window as unknown as { StandardEvents?: unknown }).StandardEvents;
  }

  assert.equal(document.querySelector('#MainContent')?.getAttribute('data-page-type'), 'product');
  assert.equal(
    warns.filter((w) => w.includes('PageViewEvent')).length,
    0,
    'a malformed global is a silent no-op, not a warning',
  );
});

test('standardEvents: false leaves the rest of the analytics bridge intact', async () => {
  (window as unknown as { theme: { config: Record<string, unknown> } }).theme = {
    config: { analytics: { shopify: true, standardEvents: false } },
  };

  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(analyticsPageCalls, 1);
  assert.deepEqual(analyticsPublishCalls, ['pusha:page_viewed']);
});

test('analytics: false disables every bridge, standardEvents included', async () => {
  // Regression guard for a real footgun: `analytics: false` plus a top-level
  // `standardEvents: true` reads like "keep the standard-events bridge on" and
  // does the opposite. standardEvents is nested inside `analytics`, and there is
  // no top-level key of that name.
  (window as unknown as { theme: { config: Record<string, unknown> } }).theme = {
    config: { analytics: false, standardEvents: true },
  };

  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(analyticsPageCalls, 0, 'analytics: false disables the Shopify bridge');
  assert.deepEqual(analyticsPublishCalls, [], 'and the publish calls with it');
});

// ─── Prefetch enhancements ──────────────────────────────────────────────────

test('toPathKey strips tracking params and sorts the rest', async () => {
  const { toPathKey } = await import('../src/prefetch.ts');

  // Shopify's recommendation widgets append pr_* to every product link, which
  // would otherwise fragment one product into a cache entry per referring
  // section.
  assert.equal(
    toPathKey('/products/foo?pr_rec_id=abc&pr_prod_strat=hybrid&utm_source=ig'),
    '/products/foo',
  );
  // Param order shouldn't split the cache.
  assert.equal(toPathKey('/collections/all?b=2&a=1'), toPathKey('/collections/all?a=1&b=2'));
  // Hash never changes server-rendered content.
  assert.equal(toPathKey('/pages/about#team'), '/pages/about');
});

test('toPathKey preserves params that DO change the response', async () => {
  const { toPathKey } = await import('../src/prefetch.ts');

  // The deny-list must never eat a variant or a collection filter — dropping
  // either would serve the wrong page from cache.
  assert.equal(toPathKey('/products/foo?variant=42&utm_medium=email'), '/products/foo?variant=42');
  assert.match(toPathKey('/collections/all?filter.v.price.gte=10'), /filter\.v\.price\.gte=10/);
  assert.match(toPathKey('/collections/all?sort_by=price-ascending'), /sort_by=price-ascending/);
});

test('prefetch warms on focusin (keyboard parity with hover)', async () => {
  const prefetchModule = await import('../src/prefetch.ts');
  prefetchModule.invalidateCache();

  runtime.initRuntime({ prefetchConfig: { product: { soft: 30000, hard: 300000 } } });

  const link = document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!;
  link.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(
    fetchCalls.some((c) => c.url.includes('/products/foo')),
    'tabbing to a link warms it',
  );
});

test('prefetch warms on mouse pointerdown, not just touch', async () => {
  const prefetchModule = await import('../src/prefetch.ts');
  prefetchModule.invalidateCache();

  runtime.initRuntime({ prefetchConfig: { product: { soft: 30000, hard: 300000 } } });

  const link = document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!;
  // A fast mouse click lands inside the 100ms hover debounce; pointerdown is
  // what rescues it.
  link.dispatchEvent(
    new window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }),
  );
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(
    fetchCalls.some((c) => c.url.includes('/products/foo')),
    'mouse pointerdown warms immediately',
  );
});

test('container carries aria-busy during nav and drops it after', async () => {
  // Hold the response open so the mid-flight state is deterministic — the
  // beforeNav hooks are awaited before aria-busy is set, so asserting
  // synchronously after click() races the lifecycle.
  let resolveFetch: ((body: string) => void) | null = null;
  (globalThis as Record<string, unknown>).fetch = async () =>
    new Promise<Response>((resolve) => {
      resolveFetch = (body: string) =>
        resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } }));
    });

  runtime.initRuntime();

  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(
    document.querySelector('#MainContent')?.getAttribute('aria-busy'),
    'true',
    'aria-busy set while the region is mid-update',
  );

  resolveFetch!(makePageHtml('product', '<h1>Product</h1>'));
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(
    document.querySelector('#MainContent')?.hasAttribute('aria-busy'),
    false,
    'cleared on the swapped-in container, not the discarded one',
  );
});

// ─── Trekkie bridge (admin reporting) ───────────────────────────────────────

function installTrekkie() {
  const calls: Array<{ name: unknown; props: Record<string, unknown> }> = [];
  (window as unknown as { ShopifyAnalytics: unknown }).ShopifyAnalytics = {
    lib: {
      page: (name: unknown, props: Record<string, unknown>) => {
        calls.push({ name, props });
        return 'sh-test-event-id';
      },
      track: () => undefined,
    },
    meta: { currency: 'USD', page: { pageType: 'index' } },
  };
  return calls;
}

test('trekkie bridge is OFF by default', async () => {
  const calls = installTrekkie();

  runtime.initRuntime();
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(calls.length, 0, 'undocumented global is not touched unless asked for');
});

test('trekkie bridge sends the theme-serialized identity, never reads meta', async () => {
  const calls = installTrekkie();
  const metaBefore = JSON.stringify(
    (window as unknown as { ShopifyAnalytics: { meta: unknown } }).ShopifyAnalytics.meta,
  );

  fetchResponder = () => ({
    status: 200,
    body: makePageHtml(
      'product',
      `<h1>Product</h1>
       <script type="application/json" data-pusha-trekkie-page>
         {"pageType":"product","resourceId":8770736750680}
       </script>`,
    ),
  });

  runtime.initRuntime({ analytics: { trekkie: true } });
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(calls.length, 1, 'one page() call per swap');
  assert.equal(calls[0]!.name, null, 'called as page(null, props) like Shopify does');
  // The measured finding: identity rides pageProps. Bare calls send an event
  // with no page_type at all, so these two fields are the whole point.
  assert.equal(calls[0]!.props.pageType, 'product');
  assert.equal(calls[0]!.props.resourceId, 8770736750680);
  assert.equal(calls[0]!.props.path, '/products/foo');

  assert.equal(
    JSON.stringify(
      (window as unknown as { ShopifyAnalytics: { meta: unknown } }).ShopifyAnalytics.meta,
    ),
    metaBefore,
    'ShopifyAnalytics.meta is shared state other scripts read — never written',
  );
});

test('trekkie bridge no-ops without a serialized identity block', async () => {
  const calls = installTrekkie();

  runtime.initRuntime({ analytics: { trekkie: true } });
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(calls.length, 0, 'no block, no call — Pusha never invents identity');
});

test('trekkie bridge survives ShopifyAnalytics disappearing', async () => {
  // The global is undocumented and outside Shopify's Liquid compatibility
  // guarantee. If it goes, admin reporting must undercount silently rather than
  // throw or corrupt the navigation.
  delete (window as unknown as { ShopifyAnalytics?: unknown }).ShopifyAnalytics;

  fetchResponder = () => ({
    status: 200,
    body: makePageHtml(
      'product',
      `<h1>Product</h1>
       <script type="application/json" data-pusha-trekkie-page>{"pageType":"product"}</script>`,
    ),
  });

  runtime.initRuntime({ analytics: { trekkie: true } });
  document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(
    document.querySelector('#MainContent')?.getAttribute('data-page-type'),
    'product',
    'navigation completed regardless',
  );
});

// ─── Head-sync script dedup ─────────────────────────────────────────────────

test('head-sync does not re-inject a script whose tag died with the container', async () => {
  // The DOM cannot answer "have I loaded this?". A script inside #MainContent is
  // destroyed by the swap, while its top-level `class`/`const` declarations
  // survive in global scope forever. Re-injecting re-executes and throws
  // "Identifier 'X' has already been declared", killing the rest of that file.
  // Measured on Dawn: returning to a collection re-injected facets.js and threw.
  //
  // NB: not awaited. loadScript() settles on the injected element's load/error
  // event, and jsdom never fetches script srcs, so neither ever fires. The
  // appendChild itself is synchronous, which is what this asserts on.
  const headSync = await import('../src/head-sync.ts');
  delete (window as unknown as { __pushaLoadedScripts?: Set<string> }).__pushaLoadedScripts;

  const incoming = new DOMParser().parseFromString(
    makePageHtml('collection', '<h1>Collection</h1><script src="/assets/facets.js"></script>'),
    'text/html',
  );

  void headSync.syncHeadScripts(incoming);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    document.querySelectorAll('script[src="/assets/facets.js"]').length,
    1,
    'first pass brings the script in',
  );

  // The swap replaces the container, taking the tag with it — but not the
  // globals it declared.
  document.querySelectorAll('script[src="/assets/facets.js"]').forEach((el) => el.remove());

  void headSync.syncHeadScripts(incoming);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(
    document.querySelectorAll('script[src="/assets/facets.js"]').length,
    0,
    'second pass must NOT re-inject — that file already executed in this document',
  );
});

// ─── Same-URL clicks ────────────────────────────────────────────────────────

test('a click on the URL you are already on does not swap or fire a pageview', async () => {
  // Left alone this refetches byte-identical HTML and reports a second view of
  // a page the buyer never left, inflating every navigation-derived metric.
  const container = document.querySelector('#MainContent')!;
  container.insertAdjacentHTML('beforeend', '<a href="/" id="home-link">Home</a>');

  runtime.initRuntime();
  const before = fetchCalls.length;

  document.querySelector<HTMLAnchorElement>('#home-link')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(fetchCalls.length, before, 'no fetch for a page we are already on');
  assert.equal(analyticsPageCalls, 0, 'no phantom pageview');
  assert.deepEqual(analyticsPublishCalls, [], 'nothing published either');
  assert.equal(window.location.pathname, '/', 'still on the same URL');
});

test('a same-path link with a DIFFERENT query string still navigates', async () => {
  // The guard keys on path AND search — ?sort_by= on a collection is a real
  // navigation to different content, not a click on the page you are on.
  const container = document.querySelector('#MainContent')!;
  container.insertAdjacentHTML('beforeend', '<a href="/?sort_by=price" id="sorted">Sort</a>');

  runtime.initRuntime();

  document.querySelector<HTMLAnchorElement>('#sorted')!.click();
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(
    fetchCalls.some((c) => c.url.includes('sort_by=price')),
    'a differing query string is a real navigation',
  );
  assert.equal(analyticsPageCalls, 1);
});

// ─── Standard-events cart bridge ────────────────────────────────────────────

interface CartEventInit {
  action?: string;
  context?: string;
  promise?: Promise<unknown>;
}

// Standard events carry their payload as properties on the event object, not
// under `detail`, and are dispatched from the cart or product element — so they
// have to bubble to reach the document-level listener.
function dispatchStandardCartEvent(type: string, init: CartEventInit = {}): void {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, init);
  document.querySelector('#MainContent')!.dispatchEvent(event);
}

function collectCartMutated(): Array<Record<string, unknown>> {
  const seen: Array<Record<string, unknown>> = [];
  document.addEventListener('cart:mutated', (e) => {
    seen.push(((e as CustomEvent).detail ?? {}) as Record<string, unknown>);
  });
  return seen;
}

test('cart bridge waits for the promise to settle before dispatching cart:mutated', async () => {
  // ★ The whole reason this bridge is not a one-line listener. The standard
  // events fire BEFORE the cart is updated, so dispatching on arrival would let
  // a prefetch land in the gap and re-cache the OLD cart as fresh.
  const seen = collectCartMutated();
  runtime.initRuntime();

  let settle: (v: unknown) => void = () => {};
  const promise = new Promise((resolve) => {
    settle = resolve;
  });

  dispatchStandardCartEvent('shopify:cart:lines-update', {
    action: 'add',
    context: 'standard-action',
    promise,
  });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(seen.length, 0, 'nothing dispatched while the cart update is still in flight');

  settle({ cart: { totalQuantity: 1 } });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(seen.length, 1, 'dispatched once the cart actually changed');
  assert.equal(seen[0]!.source, 'shopify-standard-events');
  assert.equal(seen[0]!.action, 'add');
  assert.equal(seen[0]!.context, 'standard-action');
});

test('cart bridge invalidates the prefetch cache for an app-driven cart mutation', async () => {
  // The payoff: an app calling Shopify.actions.updateCart never tells the theme,
  // so without this every cached page keeps rendering the pre-mutation cart badge.
  const prefetch = await import('../src/prefetch.ts');
  runtime.initRuntime({ prefetchConfig: { product: 60_000 } });

  await prefetch.prefetchPage('/products/foo');
  assert.ok(prefetch.getCachedHtml('/products/foo'), 'cache primed');

  const promise = Promise.resolve({ cart: { totalQuantity: 2 } });
  dispatchStandardCartEvent('shopify:cart:lines-update', { action: 'add', promise });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(
    prefetch.getCachedHtml('/products/foo'),
    null,
    'pages cached with the old cart state are evicted',
  );
});

test('cart bridge stays silent when the cart operation fails', async () => {
  // A rejected promise means the request failed or was superseded, so the cart
  // did not change and the cache is still correct. shopify:cart:error is the
  // signal for failures.
  const seen = collectCartMutated();
  runtime.initRuntime();

  dispatchStandardCartEvent('shopify:cart:lines-update', {
    action: 'add',
    promise: Promise.reject(new Error('network')),
  });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(seen.length, 0, 'a failed mutation does not invalidate anything');
});

test('cart bridge covers discount and note updates too', async () => {
  const seen = collectCartMutated();
  runtime.initRuntime();

  dispatchStandardCartEvent('shopify:cart:discount-update', { promise: Promise.resolve({}) });
  dispatchStandardCartEvent('shopify:cart:note-update', { promise: Promise.resolve({}) });
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(
    seen.map((d) => d.event),
    ['shopify:cart:discount-update', 'shopify:cart:note-update'],
  );
});

test('cart bridge ignores cart:view — opening a drawer is not a mutation', async () => {
  const seen = collectCartMutated();
  runtime.initRuntime();

  dispatchStandardCartEvent('shopify:cart:view', { promise: Promise.resolve({}) });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(seen.length, 0);
});

test('cart bridge dispatches immediately for an event with no promise', async () => {
  // `promise` is required by the spec, so this is a theme hand-rolling the
  // event. Dropping it would lose a real cart mutation.
  const seen = collectCartMutated();
  runtime.initRuntime();

  dispatchStandardCartEvent('shopify:cart:lines-update', { action: 'remove' });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.action, 'remove');
});

test('standardCartEvents: false leaves the standard events alone', async () => {
  const seen = collectCartMutated();
  runtime.initRuntime({ standardCartEvents: false });

  dispatchStandardCartEvent('shopify:cart:lines-update', {
    action: 'add',
    promise: Promise.resolve({}),
  });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(seen.length, 0, 'themes that dispatch their own cart:mutated can opt out');
});

test("the theme's own cart:mutated still works with the bridge installed", async () => {
  const prefetch = await import('../src/prefetch.ts');
  runtime.initRuntime({ prefetchConfig: { product: 60_000 } });

  await prefetch.prefetchPage('/products/foo');
  assert.ok(prefetch.getCachedHtml('/products/foo'), 'cache primed');

  document.dispatchEvent(new CustomEvent('cart:mutated'));
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(
    prefetch.getCachedHtml('/products/foo'),
    null,
    'the pre-existing theme-dispatched path is untouched',
  );
});

// ─── app-compat interventions (experimental, all default OFF) ───────────────
// These pin the FLAGS and the SCOPING, not the repair. Whether dispatching a
// section event or re-executing a bundle actually revives a real app is a
// storefront measurement — pusha-probe. What is testable here is that the
// flags default off, that unload fires while the old nodes are still connected,
// and that re-execution never touches a theme script. That last one is the
// guardrail: head-sync's dedupe exists because re-running a theme section script
// throws on redeclaration, and intervention 2 deliberately bypasses that dedupe.
//
// The re-execution tests drive the module directly rather than a full nav. jsdom
// never fetches script srcs, so load/error never fire and a navigation whose
// fetched <head> carries a <script src> never settles — the same constraint the
// head-sync test above documents.

const APP_BODY =
  '<div id="shopify-section-template--1__main" class="shopify-section">' +
  '<div class="shopify-block">app block</div>' +
  '</div>';

const EXT_SRC = 'https://cdn.shopify.com/extensions/abc-123/1.0.0/assets/app.js';
const THEME_SRC = 'https://cdn.shopify.com/s/files/1/theme/section.js';

function sectionEventLog(): { events: string[]; connected: boolean[]; stop: () => void } {
  const events: string[] = [];
  const connected: boolean[] = [];
  const onUnload = (e: Event) => {
    events.push(`unload:${(e as CustomEvent).detail.sectionId}`);
    connected.push((e.target as HTMLElement).isConnected);
  };
  const onLoad = (e: Event) => {
    events.push(`load:${(e as CustomEvent).detail.sectionId}`);
    connected.push((e.target as HTMLElement).isConnected);
  };
  document.addEventListener('shopify:section:unload', onUnload);
  document.addEventListener('shopify:section:load', onLoad);
  return {
    events,
    connected,
    stop: () => {
      document.removeEventListener('shopify:section:unload', onUnload);
      document.removeEventListener('shopify:section:load', onLoad);
    },
  };
}

test('appCompat: section events do not fire unless the flag is set', async () => {
  document.querySelector('#MainContent')!.innerHTML = APP_BODY;
  fetchResponder = () => ({ status: 200, body: makePageHtml('product', APP_BODY) });
  const spy = sectionEventLog();

  try {
    runtime.initRuntime();
    document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    spy.stop();
  }

  assert.equal(document.querySelector('#MainContent')?.getAttribute('data-page-type'), 'product');
  assert.deepEqual(spy.events, [], 'nothing dispatched with appCompat unset');
});

test('appCompat.sectionEvents: unload then load, both on connected nodes', async () => {
  document.querySelector('#MainContent')!.innerHTML = APP_BODY;
  fetchResponder = () => ({ status: 200, body: makePageHtml('product', APP_BODY) });
  const spy = sectionEventLog();

  try {
    runtime.initRuntime({ appCompat: { sectionEvents: true } });
    document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    spy.stop();
  }

  // Ordering is the contract: unload → remove → insert → load.
  assert.deepEqual(spy.events, ['unload:template--1__main', 'load:template--1__main']);
  // Both targets must be connected when their event fires. An unload dispatched
  // on a detached node is useless — a listener cannot reach its own DOM to clean
  // up, which is the entire reason to fire unload at all.
  assert.deepEqual(spy.connected, [true, true], 'both events fire on connected nodes');
});

test('appCompat.sectionEvents: the section id is the full dynamic id, not a JSON key', async () => {
  // api/ajax/section-rendering.md:116-126 — detail.sectionId must match the
  // wrapper's id minus the prefix, e.g. `sections--1234__header`. Deriving it any
  // other way (parsing template JSON, splitting on `__`) breaks section groups.
  document.querySelector('#MainContent')!.innerHTML =
    '<div id="shopify-section-sections--1234__header"></div>' +
    '<div id="shopify-section-template--5678__image_banner"></div>';
  fetchResponder = () => ({ status: 200, body: makePageHtml('product', '<h1>P</h1>') });
  const spy = sectionEventLog();

  try {
    runtime.initRuntime({ appCompat: { sectionEvents: true } });
    document.querySelector<HTMLAnchorElement>('a[href="/products/foo"]')!.click();
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    spy.stop();
  }

  assert.deepEqual(spy.events, [
    'unload:sections--1234__header',
    'unload:template--5678__image_banner',
  ]);
});

test('appCompat.reexecuteExtensionScripts: re-runs extension bundles, never theme scripts', async () => {
  const appCompat = await import('../src/app-compat.ts');
  const headSync = await import('../src/head-sync.ts');
  delete (window as unknown as { __pushaLoadedScripts?: Set<string> }).__pushaLoadedScripts;

  const incoming = new DOMParser().parseFromString(
    makePageHtml('product', APP_BODY).replace(
      '</head>',
      `<script src="${EXT_SRC}" async></script><script src="${THEME_SRC}" defer></script></head>`,
    ),
    'text/html',
  );

  const countSrc = (needle: string) =>
    Array.from(document.querySelectorAll('script[src]')).filter((s) =>
      (s.getAttribute('src') ?? '').includes(needle),
    ).length;

  // First pass: head-sync brings both in and records them as loaded.
  void headSync.syncHeadScripts(incoming);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(countSrc('/extensions/'), 1, 'head-sync loads the extension script once');
  assert.equal(countSrc('/theme/section.js'), 1, 'head-sync loads the theme script once');

  // Second pass: head-sync dedupes both. Nothing is added.
  void headSync.syncHeadScripts(incoming);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(countSrc('/extensions/'), 1, 'dedupe holds for the extension script');
  assert.equal(countSrc('/theme/section.js'), 1, 'dedupe holds for the theme script');

  // The intervention bypasses that dedupe for extension-origin URLs ONLY.
  void appCompat.reexecuteExtensionScripts(incoming, { reexecuteExtensionScripts: true });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(countSrc('/extensions/'), 2, 'the extension bundle is re-added');
  assert.equal(
    countSrc('/theme/section.js'),
    1,
    'the theme script is NOT re-added — that is what head-sync dedupe protects',
  );
});

test('appCompat.reexecuteExtensionScripts: off by default, and a no-op without app scripts', async () => {
  const appCompat = await import('../src/app-compat.ts');
  delete (window as unknown as { __pushaLoadedScripts?: Set<string> }).__pushaLoadedScripts;

  const incoming = new DOMParser().parseFromString(
    makePageHtml('product', APP_BODY).replace(
      '</head>',
      `<script src="${EXT_SRC}" async></script></head>`,
    ),
    'text/html',
  );
  const extCount = () => document.querySelectorAll('script[src*="/extensions/"]').length;
  const before = extCount();

  // No config at all.
  void appCompat.reexecuteExtensionScripts(incoming);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(extCount(), before, 'undefined config re-executes nothing');

  // Flag explicitly false.
  void appCompat.reexecuteExtensionScripts(incoming, { reexecuteExtensionScripts: false });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(extCount(), before, 'an explicit false re-executes nothing');

  // Flag on, but the page carries no extension scripts.
  const noApps = new DOMParser().parseFromString(
    makePageHtml('product', '<h1>P</h1>'),
    'text/html',
  );
  void appCompat.reexecuteExtensionScripts(noApps, { reexecuteExtensionScripts: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(extCount(), before, 'nothing to re-execute is not an error');
});

test('appCompat: enabling both flags warns, because they compound multiplicatively', async () => {
  // Run 3 measured the interaction: re-execution accumulates listener copies and
  // section events then fire all of them, once per section, per nav. A variant
  // clean under either flag alone recorded 14 double-inits under both.
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };

  try {
    runtime.initRuntime({ debug: true, appCompat: { sectionEvents: true, reexecuteExtensionScripts: true } });
  } finally {
    console.log = origLog;
  }

  assert.ok(
    logs.some((l) => l.includes('BOTH appCompat flags')),
    'the conflicting-flag warning fires',
  );
});

test('appCompat: one flag alone does not warn', async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };

  try {
    runtime.initRuntime({ debug: true, appCompat: { sectionEvents: true } });
  } finally {
    console.log = origLog;
  }

  assert.equal(
    logs.filter((l) => l.includes('BOTH appCompat flags')).length,
    0,
    'a single flag is a supported configuration',
  );
});
