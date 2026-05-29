// Hand-rolled concurrency limiter. Kept here (not as a dependency) to avoid
// touching pnpm-lock.yaml for a small helper.
export function pLimit(concurrency: number) {
  if (concurrency < 1) throw new Error("pLimit concurrency must be >= 1");
  const queue: Array<() => void> = [];
  let active = 0;
  const next = () => {
    if (active >= concurrency) return;
    const job = queue.shift();
    if (job) {
      active += 1;
      job();
    }
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then((value) => {
            active -= 1;
            resolve(value);
            next();
          })
          .catch((error) => {
            active -= 1;
            reject(error);
            next();
          });
      });
      next();
    });
}
