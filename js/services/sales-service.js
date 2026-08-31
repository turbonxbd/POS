/**
 * sales-service.js - checkout, sales history, held sales, returns.
 *
 * createSale() is the transaction entry point. It:
 *  - enforces sales.create permission
 *  - generates an idempotency key (prevents double-submit / refresh dupes, §45)
 *  - on network failure, queues the sale for offline sync (§34) and rethrows a
 *    typed error the POS can present as "Sale queued for synchronization".
 */
import http, { HttpError } from '../core/http.js';
import { requirePermission } from '../core/rbac.js';
import { withBranch } from './base.js';
import { uuid } from '../utils/id.js';
import syncQueue from '../core/sync-queue.js';

export const salesService = {
  getSales(params = {}) {
    requirePermission('sales.view');
    return http.get('/sales', { params: withBranch(params) });
  },
  getSaleById(id) {
    requirePermission('sales.view');
    return http.get(`/sales/${id}`);
  },
  lookupByInvoice(invoiceNo) {
    requirePermission('sales.view');
    return http.get('/sales/lookup', { params: { invoice: invoiceNo } });
  },

  /**
   * Complete a sale. `draft` = { items, payments, customerId, cartDiscount*, note }.
   * Pass an existing idempotencyKey to safely retry the same checkout.
   */
  async createSale(draft, { idempotencyKey } = {}) {
    requirePermission('sales.create');
    const body = withBranch({
      ...draft,
      idempotencyKey: idempotencyKey || draft.idempotencyKey || uuid(),
    });
    try {
      return await http.post('/sales', body);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 0 || err.status === 408)) {
        const item = syncQueue.enqueue({ path: '/sales', body, kind: 'sale' });
        const queued = new HttpError(202, 'Network connection lost. Sale queued for synchronization.', { queued: true, queueItemId: item.id });
        queued.queued = true;
        throw queued;
      }
      throw err;
    }
  },

  refundSale(saleId, payload) {
    requirePermission('sales.refund');
    return http.post(`/sales/${saleId}/returns`, payload);
  },
  getReturns(params = {}) {
    requirePermission('sales.view');
    return http.get('/sale-returns', { params: withBranch(params) });
  },

  /* held sales */
  getHeldSales(params = {}) {
    requirePermission('sales.hold');
    return http.get('/held-sales', { params: withBranch(params) });
  },
  holdSale(draft) {
    requirePermission('sales.hold');
    return http.post('/held-sales', withBranch(draft));
  },
  deleteHeldSale(id) {
    requirePermission('sales.hold');
    return http.del(`/held-sales/${id}`);
  },
};

export default salesService;
