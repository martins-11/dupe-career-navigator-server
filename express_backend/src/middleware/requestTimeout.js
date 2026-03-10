'use strict';

// PUBLIC_INTERFACE
function requestTimeout() {
  /** Enforces a per-request timeout using REQUEST_TIMEOUT_MS (defaults to 30000).
   *
   * Important hardening:
   * - Ensures we send at most one response (prevents ERR_HTTP_HEADERS_SENT).
   * - Marks the request as timed out so downstream handlers can stop work/avoid responding.
   */
  const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 30000);

  return function requestTimeoutMiddleware(req, res, next) {
    // Markers used by downstream handlers.
    req.timedOut = false;

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
