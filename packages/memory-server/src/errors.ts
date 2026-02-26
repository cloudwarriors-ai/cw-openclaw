export class MemoryApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MemoryApiError";
  }
}

export function isMemoryApiError(value: unknown): value is MemoryApiError {
  return value instanceof MemoryApiError;
}
