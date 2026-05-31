export async function retryTransientApiError<T>(label: string, operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientApiError(error) || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}

function isTransientApiError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(ECONNRESET|ECONNREFUSED|EPIPE)\b|socket hang up|fetch failed/i.test(message);
}
