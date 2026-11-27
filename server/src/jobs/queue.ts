// A tiny in-process queue: at most `concurrency` tasks run at once, and a key that is already
// queued or running is not added twice. Pure, so it can be unit tested.

export interface Queue {
  add(key: string, task: () => Promise<void>): boolean;
  keys(): string[];
  idle(): Promise<void>;
}

/** On serverless hosts the function must be told to stay alive while a task runs (set once at startup). */
let keepAlive: (p: Promise<unknown>) => void = () => {};
export const setKeepAlive = (fn: (p: Promise<unknown>) => void) => { keepAlive = fn; };

export function createQueue(concurrency: number, onError: (key: string, e: unknown) => void = () => {}): Queue {
  const pending: { key: string; task: () => Promise<void> }[] = [];
  const known = new Set<string>(); // queued or running
  let running = 0;
  let waiters: (() => void)[] = [];

  const settle = () => {
    if (!running && !pending.length) { waiters.forEach((w) => w()); waiters = []; }
  };
  const pump = () => {
    while (running < concurrency && pending.length) {
      const { key, task } = pending.shift()!;
      running++;
      const run = task()
        .catch((e) => onError(key, e))
        .finally(() => { running--; known.delete(key); pump(); settle(); });
      keepAlive(run);
    }
  };

  return {
    add(key, task) {
      if (known.has(key)) return false;
      known.add(key);
      pending.push({ key, task });
      pump();
      return true;
    },
    keys: () => [...known],
    idle: () => (running || pending.length ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve()),
  };
}
