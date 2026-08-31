/**
 * mock-server.js - assembles the in-process REST backend.
 *
 * It registers every route module against one MockRouter and exposes a single
 * `handle({method, path, query, body})` which http.js calls in mock mode. To go
 * live, set config.api.mode = 'rest' + baseUrl; nothing else in the app changes.
 */

import { MockRouter } from './mock/router.js';
import { registerMockHandler } from './http.js';
import { setActor, setActiveBranch, clearContext } from './mock/context.js';
import { enforceAccessGate } from './mock/platform-helpers.js';

import registerAuth from './mock/auth.routes.js';
import registerCatalog from './mock/catalog.routes.js';
import registerInventory from './mock/inventory.routes.js';
import registerSales from './mock/sales.routes.js';
import registerPurchasing from './mock/purchasing.routes.js';
import registerPeople from './mock/people.routes.js';
import registerFinance from './mock/finance.routes.js';
import registerOrg from './mock/org.routes.js';
import registerAnalytics from './mock/analytics.routes.js';
import registerPlans from './mock/plans.routes.js';
import registerSignup from './mock/signup.routes.js';
import registerPlatform from './mock/platform.routes.js';
import registerPlatformSettings from './mock/platform-settings.routes.js';
import registerBilling from './mock/billing.routes.js';
import registerChat from './mock/chat.routes.js';

const router = new MockRouter();
let initialised = false;

export function initMockServer() {
  if (initialised) return router;
  [
    registerAuth,
    registerCatalog,
    registerInventory,
    registerSales,
    registerPurchasing,
    registerPeople,
    registerFinance,
    registerOrg,
    registerAnalytics,
    registerPlans,
    registerSignup,
    registerPlatform,
    registerPlatformSettings,
    registerBilling,
    registerChat,
  ].forEach((fn) => fn(router));

  registerMockHandler((req) => {
    enforceAccessGate(req);
    return router.handle(req);
  });
  initialised = true;
  return router;
}

/** Auth layer calls these so mock handlers know the caller & active branch. */
export const mockContext = { setActor, setActiveBranch, clearContext };

export default initMockServer;
