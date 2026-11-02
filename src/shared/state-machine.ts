/**
 * Deterministic state machines as transition tables. Guards live in the
 * owning module; this file only knows which (state, event) pairs exist.
 */

export interface MachineDefinition<S extends string, E extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly events: readonly E[];
  readonly initial: S;
  readonly terminal: readonly S[];
  readonly transitions: { readonly [From in S]?: { readonly [Event in E]?: S } };
}

export type Machine<S extends string, E extends string> = MachineDefinition<S, E>;

export class InvalidTransitionError extends Error {
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly event: string,
  ) {
    super(`${machine}: no transition from "${from}" on "${event}"`);
    this.name = 'InvalidTransitionError';
  }
}

export function defineMachine<const S extends string, const E extends string>(
  definition: MachineDefinition<S, E>,
): Machine<S, E> {
  const { name, states, events, initial, terminal, transitions } = definition;
  const stateSet = new Set<string>(states);
  const eventSet = new Set<string>(events);

  if (!stateSet.has(initial)) throw new Error(`${name}: initial state "${initial}" is not a state`);
  for (const state of terminal) {
    if (!stateSet.has(state)) throw new Error(`${name}: terminal state "${state}" is not a state`);
  }

  for (const [from, byEvent] of Object.entries(transitions) as Array<[string, Record<string, string>]>) {
    if (!stateSet.has(from)) throw new Error(`${name}: source "${from}" is not a state`);
    if (terminal.includes(from as S)) throw new Error(`${name}: terminal state "${from}" has outgoing transitions`);
    for (const [event, to] of Object.entries(byEvent)) {
      if (!eventSet.has(event)) throw new Error(`${name}: event "${event}" is not an event`);
      if (!stateSet.has(to)) throw new Error(`${name}: target "${to}" of ${from} -> ${event} is not a state`);
    }
  }

  return Object.freeze(definition);
}

export function canTransition<S extends string, E extends string>(machine: Machine<S, E>, from: S, event: E): boolean {
  return machine.transitions[from]?.[event] !== undefined;
}

export function transition<S extends string, E extends string>(machine: Machine<S, E>, from: S, event: E): S {
  const to = machine.transitions[from]?.[event];
  if (to === undefined) throw new InvalidTransitionError(machine.name, from, event);
  return to;
}

export function listTransitions<S extends string, E extends string>(machine: Machine<S, E>): Array<[S, E, S]> {
  return Object.entries(machine.transitions).flatMap(([from, byEvent]) =>
    Object.entries(byEvent as Record<string, S>).map(([event, to]) => [from as S, event as E, to] as [S, E, S]),
  );
}
