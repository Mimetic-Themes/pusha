// Accessibility — focus management + screen reader announcement on PJAX nav.
//
// PJAX nav has real a11y implications. Without intervention, keyboard users
// get lost (focus stays on the now-removed link) and screen readers don't
// announce the navigation (the URL silently changes).

let liveRegion: HTMLElement | null = null;

function ensureLiveRegion(): HTMLElement {
  if (liveRegion && document.body.contains(liveRegion)) return liveRegion;
  const el = document.createElement('div');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  // Visually hidden but available to screen readers.
  el.style.cssText =
    'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;';
  document.body.appendChild(el);
  liveRegion = el;
  return el;
}

export function announce(message: string): void {
  const region = ensureLiveRegion();
  // Clearing then setting on next tick ensures even repeated identical titles
  // get re-announced.
  region.textContent = '';
  setTimeout(() => {
    region.textContent = message;
  }, 50);
}

export function focusContainer(container: HTMLElement, hash: string): void {
  if (hash) {
    const id = hash.replace(/^#/, '');
    const target = document.getElementById(id);
    if (target) {
      target.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
      makeFocusable(target);
      target.focus({ preventScroll: true });
      return;
    }
  }
  makeFocusable(container);
  container.focus({ preventScroll: true });
}

function makeFocusable(el: HTMLElement): void {
  if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) {
    el.setAttribute('tabindex', '-1');
  }
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
