// Component registry. Themes register components keyed by name; the runtime
// calls `setupGlobal()` once and `init(root)` after every PJAX swap.

import { log as dlog } from './diagnostics.js';

export interface ThemeComponent {
  /**
   * Runs once globally. Attach delegated event listeners to document here.
   * These survive PJAX navigation because they live on document, not inside
   * the swap container.
   */
  setupGlobal?: () => void;

  /**
   * Runs on every page load and after every PJAX content swap.
   * Always query within `root` — never `document.querySelector` inside init.
   * `root` is the new container element on PJAX nav, or a section element
   * in theme editor `shopify:section:load` events.
   */
  init: (root: HTMLElement | Document) => void;

  /**
   * Optional. Called before the container is replaced. Implement only when
   * the component holds a persistent external reference to container DOM:
   *   - IntersectionObserver / MutationObserver / ResizeObserver
   *   - setInterval / setTimeout holding element references
   *   - Direct (non-delegated) listeners attached in init
   *   - Animation handles (anime.js, GSAP) bound to container nodes
   *
   * Most components using only `setupGlobal` delegation do NOT need this.
   * For sections that do, prefer wrapping as a custom element with
   * `disconnectedCallback` over implementing `destroy` here.
   */
  destroy?: (root: HTMLElement) => void;
}

export class ComponentRegistry {
  private components = new Map<string, ThemeComponent>();
  private globalSetupDone = new Set<string>();

  register(name: string, component: ThemeComponent): void {
    if (typeof component.init !== 'function') {
      throw new Error(`Component "${name}" must have an init function`);
    }
    this.components.set(name, component);
  }

  has(name: string): boolean {
    return this.components.has(name);
  }

  setupGlobal(): void {
    let setupCount = 0;
    this.components.forEach((component, name) => {
      if (component.setupGlobal && !this.globalSetupDone.has(name)) {
        component.setupGlobal();
        this.globalSetupDone.add(name);
        setupCount++;
      }
    });
    if (setupCount) dlog('registry', `setupGlobal: ${setupCount} components`);
  }

  initAll(root: HTMLElement | Document = document, disabled?: ReadonlySet<string>): void {
    let inited = 0;
    let skipped = 0;
    this.components.forEach((component, name) => {
      if (disabled?.has(name)) {
        skipped++;
        return;
      }
      component.init(root);
      inited++;
    });
    if (inited || skipped) dlog('registry', `initAll: ${inited} components, ${skipped} disabled`);
  }

  initComponent(name: string, root: HTMLElement | Document = document): void {
    const component = this.components.get(name);
    if (component) {
      component.init(root);
    } else if (typeof console !== 'undefined') {
      console.warn(`Component "${name}" not found in registry`);
    }
  }

  destroyAll(root: HTMLElement): void {
    let destroyed = 0;
    this.components.forEach((component) => {
      if (component.destroy) {
        component.destroy(root);
        destroyed++;
      }
    });
    if (destroyed) dlog('registry', `destroyAll: ${destroyed} components`);
  }

  /** Test-only — drop all registered components and reset setupGlobal tracking. */
  _resetForTests(): void {
    this.components.clear();
    this.globalSetupDone.clear();
  }
}

export const registry = new ComponentRegistry();
