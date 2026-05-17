// Simple async mutex for serializing shared UI submit operations.
// API submits can run in parallel; DOM submits use this because they share one
// Flow composer/debugger path even when generation is overlapping.

export function createAsyncMutex() {
  let chain = Promise.resolve();

  return {
    async runExclusive(fn) {
      const previous = chain;

      let release;
      chain = new Promise((resolve) => {
        release = resolve;
      });

      await previous;

      try {
        return await fn();
      } finally {
        release();
      }
    }
  };
}
