/**
 * gateway.js - payment-gateway driver abstraction (mock).
 *
 * A charge() call returns { status, gatewayRef }. Drivers:
 *   manual - the merchant enters a transaction reference; POS TXbd confirms it
 *            later from Super Admin -> Payments. charge() returns 'pending'.
 *   mock   - a test gateway that always succeeds instantly ('paid').
 *
 * A real driver (bKash, SSLCommerz, ...) plugs in here with the same shape.
 * Secret keys are NEVER read on the client - a real driver would post to the
 * server, which holds the credentials.
 */
import { platformSettings } from './platform-settings.routes.js';
import { uuid } from '../../utils/id.js';

const DRIVERS = {
  manual: {
    charge() {
      return { status: 'pending', gatewayRef: null };
    },
  },
  mock: {
    charge() {
      return { status: 'paid', gatewayRef: 'MOCK-' + uuid().slice(0, 8).toUpperCase() };
    },
  },
};

export function activeGateway() {
  const g = platformSettings().gateway || {};
  const driver = DRIVERS[g.driver] ? g.driver : 'manual';
  return {
    driver,
    displayName: g.displayName || (driver === 'mock' ? 'Test gateway' : 'Manual / bank transfer'),
    instructions: g.instructions || '',
  };
}

/** Run a charge through the configured driver. */
export function charge(input) {
  const g = activeGateway();
  return { ...DRIVERS[g.driver].charge(input), driver: g.driver };
}
