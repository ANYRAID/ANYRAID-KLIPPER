export type PrintOperation =
  'start' | 'pause' | 'resume' | 'finish' | 'safe stop' | 'cancel';
export class PrintTimeoutError extends Error {
  readonly operation: PrintOperation;
  readonly timeoutMs: number;
  constructor(operation: PrintOperation, timeoutMs: number) {
    super(`Print ${operation} timed out after ${timeoutMs} ms`);
    this.name = 'PrintTimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}
/** Bounds caller waiting only. The adapter promise remains observed and owned. */
export function printDeadline<T>(
  pending: Promise<T>,
  operation: PrintOperation,
  timeoutMs: number,
  signal?: AbortSignal,
  onTimeout?: (error: PrintTimeoutError) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (ok: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (ok) resolve(value as T);
      else reject(value);
    };
    const aborted = () => finish(false, signal!.reason);
    const timer = setTimeout(() => {
      const error = new PrintTimeoutError(operation, timeoutMs);
      onTimeout?.(error);
      finish(false, error);
    }, timeoutMs);
    pending.then(
      (value) => finish(true, value),
      (error) => finish(false, error),
    );
    if (signal) {
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    }
  });
}
