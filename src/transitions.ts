// Named transition system. Modeled on Barba.js's named-transition concept.
//
// A transition is registered with optional `from`/`to` matchers against the
// `data-page-type` of the leaving and entering containers. The runtime picks
// the most specific match for each navigation, falling back to the default
// (matcher-less) transition if one is registered, otherwise plain CSS classes.

export type TemplateMatcher = string[] | undefined;

export interface TransitionMatcher {
  /** Template names to match (data-page-type). '*' matches anything. */
  template?: TemplateMatcher;
}

export interface TransitionDef {
  /** Unique name. Pass via `Pusha.go(url, { transition: name })` to force. */
  name: string;
  from?: TransitionMatcher;
  to?: TransitionMatcher;
  /**
   * Custom leave animation. Return a Promise to await, or null/undefined to
   * fall through to the CSS class-based transition.
   */
  leave?: (
    container: HTMLElement,
    meta: { from: string; to: string },
  ) => Promise<void> | null | void;
  /** Custom enter animation. Same contract as `leave`. */
  enter?: (
    container: HTMLElement,
    meta: { from: string; to: string },
  ) => Promise<void> | null | void;
}

const transitions: TransitionDef[] = [];

export function registerTransition(def: TransitionDef): () => void {
  transitions.push(def);
  return () => {
    const idx = transitions.indexOf(def);
    if (idx >= 0) transitions.splice(idx, 1);
  };
}

export function getTransitions(): readonly TransitionDef[] {
  return transitions;
}

function matchTemplate(matcher: TemplateMatcher, value: string): boolean {
  if (!matcher || matcher.length === 0) return true;
  if (matcher.includes('*')) return true;
  return matcher.includes(value);
}

/**
 * Pick the transition for a given from→to navigation.
 *   - If `forced` is provided, the named transition is returned (if registered).
 *   - Otherwise, the most recently-registered transition matching both `from`
 *     and `to` wins. Transitions with no matchers act as defaults and are
 *     considered last.
 */
export function pickTransition(
  fromTemplate: string,
  toTemplate: string,
  forced?: string,
): TransitionDef | null {
  if (forced) {
    const found = transitions.find((t) => t.name === forced);
    if (found) return found;
  }
  // Walk from most-recent to oldest so later registrations win ties.
  for (let i = transitions.length - 1; i >= 0; i--) {
    const t = transitions[i]!;
    if (forced && t.name === forced) continue;
    if (!t.from && !t.to) continue;
    if (matchTemplate(t.from?.template, fromTemplate) && matchTemplate(t.to?.template, toTemplate)) {
      return t;
    }
  }
  // Fall back to first registered matcher-less transition (the explicit default).
  for (const t of transitions) {
    if (!t.from && !t.to) return t;
  }
  return null;
}
