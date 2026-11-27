import type express from 'express';

interface RateBucket {
  count: number;
  resetAtMs: number;
}

const buckets = new Map<string, RateBucket>();
const MAX_TRACKED_KEYS = 5000;

function pruneExpiredBuckets(nowMs: number) {
  if (buckets.size < MAX_TRACKED_KEYS) return;
  for (const [key, entry] of buckets.entries()) {
    if (entry.resetAtMs <= nowMs) {
      buckets.delete(key);
    }
  }
  // If still oversized under heavy flood, evict oldest entries safely
  if (buckets.size >= MAX_TRACKED_KEYS) {
    const excess = buckets.size - Math.floor(MAX_TRACKED_KEYS * 0.75);
    let removed = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      removed += 1;
      if (removed >= excess) break;
    }
  }
}

export function extractClientKey(req: express.Request): string {
  // Do not trust a caller-supplied X-Forwarded-For header.
  return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

export function checkRateLimit(params: {
  scope: string;
  key: string;
  maxRequests: number;
  windowMs: number;
  nowMs?: number;
}): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
  const nowMs = params.nowMs ?? Date.now();
  pruneExpiredBuckets(nowMs);

  const compositeKey = `${params.scope}:${params.key}`;
  const current = buckets.get(compositeKey);

  if (!current || current.resetAtMs <= nowMs) {
    buckets.set(compositeKey, {
      count: 1,
      resetAtMs: nowMs + params.windowMs,
    });
    return {
      allowed: true,
      remaining: Math.max(0, params.maxRequests - 1),
      retryAfterSeconds: Math.ceil(params.windowMs / 1000),
    };
  }

  if (current.count >= params.maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAtMs - nowMs) / 1000)),
    };
  }

  current.count += 1;
  return {
    allowed: true,
    remaining: Math.max(0, params.maxRequests - current.count),
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetAtMs - nowMs) / 1000)),
  };
}

export function createRateLimiter(options: {
  scope: string;
  maxRequests: number;
  windowMs: number;
  message?: string;
}): express.RequestHandler {
  return (req, res, next) => {
    const clientKey = extractClientKey(req);
    const result = checkRateLimit({
      scope: options.scope,
      key: clientKey,
      maxRequests: options.maxRequests,
      windowMs: options.windowMs,
    });

    res.setHeader('X-RateLimit-Limit', String(options.maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      res.status(429).json({
        error:
          options.message ||
          'Too many requests in a short period. Please wait a moment and try again.',
        retryAfterSeconds: result.retryAfterSeconds,
      });
      return;
    }

    next();
  };
}

export function resetRateLimiterForTests(): void {
  buckets.clear();
}
