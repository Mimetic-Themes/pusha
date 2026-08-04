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
  assert.deepEqual(analyticsPublishCalls, ['page_viewed']);
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

  assert.deepEqual(analyticsPublishCalls, ['page_viewed', 'product_viewed']);
  const productEvent = analyticsPublishPayloads.find((p) => p.event === 'product_viewed');
  assert.deepEqual(productEvent?.payload, { productVariant: { id: 42 } });
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

  assert.deepEqual(analyticsPublishCalls, ['page_viewed', 'collection_viewed', 'search_submitted']);
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

  assert.deepEqual(analyticsPublishCalls, ['page_viewed']);
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
  assert.deepEqual(analyticsPublishCalls, ['page_viewed']);
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
  `;

  runtime.initRuntime();
  for (const id of [
    'checkout', 'checkouts', 'login', 'register', 'logout', 'recover', 'activate',
    'customer-auth', 'password', 'localization', 'giftcard', 'appproxy',
  ]) {
    document.getElementById(id)!.click();
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetchCalls.length, 0, 'no reserved link triggers a PJAX fetch');
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
