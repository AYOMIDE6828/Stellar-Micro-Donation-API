'use strict';

/**
 * In-Memory Rate Limit Store (#1482)
 *
 * RESPONSIBILITY: Provide in-process rate limit counters (suitable for single-instance deployments)
 * OWNER: Backend Team
 * DEPENDENCIES: RateLimitStore base class
 *
 * Stores rate limit counters in a JavaScript Map with automatic expiration.
 * Not suitable for multi-instance deployments without a shared backing store.
 */

const RateLimitStore = require('./RateLimitStore');
const timerRegistry = require('../../utils/timerRegistry');

class MemoryRateLimitStore extends RateLimitStore {
  constructor() {
    super();
    this.counters = new Map();
    this.timers = new Map();
  }

  /**
   * Increment a rate limit counter by 1.
   * Automatically removes the key when the window expires.
   *
   * @param {string} key - Rate limit key
   * @param {number} windowMs - Expiration window in milliseconds
   * @returns {Promise<number>} The new counter value after increment
   */
  async increment(key, windowMs) {
    // Clear any existing timer for this key
    if (this.timers.has(key)) {
      this.timers.get(key).clear();
    }

    // Increment the counter
    const current = (this.counters.get(key) || 0) + 1;
    this.counters.set(key, current);

    // Set expiration
    const timer = timerRegistry.createTimeout(() => {
      this.counters.delete(key);
      this.timers.delete(key);
    }, windowMs, 'rate-limit-window');
    timer.unref();

    this.timers.set(key, timer);

    return current;
  }

  /**
   * Get the current counter value for a key.
   *
   * @param {string} key - Rate limit key
   * @returns {Promise<number>} Current counter value, or 0 if key does not exist
   */
  async get(key) {
    return this.counters.get(key) || 0;
  }

  /**
   * Reset a rate limit counter to 0.
   *
   * @param {string} key - Rate limit key
   * @returns {Promise<void>}
   */
  async reset(key) {
    if (this.timers.has(key)) {
      this.timers.get(key).clear();
      this.timers.delete(key);
    }
    this.counters.delete(key);
  }

  /**
   * Check if the store is healthy.
   * Always returns true for in-memory store.
   *
   * @returns {Promise<boolean>} Always true
   */
  async isHealthy() {
    return true;
  }

  /**
   * Gracefully shutdown the store.
   * Clears all counters and timers.
   *
   * @returns {Promise<void>}
   */
  async shutdown() {
    for (const timer of this.timers.values()) {
      timer.clear();
    }
    this.counters.clear();
    this.timers.clear();
  }

  /**
   * Clear all rate limit counters (for testing).
   *
   * @returns {Promise<void>}
   */
  async clear() {
    await this.shutdown();
  }
}

module.exports = MemoryRateLimitStore;
