/**
 * tax-service.js
 */
import http from '../core/http.js';
import { crudService } from './base.js';
import { taxSchema } from '../data/schema.js';

const crud = crudService('/taxes', {
  perms: { view: 'pos.operate', create: 'taxes.manage', edit: 'taxes.manage', archive: 'taxes.manage' },
  schema: taxSchema,
});

export const taxService = {
  getTaxes: (params = {}) => http.get('/taxes', { params }),
  createTax: crud.create,
  updateTax: crud.update,
  archiveTax: crud.archive,
  restoreTax: crud.restore,
};

export default taxService;
