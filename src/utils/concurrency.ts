/**
 * Bounded-concurrency map. Deliberately hand-rolled instead of pulling in
 * `p-limit`: it is ~20 lines, avoids an ESM-only dependency in a CommonJS
 * build, and lets us guarantee result ordering matches input ordering.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new RangeError('concurrency limit must be >= 1');
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}
