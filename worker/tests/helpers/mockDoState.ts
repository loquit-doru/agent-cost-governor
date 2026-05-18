import type { DurableObjectState } from '@cloudflare/workers-types';

/** In-memory Durable Object storage for unit tests. */
export function createMockDOState(): DurableObjectState {
  const map = new Map<string, unknown>();

  return {
    storage: {
      get: async (key: string) => map.get(key),
      put: async (key: string, value: unknown) => {
        map.set(key, value);
      },
      delete: async (key: string) => {
        map.delete(key);
      },
      list: async (options?: { prefix?: string; start?: string; end?: string; limit?: number }) => {
        const prefix = options?.prefix ?? '';
        const entries: [string, unknown][] = [];
        for (const [k, v] of map) {
          if (k.startsWith(prefix)) entries.push([k, v]);
        }
        return new Map(entries);
      },
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAll: async () => {
        map.clear();
      },
      transaction: async (closure) => closure(map as never),
    },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => {
      await fn();
    },
    waitUntil: () => {},
    id: { toString: () => 'test-billing-do' },
  } as unknown as DurableObjectState;
}
