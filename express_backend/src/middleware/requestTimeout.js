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
    const timeoutMs = Number.isFinite(msRaw) && msRaw > 0 ? msRaw : 60000;

    // Capture start time for debug/telemetry.
    const start = Date.now();

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
