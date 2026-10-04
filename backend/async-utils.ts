export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        result[index] = await work(items[index]);
      }
    }),
  );
  return result;
}
