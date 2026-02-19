'use strict';

const crypto = require('crypto');

// PUBLIC_INTERFACE
function uuidV4() {
  /** Generate a v4 UUID using Node's crypto (no external dependency). */
  return crypto.randomUUID();
}

module.exports = { uuidV4 };
