'use strict';

// PUBLIC_INTERFACE
function requestTimeout() {
  /** Enforces a per-request timeout using REQUEST_TIMEOUT_MS (defaults to 30000). */
  const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 30000);

  return function requestTimeoutMiddleware(req, res, next) {
    res.setTimeout(timeoutMs, () => {
      res.status(504).json({ error: 'request_timeout' });
    });
    next();
  };
}

module.exports = { requestTimeout };
