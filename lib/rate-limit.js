/**
 * Simple In-Memory Rate Limiter
 * Suitable for Vercel serverless environment (resets across cold starts)
 */
const requestCounts = new Map();

export function rateLimit(key, maxRequests = 5, windowMs = 60000) {
  const now = Date.now();
  const entry = requestCounts.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }

  if (entry.count >= maxRequests) {
    return false; // rate limited
  }

  entry.count++;
  requestCounts.set(key, entry);
  return true;
}
