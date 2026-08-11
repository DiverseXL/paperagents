/**
 * Rejects `promise` with a descriptive error if it does not settle within `ms`.
 *
 * The underlying promise keeps running in the background if it loses the race
 * (we cannot abort it without threading an AbortSignal through callRuntime) —
 * the caller just stops waiting, which is the point of the cap. The timer is
 * cleared when the promise settles first so the event loop is not held open.
 *
 * TODO: if hung requests ever cause provider-side cost or connection-pool
 * pressure, thread an AbortSignal through callRuntime (OpenAI SDK `signal`
 * option) and abort here instead of just abandoning the promise.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
