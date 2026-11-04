// Simulated mode (WP-51, docs/deployment.md "Simulated mode"): the simulators' state kept outside the
// process, so the web, worker and sandbox services share one outside world that survives restarts.
// The Postgres store is in src/db/simulator-store.ts; the in-memory one serves local runs and tests.

/** A file a simulated process stored (inbound media, renders), by storage path. */
export interface StoredFile {
  mimeType: string;
  data: Uint8Array;
}

export interface SimulatorStore {
  /**
   * Runs fn with the named state locked for the call (across processes for the Postgres store) and
   * saves the state fn returns. `undefined` means nothing is stored under that name yet.
   */
  update<R>(name: string, fn: (state: unknown) => Promise<{ state: unknown; result: R }>): Promise<R>;
  putFile(path: string, data: Uint8Array, mimeType: string): Promise<void>;
  getFile(path: string): Promise<StoredFile | undefined>;
  /** Removes the files under a prefix, or the listed paths. */
  removeFiles(which: { prefix: string } | { paths: string[] }): Promise<void>;
}

/** A simulator whose whole state can be written out as JSON and read back. */
export interface Stateful {
  exportState(): unknown;
  importState(state: unknown): void;
}

/** One process's in-memory store; also the reference for the store contract suite. */
export class MemorySimulatorStore implements SimulatorStore {
  private readonly states = new Map<string, string>();
  private readonly files = new Map<string, StoredFile>();
  private readonly locks = new Map<string, Promise<unknown>>();

  async update<R>(name: string, fn: (state: unknown) => Promise<{ state: unknown; result: R }>): Promise<R> {
    const previous = this.locks.get(name) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      const raw = this.states.get(name);
      const { state, result } = await fn(raw === undefined ? undefined : JSON.parse(raw));
      this.states.set(name, JSON.stringify(state));
      return result;
    });
    this.locks.set(name, run);
    return run;
  }

  async putFile(path: string, data: Uint8Array, mimeType: string) {
    this.files.set(path, { mimeType, data: data.slice() });
  }

  async getFile(path: string) {
    const file = this.files.get(path);
    return file && { mimeType: file.mimeType, data: file.data.slice() };
  }

  async removeFiles(which: { prefix: string } | { paths: string[] }) {
    for (const path of [...this.files.keys()]) {
      if ('prefix' in which ? path.startsWith(which.prefix) : which.paths.includes(path)) this.files.delete(path);
    }
  }
}

type Failure = { failed: true; error: unknown };

/**
 * One simulator object on a shared store. Every call loads the latest state into the object, runs,
 * and writes the state back in the same locked update, also when the call throws (a simulated lost
 * response still created the post). `provider` is the simulator as its provider interface.
 */
export class PersistentSimulator<S extends Stateful & object> {
  readonly provider: S;

  constructor(
    readonly name: string,
    private readonly sim: S,
    private readonly store: SimulatorStore,
  ) {
    this.provider = new Proxy(sim, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function' || prop === 'exportState' || prop === 'importState' || prop === 'constructor') return value;
        return (...args: unknown[]) => this.run((s) => (Reflect.get(s, prop) as (...a: unknown[]) => unknown).apply(s, args));
      },
    });
  }

  /** Runs fn on the simulator with the shared state loaded, and saves what it changed. */
  async run<R>(fn: (sim: S) => R | Promise<R>): Promise<R> {
    const outcome = await this.store.update<R | Failure>(this.name, async (state) => {
      if (state !== undefined) this.sim.importState(state);
      try {
        const result = await fn(this.sim);
        return { state: this.sim.exportState(), result };
      } catch (error) {
        return { state: this.sim.exportState(), result: { failed: true, error } as Failure };
      }
    });
    if (isFailure(outcome)) throw outcome.error;
    return outcome;
  }
}

function isFailure(value: unknown): value is Failure {
  return typeof value === 'object' && value !== null && (value as Failure).failed === true && 'error' in value;
}

/** Replaces an array's contents in place (simulators expose readonly array fields). */
export function refill<T>(target: T[], items: readonly T[]): void {
  target.splice(0, target.length, ...items);
}

export const toBase64 = (data: Uint8Array) => Buffer.from(data).toString('base64');
export const fromBase64 = (data: string) => new Uint8Array(Buffer.from(data, 'base64'));
