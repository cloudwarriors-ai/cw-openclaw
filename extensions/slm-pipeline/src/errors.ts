export class SlmPipelineError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SlmPipelineError";
  }
}

export function isSlmPipelineError(value: unknown): value is SlmPipelineError {
  return value instanceof SlmPipelineError;
}
