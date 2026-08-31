/**
 * barcode-service.js - generation + assignment. Rendering (Code128 SVG) is in
 * components/barcode.js; this service handles data + uniqueness via the backend.
 */
import http from '../core/http.js';
import { requirePermission } from '../core/rbac.js';
import { generateEan13, isValidEan13 } from '../utils/id.js';

export const barcodeService = {
  generate(count = 1) {
    requirePermission('barcode.manage');
    return http.post('/barcode/generate', { count });
  },
  generateLocal(count = 1) {
    return Array.from({ length: count }, (_, i) => generateEan13(Date.now() + i * 41));
  },
  assign(productId, barcode, variantId = null) {
    requirePermission('barcode.manage');
    return http.post('/barcode/assign', { productId, barcode, variantId });
  },
  isValid: isValidEan13,
};

export default barcodeService;
