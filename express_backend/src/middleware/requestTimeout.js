'use strict';

// PUBLIC_INTERFACE
function requestTimeout() {
  /** Enforces a per-request timeout using REQUEST_TIMEOUT_MS (defaults to 30000).
   *
   * Important hardening:
   * - Ensures we send at most one response (prevents ERR_HTTP_HEADERS_SENT).
   * - Marks the request as timed out so downstream handlers can stop work/avoid responding.
   *
   * Timeout selection:
   * - Global default: REQUEST_TIMEOUT_MS (30s)
   * - For slow AI endpoints we allow a larger budget:
   *   - REQUEST_TIMEOUT_INITIAL_RECOMMENDATIONS_MS (defaults to 45000)
   */
  const defaultTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
  const initialRecommendationsTimeoutMs = Number(
    process.env.REQUEST_TIMEOUT_INITIAL_RECOMMENDATIONS_MS || 45000
  );

  return function requestTimeoutMiddleware(req, res, next) {
    // Select a per-route timeout budget.
    const isInitialRecommendations =
      req.method === 'GET' && (req.path === '/api/recommendations/initial' || req.path.endsWith('/recommendations/initial'));

    const timeoutMs = isInitialRecommendations
      ? initialRecommendationsTimeoutMs
      : defaultTimeoutMs;
    // Markers used by downstream handlers.
    req.timedOut = false;

    // Expose timing metadata so downstream services can enforce a time budget
    // (e.g., cap Bedrock invocation time to ensure we respond before timeout).
    req.requestTimeoutMs = timeoutMs;
    req.requestStartMs = Date.now();
    req.requestDeadlineMs = req.requestStartMs + timeoutMs;

    // Use an explicit timer instead of res.setTimeout callback sending a response,
    // because res.setTimeout can still fire even if downstream sends later,
    // causing a second response attempt.
    const timer = setTimeout(() => {
      req.timedOut = true;

      // Only attempt to respond if nothing has been sent yet.
      if (!res.headersSent) {
        res.status(504).json({ error: 'request_timeout' });
      }
    }, timeoutMs);

    // Ensure the timer is cleared when the response lifecycle ends.
    const cleanup = () => clearTimeout(timer);
    res.once('finish', cleanup);
    res.once('close', cleanup);

    next();
  };
}

module.exports = { requestTimeout };
