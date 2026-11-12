// TODO(sdk-core 0.3.0): import `Reducer`, `Applied` and `applyCommands` from
// `@hussmartinez/sdk-core` (ADR 0029) once a fixed 0.3.0 passes the release-age
// policy, and delete this file.

/**
 * The result of applying one command: the next state and the command that
 * undoes it. The same shape as sdk-core's `Applied` (ADR 0029).
 *
 * @public
 */
export interface Applied<S, C> {
  readonly state: S;
  readonly inverse: C;
}

/**
 * A pure function that applies one command and returns its inverse. The
 * same shape as sdk-core's `Reducer` (ADR 0029).
 *
 * @public
 */
export type Reducer<S, C> = (state: S, command: C) => Applied<S, C>;

/**
 * Applies commands in order, returning the final state and the inverses in
 * the order undo needs: last command first.
 *
 * @internal
 */
export function applyCommands<S, C>(
  reducer: Reducer<S, C>,
  state: S,
  commands: readonly C[],
): { readonly state: S; readonly inverses: readonly C[] } {
  let current = state;
  const inverses: C[] = [];
  for (const command of commands) {
    const applied = reducer(current, command);
    current = applied.state;
    inverses.unshift(applied.inverse);
  }
  return { state: current, inverses };
}
