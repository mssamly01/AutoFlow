// Simple async mutex for serializing submit operations.
// Ensures only one task submits via API/DOM at a time,
// even when multiple tasks are overlapping generation.

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
