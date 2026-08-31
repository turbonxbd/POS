/**
 * discount-service.js
 */
import http from '../core/http.js';
import { crudService } from './base.js';
import { discountSchema } from '../data/schema.js';

const crud = crudService('/discounts', {
  perms: { view: 'pos.operate', create: 'discounts.manage', edit: 'discounts.manage', archive: 'discounts.manage' },
  schema: discountSchema,
});

export const discountService = {
  getDiscounts: (params = {}) => http.get('/discounts', { params }),
  createDiscount: crud.create,
  updateDiscount: crud.update,
  archiveDiscount: crud.archive,
  restoreDiscount: crud.restore,
  validateCoupon: (code, subtotal) => http.post('/discounts/validate', { code, subtotal }),
};

export default discountService;
