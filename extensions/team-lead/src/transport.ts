// Fetch wrapper with exponential backoff retry

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RetryResult {
  ok: boolean;
  response?: Response;
  error?: string;
  attempts: number;
  lastStatus?: number;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 4000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  config?: Partial<RetryConfig>,
  logger?: { warn: (msg: string) => void },
): Promise<RetryResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let lastError: string | undefined;
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      lastStatus = response.status;

      if (response.ok) {
        return { ok: true, response, attempts: attempt + 1 };
      }

      // Don't retry client errors (4xx) except 429 (rate limit)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        lastError = `HTTP ${response.status}`;
        return { ok: false, error: lastError, attempts: attempt + 1, lastStatus };
      }

      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (attempt < cfg.maxRetries) {
      const delay = Math.min(cfg.baseDelayMs * 2 ** attempt, cfg.maxDelayMs);
      logger?.warn(`Retry ${attempt + 1}/${cfg.maxRetries} for ${url} in ${delay}ms: ${lastError}`);
      await sleep(delay);
    }
  }

  return {
    ok: false,
    error: `delivery_failed: ${lastError}`,
    attempts: cfg.maxRetries + 1,
    lastStatus,
  };
}
