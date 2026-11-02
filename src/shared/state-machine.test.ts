import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  canTransition,
  defineMachine,
  listTransitions,
  transition,
} from './state-machine.js';

const light = defineMachine({
  name: 'light',
  states: ['off', 'on', 'broken'] as const,
  events: ['TOGGLE', 'BREAK'] as const,
  initial: 'off',
  terminal: ['broken'],
  transitions: {
    off: { TOGGLE: 'on', BREAK: 'broken' },
    on: { TOGGLE: 'off', BREAK: 'broken' },
  },
});

describe('transition', () => {
  it('returns the next state for a listed pair', () => {
    expect(transition(light, 'off', 'TOGGLE')).toBe('on');
    expect(transition(light, 'on', 'BREAK')).toBe('broken');
  });

  it('throws InvalidTransitionError for an unlisted pair', () => {
    expect(() => transition(light, 'broken', 'TOGGLE')).toThrow(InvalidTransitionError);
  });

  it('reports the machine, state, and event on the error', () => {
    try {
      transition(light, 'broken', 'TOGGLE');
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ machine: 'light', from: 'broken', event: 'TOGGLE' });
    }
  });
});

describe('canTransition', () => {
  it('is true only for listed pairs', () => {
    expect(canTransition(light, 'off', 'TOGGLE')).toBe(true);
    expect(canTransition(light, 'broken', 'BREAK')).toBe(false);
  });
});

describe('listTransitions', () => {
  it('returns every listed transition as [from, event, to]', () => {
    expect(listTransitions(light)).toEqual([
      ['off', 'TOGGLE', 'on'],
      ['off', 'BREAK', 'broken'],
      ['on', 'TOGGLE', 'off'],
      ['on', 'BREAK', 'broken'],
    ]);
  });
});

describe('defineMachine', () => {
  it('rejects a target that is not a state', () => {
    expect(() =>
      defineMachine({
        name: 'bad',
        states: ['a'] as const,
        events: ['GO'] as const,
        initial: 'a',
        terminal: [],
        transitions: { a: { GO: 'missing' as 'a' } },
      }),
    ).toThrow(/missing/);
  });

  it('rejects outgoing transitions from a terminal state', () => {
    expect(() =>
      defineMachine({
        name: 'bad',
        states: ['a', 'b'] as const,
        events: ['GO'] as const,
        initial: 'a',
        terminal: ['b'],
        transitions: { a: { GO: 'b' }, b: { GO: 'a' } },
      }),
    ).toThrow(/terminal/);
  });

  it('rejects an initial state that is not a state', () => {
    expect(() =>
      defineMachine({
        name: 'bad',
        states: ['a'] as const,
        events: ['GO'] as const,
        initial: 'z' as 'a',
        terminal: [],
        transitions: {},
      }),
    ).toThrow(/initial/);
  });
});
