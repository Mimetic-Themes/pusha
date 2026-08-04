// Scroll restoration. We turn off `history.scrollRestoration = 'manual'`
// during init() and manage scroll per history entry ourselves so the browser's
// automatic popstate scroll doesn't fight ours.

const positions = new Map<string, number>();

export function saveScroll(url: string): void {
  if (url) positions.set(url, window.scrollY);
}

export function restoreScroll(url: string): void {
  const y = positions.get(new URL(url, window.location.href).href) ?? 0;
  window.scrollTo({ top: y, left: 0, behavior: 'instant' as ScrollBehavior });
}

export function scrollToTop(): void {
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
}

export function scrollToHash(hash: string): boolean {
  const id = hash.replace(/^#/, '');
  if (!id) return false;
  const target = document.getElementById(id);
  if (!target) return false;
  target.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
  return true;
}
