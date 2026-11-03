import { describe, expect, it } from 'vitest';
import { createMemoryQueue, startWorker } from './index.js';

describe('worker', () => {
  it('runs a registered handler with the job data', async () => {
    const seen: unknown[] = [];
    const queue = await startWorker(createMemoryQueue(), { ping: async (data) => void seen.push(data) });
    await queue.send('ping', { n: 1 });
    await queue.send('ping', { n: 2 });
    expect(await queue.drain()).toBe(2);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('rejects a job without a handler and a second handler for one name', async () => {
    const queue = createMemoryQueue();
    await expect(queue.send('missing', {})).rejects.toThrow('no handler');
    await queue.register('ping', async () => {});
    await expect(queue.register('ping', async () => {})).rejects.toThrow('already registered');
  });
});
