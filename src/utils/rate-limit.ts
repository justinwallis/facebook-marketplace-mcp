export const DEFAULT_MAX_REQUESTS_PER_MINUTE = 3;
export const INTER_REQUEST_JITTER_MS = { min: 500, max: 2_000 } as const;
export const WINDOW_WAIT_JITTER_MS = { min: 1_000, max: 3_000 } as const;

export type RateLimitWaitRange = { minMs: number; maxMs: number; requestCount: number; maxPerMinute: number };

/** Estimates only limiter wait time; it does not sleep or mutate limiter state. */
export function estimateRateLimitWaitRange(requestCount: number, maxPerMinute = DEFAULT_MAX_REQUESTS_PER_MINUTE): RateLimitWaitRange {
  const requests = Math.max(0, Math.floor(requestCount));
  const perMinute = Math.max(1, Math.floor(maxPerMinute));
  let minMs = 0;
  let maxMs = 0;
  for (let priorRequests = 1; priorRequests < requests; priorRequests += 1) {
    if (priorRequests % perMinute === 0) {
      minMs += 60_000 + WINDOW_WAIT_JITTER_MS.min;
      maxMs += 60_000 + WINDOW_WAIT_JITTER_MS.max;
    } else {
      minMs += INTER_REQUEST_JITTER_MS.min;
      maxMs += INTER_REQUEST_JITTER_MS.max;
    }
  }
  return { minMs, maxMs, requestCount: requests, maxPerMinute: perMinute };
}

export class RateLimiter {
  private maxPerMinute: number;
  private timestamps: number[] = [];

  constructor(maxPerMinute: number) {
    this.maxPerMinute = maxPerMinute;
  }

  async wait(): Promise<void> {
    const now = Date.now();
    // Remove timestamps older than 1 minute
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);

    if (this.timestamps.length >= this.maxPerMinute) {
      const oldest = this.timestamps[0];
      const waitMs = 60_000 - (now - oldest);
      if (waitMs > 0) {
        // Add random jitter (1-3s)
        const jitter = WINDOW_WAIT_JITTER_MS.min + Math.random() * (WINDOW_WAIT_JITTER_MS.max - WINDOW_WAIT_JITTER_MS.min);
        await sleep(waitMs + jitter);
      }
    } else {
      // Add small jitter between requests (500ms - 2s)
      const jitter = INTER_REQUEST_JITTER_MS.min + Math.random() * (INTER_REQUEST_JITTER_MS.max - INTER_REQUEST_JITTER_MS.min);
      if (this.timestamps.length > 0) {
        await sleep(jitter);
      }
    }

    this.timestamps.push(Date.now());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
