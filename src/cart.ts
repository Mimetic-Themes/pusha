// Standard-events cart bridge.
//
// Pusha invalidates its prefetch cache on `cart:mutated`, a Pusha-specific
// event the THEME has to dispatch. That works for cart changes the theme makes,
// and misses every cart change it doesn't: an app that adds a line, a Shop-app
// surface, anything routing through `Shopify.actions.updateCart`. Those leave
// the cached /cart page — and any cached page rendering a cart badge — stale.
//
// Shopify's standard storefront events close that hole with no per-app wiring.
// They are a platform vocabulary every theme and app can share, dispatched from
// the cart element (or the product element for adds on a product page) and
// bubbling to `document`:
//
//   shopify:cart:lines-update     lines added, updated, or removed
//   shopify:cart:discount-update  discount codes applied or removed
//   shopify:cart:note-update      cart note changed
//
// and `updateCart` "emits the matching cart events as it starts", with a
// `context` of `standard-action`. So subscribing here picks up app-driven cart
// mutations for free.
//   — https://shopify.dev/docs/api/storefront-events-and-actions/events
//
// ★ TIMING — the reason this file is not a three-line listener. The docs are
// explicit: "The event fires before the cart is updated, so listeners can show
// a loading or optimistic state while the operation runs." Invalidating the
// cache the moment the event arrives would be worse than doing nothing: a
// prefetch landing in the window between the event and the server actually
// applying the change would re-cache the OLD cart and mark it fresh. So the
// bridge waits on the event's `promise` and only then dispatches `cart:mutated`.
//
// On rejection it dispatches nothing. A rejected promise means the request
// failed or was superseded ("a network error, or when a newer update supersedes
// it"), so the cart did not change and the cache is still correct — and a
// superseding update fires its own event with its own promise. Themes that want
// to react to failures listen for `shopify:cart:error`, which is Shopify's
// signal for exactly that.
//
// A fulfilled promise dispatches even when `userErrors` is non-empty. The cart
// declined that particular input, but the surrounding operation completed and
// re-reading is cheap; under-invalidating shows a buyer a stale cart, which is
// not.
//
// ⚠ Themes that ALREADY dispatch their own `cart:mutated` for a buyer's own
// cart interaction will now see two events for that one interaction — theirs
// and this bridge's. Pusha's own handler is idempotent (it invalidates cache
// entries), so nothing breaks, but a theme handler that re-fetches a cart
// section will do it twice. Every event this bridge dispatches carries
// `detail.source === 'shopify-standard-events'`, so such a theme can filter:
//
//   document.addEventListener('cart:mutated', (e) => {
//     if (e.detail?.source === 'shopify-standard-events') return; // already handled
//     …
//   });
//
// or set `standardCartEvents: false` and keep dispatching `cart:mutated` itself.

import { log as dlog } from './diagnostics.js';

// `shopify:cart:view` is deliberately absent — opening a cart drawer is not a
// mutation. `shopify:cart:error` too: it reports a failure, and a failed
// mutation leaves the cart, and therefore the cache, as it was.
const MUTATION_EVENTS = [
  'shopify:cart:lines-update',
  'shopify:cart:discount-update',
  'shopify:cart:note-update',
] as const;

let installed = false;

// Standard events carry their payload as properties on the event object itself
// (`event.action`, `event.promise`) rather than under `detail`, which is
// reserved for the storefront's own custom data. Read direct first, then fall
// back to `detail` so a theme hand-rolling a plain CustomEvent still works.
function readField<T>(event: Event, key: string): T | undefined {
  const direct = (event as unknown as Record<string, unknown>)[key];
  if (direct !== undefined) return direct as T;
  const detail = (event as CustomEvent).detail as unknown;
  if (detail && typeof detail === 'object') {
    return (detail as Record<string, unknown>)[key] as T | undefined;
  }
  return undefined;
}

function dispatchCartMutated(type: string, action?: string, context?: string): void {
  dlog('cart', `${type} settled (action: ${action ?? '?'}, context: ${context ?? '?'}) → cart:mutated`);
  document.dispatchEvent(
    new CustomEvent('cart:mutated', {
      detail: { source: 'shopify-standard-events', event: type, action, context },
    }),
  );
}

function handleStandardCartEvent(event: Event): void {
  const type = event.type;
  const action = readField<string>(event, 'action');
  const context = readField<string>(event, 'context');
  const promise = readField<Promise<unknown>>(event, 'promise');

  if (!promise || typeof promise.then !== 'function') {
    // `promise` is required by the spec, so this is a theme dispatching a
    // hand-rolled event. Treat it as already applied — the alternative is
    // dropping a real cart mutation on the floor.
    dlog('cart', `${type} carried no promise — treating the cart as already updated`);
    dispatchCartMutated(type, action, context);
    return;
  }

  promise.then(
    () => dispatchCartMutated(type, action, context),
    (err: unknown) => {
      // Cart unchanged, cache still valid. Not a warning: a superseded update
      // is routine, and the superseding one carries its own promise.
      dlog('cart', `${type} rejected — cart unchanged, no cart:mutated`, err);
    },
  );
}

/**
 * Subscribe to Shopify's standard cart events and re-dispatch them as
 * `cart:mutated` once the underlying operation settles.
 *
 * Passive and idempotent: three listeners that cost nothing until a standard
 * cart event actually fires. On a theme that dispatches none, this never runs.
 */
export function installCartBridge(): void {
  if (installed) return;
  installed = true;
  for (const type of MUTATION_EVENTS) {
    document.addEventListener(type, handleStandardCartEvent);
  }
  dlog('cart', `standard-events cart bridge listening (${MUTATION_EVENTS.length} events)`);
}

export function uninstallCartBridge(): void {
  if (!installed) return;
  for (const type of MUTATION_EVENTS) {
    document.removeEventListener(type, handleStandardCartEvent);
  }
  installed = false;
}
