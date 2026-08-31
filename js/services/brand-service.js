/**
 * brand-service.js
 */
import http from '../core/http.js';
import { crudService } from './base.js';
import { brandSchema } from '../data/schema.js';

const crud = crudService('/brands', {
  perms: { view: 'products.view', create: 'brands.manage', edit: 'brands.manage', archive: 'brands.manage' },
  schema: brandSchema,
});

export const brandService = {
  getBrands: (params = {}) => http.get('/brands', { params }),
  getBrandById: crud.get,
  createBrand: crud.create,
  updateBrand: crud.update,
  archiveBrand: crud.archive,
  restoreBrand: crud.restore,
};

export default brandService;
