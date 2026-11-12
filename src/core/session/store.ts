// TODO(sdk-core 0.3.0): import `createStore` from `@hussmartinez/sdk-core`
// (ADR 0029) once a fixed 0.3.0 is published, and delete this copy.

/**
 * A small observable store: one immutable state, replaced on every change
 * (ADR 0029). React binds to it with `useSyncExternalStore`, and the element
 * binds to the same store.
 *
 * @typeParam S - The state.
 * @internal
 */
export interface Store<S> {
  /** The current state: the same value until it changes. */
  getSnapshot(): S;
  /**
   * Calls `listener` after every change, until the returned function is
   * called. Listeners run synchronously, in the order they subscribed.
   */
  subscribe(listener: () => void): () => void;
  /**
   * Replaces the state, with a new value or a function of the current one.
   * Setting the same value (`Object.is`) notifies no one. If the state is
   * itself a function, pass an updater that returns it.
   */
  set(next: S | ((current: S) => S)): void;
}

/** Reports a listener's error without stopping the others. */
function report(error: unknown): void {
  const reportError = (globalThis as { reportError?: (error: unknown) => void }).reportError;
  if (typeof reportError === "function") {
    reportError(error);
  } else {
    setTimeout(() => {
      throw error;
    }, 0);
  }
}

/**
 * Creates a {@link Store}.
 *
 * - States are immutable by convention: every change makes a new state, so
 *   subscribers can compare by identity. The store doesn't freeze them.
 * - A listener that throws doesn't stop the others. Its error is reported
 *   with `reportError` where that exists, and thrown asynchronously
 *   otherwise.
 * - A listener added while listeners are being called is first called on the
 *   next change. One removed meanwhile isn't called again.
 *
 * @example
 * ```ts
 * const store = createStore({ count: 0 });
 * const unsubscribe = store.subscribe(() => render(store.getSnapshot()));
 * store.set((state) => ({ count: state.count + 1 }));
 * ```
 *
 * @param initial - The first state.
 * @internal
 */
export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => state,

    subscribe(listener) {
      const entry = () => listener();
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },

    set(next) {
      const value = typeof next === "function" ? (next as (current: S) => S)(state) : (next as S);
      if (Object.is(value, state)) {
        return;
      }
      state = value;
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) {
          continue;
        }
        try {
          listener();
        } catch (error) {
          report(error);
        }
      }
    },
  };
}
