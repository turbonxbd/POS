/**
 * event-bus.js - app-wide pub/sub. Used for cross-module signals like
 * 'auth:changed', 'branch:changed', 'data:products', 'notification:new'.
 */

class EventBus {
  #map = new Map();

  on(event, handler) {
    if (!this.#map.has(event)) this.#map.set(event, new Set());
    this.#map.get(event).add(handler);
    return () => this.off(event, handler);
  }

  once(event, handler) {
    const wrap = (payload) => {
      this.off(event, wrap);
      handler(payload);
    };
    return this.on(event, wrap);
  }

  off(event, handler) {
    this.#map.get(event)?.delete(handler);
  }

  emit(event, payload) {
    this.#map.get(event)?.forEach((h) => {
      try {
        h(payload);
      } catch (err) {
        console.error(`[event-bus] handler for "${event}" threw`, err);
      }
    });
    // Wildcard listeners
    this.#map.get('*')?.forEach((h) => {
      try {
        h({ event, payload });
      } catch (err) {
        console.error('[event-bus] wildcard handler threw', err);
      }
    });
  }

  clear(event) {
    if (event) this.#map.delete(event);
    else this.#map.clear();
  }
}

export const bus = new EventBus();
export default bus;
