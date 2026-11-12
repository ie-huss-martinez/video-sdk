// TODO(sdk-core 0.3.0): import `createHistory` from `@hussmartinez/sdk-core`
// (ADR 0029) once a fixed 0.3.0 is published, and delete this copy.

/**
 * One undoable step: the commands it ran, and the commands that undo it.
 * Plain, serialisable data (ADR 0010).
 *
 * @typeParam C - The commands.
 * @internal
 */
export interface HistoryStep<C> {
  /** The commands the step ran, in order. */
  readonly commands: readonly C[];
  /** Applied in this order to undo the step. */
  readonly inverses: readonly C[];
}

/**
 * Undo and redo stacks of command steps (ADR 0010, ADR 0029). The session
 * applies the steps with its reducer; the history only keeps them. Memory
 * policies are each SDK's own, built on `steps`, `dropOrder` and `drop`.
 *
 * @typeParam C - The commands.
 * @internal
 */
export interface History<C extends { readonly type: string }> {
  /** Whether there's a step to undo. */
  readonly canUndo: boolean;
  /** Whether there's a step to redo. */
  readonly canRedo: boolean;
  /** Whether steps were dropped to save memory since the last `clear()`. */
  readonly trimmed: boolean;
  /** Every step, undoable and redoable. */
  readonly steps: readonly HistoryStep<C>[];
  /**
   * The order to drop steps in so that those that remain can still be
   * applied: first the redo steps, from the one redo would reach last, then
   * the undo steps, oldest first.
   */
  readonly dropOrder: readonly HistoryStep<C>[];
  /** Records a step, and drops everything that could be redone. */
  push(step: HistoryStep<C>): void;
  /** Moves the step to undo to the redo stack and returns it, if there is one. */
  undo(): HistoryStep<C> | undefined;
  /** Moves the step to redo back to the undo stack and returns it, if there is one. */
  redo(): HistoryStep<C> | undefined;
  /**
   * Puts back the step that the last `undo()` or `redo()` returned, after
   * applying it failed, so the history is as it was.
   */
  restore(direction: "undo" | "redo"): void;
  /** Drops the first `count` steps of `dropOrder`, and sets `trimmed`. */
  drop(count: number): void;
  /** Empties both stacks, and resets `trimmed`. */
  clear(): void;
  /**
   * Runs `fn`, and records every step it pushes as one step: their commands
   * in order, and their inverses in reverse step order. Nested groups join
   * the outer one, and a group that pushes nothing records nothing. If `fn`
   * throws, the steps it pushed are still recorded, because their changes
   * were applied, and the error is rethrown. `fn` must be synchronous; a
   * gesture that spans events pushes one step when it ends.
   */
  group<T>(fn: () => T): T;
}

/** A copy of a step that can't be changed through the caller's arrays. */
const freeze = <C>(step: HistoryStep<C>): HistoryStep<C> =>
  Object.freeze({
    commands: Object.freeze([...step.commands]),
    inverses: Object.freeze([...step.inverses]),
  });

/**
 * Creates a {@link History}.
 *
 * @example
 * ```ts
 * const history = createHistory<PdfCommand>();
 * history.group(() => {
 *   history.push({ commands: [rotate], inverses: [unrotate] });
 *   history.push({ commands: [move], inverses: [unmove] });
 * });
 * const step = history.undo(); // inverses: [unmove, unrotate]
 * ```
 *
 * @internal
 */
export function createHistory<C extends { readonly type: string }>(): History<C> {
  let past: HistoryStep<C>[] = [];
  let future: HistoryStep<C>[] = [];
  let trimmed = false;
  let depth = 0;
  let pending: HistoryStep<C>[] = [];

  const record = (step: HistoryStep<C>) => {
    past.push(step);
    future = [];
  };
  const outsideGroup = (method: string) => {
    if (depth > 0) {
      throw new TypeError(`history.${method}() can't be called inside history.group().`);
    }
  };

  return {
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    get trimmed() {
      return trimmed;
    },
    get steps() {
      return [...past, ...future];
    },
    get dropOrder() {
      // Both stacks keep their far end, the step reached last, at index 0.
      return [...future, ...past];
    },

    push(step) {
      if (depth > 0) {
        pending.push(step);
      } else {
        record(freeze(step));
      }
    },

    undo() {
      outsideGroup("undo");
      const step = past.pop();
      if (step) {
        future.push(step);
      }
      return step;
    },

    redo() {
      outsideGroup("redo");
      const step = future.pop();
      if (step) {
        past.push(step);
      }
      return step;
    },

    restore(direction) {
      outsideGroup("restore");
      if (direction === "undo") {
        const step = future.pop();
        if (step) {
          past.push(step);
        }
      } else {
        const step = past.pop();
        if (step) {
          future.push(step);
        }
      }
    },

    drop(count) {
      outsideGroup("drop");
      if (!(count > 0)) {
        return;
      }
      const remaining = Math.min(Math.floor(count), future.length + past.length);
      const fromFuture = Math.min(remaining, future.length);
      future.splice(0, fromFuture);
      past.splice(0, remaining - fromFuture);
      trimmed = true;
    },

    clear() {
      outsideGroup("clear");
      past = [];
      future = [];
      trimmed = false;
    },

    group(fn) {
      depth += 1;
      let result: ReturnType<typeof fn>;
      try {
        result = fn();
      } finally {
        depth -= 1;
        if (depth === 0) {
          const steps = pending;
          pending = [];
          if (steps.length > 0) {
            record(
              freeze({
                commands: steps.flatMap((step) => step.commands),
                inverses: [...steps].reverse().flatMap((step) => step.inverses),
              }),
            );
          }
        }
      }
      if (typeof (result as { then?: unknown } | undefined)?.then === "function") {
        throw new TypeError(
          "history.group() needs a synchronous function: steps pushed after an await would fall outside the group.",
        );
      }
      return result;
    },
  };
}
