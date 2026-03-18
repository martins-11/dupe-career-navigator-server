import crypto from 'crypto';

/**
 * PUBLIC_INTERFACE
 * @returns {string}
 */
export function uuidV4() {
  /** Generate a v4 UUID using Node's crypto (no external dependency). */
  return crypto.randomUUID();
}
