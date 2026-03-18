/**
 * Request timeout middleware.
 *
 * Ensures requests do not hang indefinitely (especially when DB/network is misconfigured).
 */

/**
 * PUBLIC_INTERFACE
 * @returns {import('express').RequestHandler}
 */
export function requestTimeout() {
  /** Express middleware enforcing an upper bound on request processing time. */
  return function requestTimeoutMiddleware(req, res, next) {
    const msRaw = Number(process.env.REQUEST_TIMEOUT_MS || 60000);
    const defaultTimeoutMs = Number.isFinite(msRaw) && msRaw > 0 ? msRaw : 60000;

    /**
     * Route-specific timeout override (CRITICAL for Bedrock-backed endpoints):
     * - /api/recommendations/initial often needs >30s in some environments
     * - Without a higher timeout, Bedrock gets aborted and the endpoint falls back.
     *
     * Env (optional):
     * - REQUEST_TIMEOUT_INITIAL_RECOMMENDATIONS_MS (default: 45000)
     */
    const initialRecMsRaw = Number(process.env.REQUEST_TIMEOUT_INITIAL_RECOMMENDATIONS_MS || 45000);
    const initialRecTimeoutMs =
      Number.isFinite(initialRecMsRaw) && initialRecMsRaw > 0 ? initialRecMsRaw : 45000;

    const url = String(req.originalUrl || req.url || '');
    const isInitialRecommendations = url.includes('/recommendations/initial');

    const timeoutMs = isInitialRecommendations ? initialRecTimeoutMs : defaultTimeoutMs;

    // Capture start time for debug/telemetry.
    const start = Date.now();

    /**
     * Attach request timing/deadline metadata for downstream time budgeting.
     * Routes like /api/recommendations/initial use these to compute a safe Bedrock AbortController budget.
     */
    req.requestStartMs = start;
    req.requestTimeoutMs = timeoutMs;
    req.requestDeadlineMs = start + timeoutMs;

    // Set a hard timeout on the response.
    res.setTimeout(timeoutMs, () => {
      if (res.headersSent) return;
      res.status(504).json({
        error: 'request_timeout',
        message: `Request exceeded ${timeoutMs}ms`
      });
    });

    // Attach a small debug header once the response finishes.
    res.on('finish', () => {
      const elapsed = Date.now() - start;

      // Avoid mutating headers after sent; this is just best-effort observability.
      // eslint-disable-next-line no-console
      if (process.env.LOG_REQUEST_TIMINGS === 'true') {
        console.log(`[timing] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${elapsed}ms)`);
      }
    });

    next();
  };
}
