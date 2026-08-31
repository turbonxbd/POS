/**
 * catalog.routes.js - products, product variants, categories, brands, barcode.
 * Products use SAFE ARCHIVING (never hard-deleted) so historical sale line
 * snapshots remain valid.
 */

import db from '../db.js';
import { tdb } from './scope.js';
import { ok, created, notFound, badRequest, conflict, applyListQuery } from './router.js';
import { defineResource } from './resource.js';
import { audit, getStockQty, resolveBranchId, postInventory } from './helpers.js';
import { uuid, suggestSku, generateEan13 } from '../../utils/id.js';
import { now } from '../../utils/date.js';

/* ------------------------------------------------------------ barcode helper */

/** Every barcode used by this merchant (product bodies + variants). */
function usedBarcodes(exceptProductId = null) {
  const set = new Set();
  for (const p of tdb('products').all()) {
    if (p.id === exceptProductId) continue;
    if (p.barcode) set.add(String(p.barcode));
    for (const v of p.variants || []) if (v.barcode) set.add(String(v.barcode));
  }
  return set;
}

/**
 * A barcode not yet used by ANY of this merchant's products. Across merchants
 * the same barcode may repeat (a real EAN on a shared product) - the check is
 * merchant-scoped via tdb(). `taken` lets a single create reserve codes for its
 * own new variants before they are persisted.
 */
function uniqueBarcode(taken = new Set(), exceptProductId = null) {
  const used = usedBarcodes(exceptProductId);
  for (let i = 0; i < 50; i++) {
    const code = generateEan13();
    if (!used.has(code) && !taken.has(code)) {
      taken.add(code);
      return code;
    }
  }
  return generateEan13(); // 50 collisions in a 1e9 space is effectively impossible
}

/* --------------------------------------------------------- decorate helpers */

function productStatus(product, branchId) {
  if (product.archivedAt) return 'archived';
  if (product.status === 'inactive') return 'inactive';
  const qty = totalStock(product, branchId);
  if (qty <= 0) return 'out_of_stock';
  if (product.minStock > 0 && qty <= product.minStock) return 'low_stock';
  return 'active';
}

function totalStock(product, branchId) {
  const bid = branchId || resolveBranchId();
  if (product.variants?.length) {
    return product.variants.reduce((s, v) => s + getStockQty(bid, product.id, v.id), 0);
  }
  return getStockQty(bid, product.id, null);
}

function branchStockOf(p) {
  return tdb('branches').all()
    .filter((b) => !b.archivedAt)
    .map((b) => ({ branchId: b.id, branchName: b.name, qty: totalStock(p, b.id) }));
}

function decorateProduct(p, { branchId, allBranches = false } = {}) {
  const bid = branchId || resolveBranchId();
  const category = p.categoryId ? tdb('categories').get(p.categoryId) : null;
  const brand = p.brandId ? tdb('brands').get(p.brandId) : null;
  const supplier = p.supplierId ? tdb('suppliers').get(p.supplierId) : null;
  const stock = totalStock(p, bid);
  const out = {
    ...p,
    stock,
    computedStatus: productStatus(p, bid),
    categoryName: category?.name || null,
    subcategoryName: p.subcategoryId
      ? tdb('categories').get(p.subcategoryId)?.name || null
      : null,
    brandName: brand?.name || null,
    supplierName: supplier?.name || null,
    variantStock: p.variants?.map((v) => ({ id: v.id, stock: getStockQty(bid, p.id, v.id) })) || [],
    stockValue: stock * (getStockRowAvg(bid, p) || p.costPrice || 0),
  };
  if (allBranches) {
    out.branchStock = branchStockOf(p);
    out.totalStockAllBranches = out.branchStock.reduce((s, r) => s + r.qty, 0);
  }
  return out;
}

function getStockRowAvg(branchId, product) {
  const row = tdb('stock').get(`stk_${branchId}_${product.id}_base`);
  return row?.avgCost || 0;
}

/* -------------------------------------------------------------- validation */

function validateProductPayload(body, { existingId = null } = {}) {
  const errors = {};
  if (!body.name || !String(body.name).trim()) errors.name = 'Product name is required';
  if (body.sellingPrice == null || Number(body.sellingPrice) < 0) errors.sellingPrice = 'Selling price is required';
  if (body.costPrice != null && Number(body.costPrice) < 0) errors.costPrice = 'Cost price cannot be negative';
  if (body.mrp != null && body.mrp !== '' && Number(body.mrp) < 0) errors.mrp = 'MRP cannot be negative';
  if (body.mrp != null && body.mrp !== '' && Number(body.mrp) > 0 && body.sellingPrice != null && Number(body.sellingPrice) > Number(body.mrp)) {
    errors.sellingPrice = 'Selling price cannot exceed the MRP';
  }
  // branch stock rows (create): each row must name a branch and a non-negative integer qty
  if (Array.isArray(body.branchStock)) {
    const branchIds = new Set(tdb('branches').all().map((b) => b.id));
    body.branchStock.forEach((r, i) => {
      if (!r || !r.branchId || !branchIds.has(r.branchId)) errors[`branchStock.${i}.branchId`] = 'Select a branch';
      const q = Number(r?.qty);
      if (!Number.isFinite(q) || q < 0 || !Number.isInteger(q)) errors[`branchStock.${i}.qty`] = 'Quantity must be a whole number (0 or more)';
    });
  }

  // Unique SKU / barcode (across non-archived and archived - identifiers are permanent)
  const products = tdb('products').all();
  if (body.sku) {
    const clash = products.find((p) => p.id !== existingId && p.sku && p.sku.toLowerCase() === String(body.sku).toLowerCase());
    if (clash) errors.sku = `SKU already used by "${clash.name}"`;
  }
  if (body.barcode) {
    const clash = products.find((p) => p.id !== existingId && p.barcode === String(body.barcode));
    if (clash) errors.barcode = `Barcode already used by "${clash.name}"`;
    const vClash = products.find((p) => p.id !== existingId && p.variants?.some((v) => v.barcode === String(body.barcode)));
    if (vClash) errors.barcode = `Barcode already used by a variant of "${vClash.name}"`;
  }
  if (Object.keys(errors).length) badRequest('Please fix the highlighted fields', errors);
}

function normalizeAttributes(a) {
  if (!a || typeof a !== 'object') return {};
  const out = {};
  for (const k of ['color', 'size', 'variant']) {
    const v = String(a[k] ?? '').trim();
    if (v) out[k] = v;
  }
  return out;
}

function normalizeProduct(body, existing = null) {
  const name = String(body.name).trim();
  // reserve codes for this single create so its own new variants never clash
  const taken = new Set();
  if (body.barcode) taken.add(String(body.barcode));
  const variants = (body.variants || []).map((v) => ({
    id: v.id || uuid(),
    name: v.name || (v.options ? Object.values(v.options).join(' / ') : ''),
    options: v.options || {},
    sku: v.sku || suggestSku(name, Object.values(v.options || {})),
    barcode: v.barcode || uniqueBarcode(taken, existing?.id),
    costPrice: Math.max(0, Math.trunc(v.costPrice ?? body.costPrice ?? 0)),
    sellingPrice: Math.max(0, Math.trunc(v.sellingPrice ?? body.sellingPrice ?? 0)),
    wholesalePrice: Math.max(0, Math.trunc(v.wholesalePrice ?? body.wholesalePrice ?? 0)),
    minStock: Math.max(0, Number(v.minStock ?? body.minStock ?? 0)),
    imageId: v.imageId || null,
    openingStock: Math.max(0, Number(v.openingStock ?? 0)),
  }));
  return {
    name,
    sku: body.sku || existing?.sku || suggestSku(name),
    barcode: body.barcode || existing?.barcode || uniqueBarcode(taken, existing?.id),
    description: body.description || '',
    imageId: body.imageId ?? existing?.imageId ?? null,
    categoryId: body.categoryId || null,
    subcategoryId: body.subcategoryId || null,
    brandId: body.brandId || null,
    supplierId: body.supplierId || null,
    unit: body.unit || 'pcs',
    costPrice: Math.max(0, Math.trunc(body.costPrice ?? 0)),
    sellingPrice: Math.max(0, Math.trunc(body.sellingPrice ?? 0)),
    mrp: body.mrp != null && body.mrp !== '' ? Math.max(0, Math.trunc(body.mrp)) : (existing?.mrp ?? null),
    wholesalePrice: Math.max(0, Math.trunc(body.wholesalePrice ?? 0)),
    discountPrice: body.discountPrice != null ? Math.max(0, Math.trunc(body.discountPrice)) : null,
    taxId: body.taxId || null,
    attributes: normalizeAttributes(body.attributes ?? existing?.attributes),
    minStock: Math.max(0, Number(body.minStock ?? 0)),
    maxStock: Math.max(0, Number(body.maxStock ?? 0)),
    trackInventory: body.trackInventory !== false,
    hasVariants: variants.length > 0,
    variants,
    status: body.status || existing?.status || 'active',
    tags: body.tags || [],
  };
}

/* ==================================================================== */

export default function register(router) {
  /* ---------------- Products (custom, not generic, due to stock + variants) */

  router.get('/products', ({ query }) => {
    const branchId = query.branchId || resolveBranchId();
    let rows = tdb('products').all();
    if (query.includeArchived !== 'true') rows = rows.filter((p) => !p.archivedAt);
    if (query.categoryId) rows = rows.filter((p) => p.categoryId === query.categoryId || p.subcategoryId === query.categoryId);
    if (query.brandId) rows = rows.filter((p) => p.brandId === query.brandId);
    if (query.supplierId) rows = rows.filter((p) => p.supplierId === query.supplierId);
    if (query.status && query.status !== 'all') {
      rows = rows.filter((p) => productStatus(p, branchId) === query.status);
    }
    if (query.barcode) {
      rows = rows.filter(
        (p) => p.barcode === query.barcode || p.variants?.some((v) => v.barcode === query.barcode),
      );
    }

    const result = applyListQuery(rows, query, {
      searchable: ['name', 'sku', 'barcode'],
      sortable: ['name', 'sku', 'sellingPrice', 'costPrice', 'createdAt', 'stock'],
      defaultSort: 'name',
      defaultDir: 'asc',
      accessors: { stock: (p) => totalStock(p, branchId) },
    });
    return ok({ ...result, data: result.data.map((p) => decorateProduct(p, { branchId })) });
  });

  router.get('/products/lookup', ({ query }) => {
    const branchId = query.branchId || resolveBranchId();
    const code = String(query.code || query.barcode || '').trim();
    const term = String(query.q || '').trim().toLowerCase();
    const products = tdb('products').all().filter((p) => !p.archivedAt && p.status === 'active');

    if (code) {
      for (const p of products) {
        if (p.barcode === code) return ok({ match: 'product', product: decorateProduct(p, { branchId }), variantId: null });
        const v = p.variants?.find((x) => x.barcode === code);
        if (v) return ok({ match: 'variant', product: decorateProduct(p, { branchId }), variantId: v.id });
        if (p.sku.toLowerCase() === code.toLowerCase()) {
          return ok({ match: 'sku', product: decorateProduct(p, { branchId }), variantId: null });
        }
      }
      return ok({ match: null });
    }

    const hits = products
      .filter((p) => p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term))
      .slice(0, Number(query.limit) || 20)
      .map((p) => decorateProduct(p, { branchId }));
    return ok({ match: 'list', results: hits });
  });

  router.get('/products/:id', ({ params, query }) => {
    const p = tdb('products').get(params.id);
    if (!p) notFound('Product');
    return ok(decorateProduct(p, { branchId: query.branchId, allBranches: query.allBranches === 'true' || query.allBranches === true }));
  });

  router.post('/products', ({ body }) => {
    validateProductPayload(body || {});
    const doc = normalizeProduct(body || {});
    return db.tx(() => {
      const branchId = body.branchId || resolveBranchId();
      const row = tdb('products').insert(doc);

      // opening stock -> immutable inventory ledger (branch-level = source of truth)
      if (doc.trackInventory) {
        if (doc.variants.length) {
          doc.variants.forEach((v) => {
            if (v.openingStock > 0 && branchId) {
              postInventory({
                branchId, productId: row.id, variantId: v.id, type: 'opening',
                qtyDelta: v.openingStock, unitCost: v.costPrice, refType: 'product', refId: row.id,
                note: 'Opening stock',
              });
            }
          });
        } else if (Array.isArray(body.branchStock) && body.branchStock.length) {
          // merge duplicate branch rows, then post one opening movement per branch
          const merged = new Map();
          for (const r of body.branchStock) {
            const q = Math.max(0, Math.trunc(Number(r.qty) || 0));
            merged.set(r.branchId, (merged.get(r.branchId) || 0) + q);
          }
          for (const [bId, qty] of merged) {
            if (qty > 0) {
              postInventory({
                branchId: bId, productId: row.id, variantId: null, type: 'opening',
                qtyDelta: qty, unitCost: doc.costPrice, refType: 'product', refId: row.id,
                note: 'Opening stock',
              });
            }
          }
        } else if (Number(body.openingStock) > 0 && branchId) {
          postInventory({
            branchId, productId: row.id, variantId: null, type: 'opening',
            qtyDelta: Number(body.openingStock), unitCost: doc.costPrice, refType: 'product', refId: row.id,
            note: 'Opening stock',
          });
        }
      }
      audit('create', 'product', row.id, { after: row });
      return created(decorateProduct(tdb('products').get(row.id), { branchId, allBranches: true }));
    });
  });

  router.patch('/products/:id', ({ params, body }) => {
    const existing = tdb('products').get(params.id);
    if (!existing) notFound('Product');
    // validate the merged result so a partial PATCH (e.g. just { minStock }) is allowed
    validateProductPayload({ ...existing, ...body }, { existingId: params.id });
    const doc = normalizeProduct({ ...existing, ...body }, existing);
    return db.tx(() => {
      const row = tdb('products').update(params.id, doc);
      audit('update', 'product', row.id, { before: existing, after: row });
      return ok(decorateProduct(row, { branchId: body.branchId }));
    });
  });

  router.del('/products/:id', ({ params }) => {
    const existing = tdb('products').get(params.id);
    if (!existing) notFound('Product');
    return db.tx(() => {
      const row = tdb('products').update(params.id, { archivedAt: now(), status: 'archived' });
      audit('archive', 'product', row.id, { before: existing, after: row });
      return ok({ archived: true, id: row.id });
    });
  });

  router.post('/products/:id/restore', ({ params }) => {
    const existing = tdb('products').get(params.id);
    if (!existing) notFound('Product');
    return db.tx(() => {
      const row = tdb('products').update(params.id, { archivedAt: undefined, status: 'active' });
      audit('update', 'product', row.id, { meta: { action: 'restore' } });
      return ok(decorateProduct(row));
    });
  });

  router.post('/products/:id/duplicate', ({ params }) => {
    const src = tdb('products').get(params.id);
    if (!src) notFound('Product');
    return db.tx(() => {
      const copy = normalizeProduct({
        ...src,
        name: `${src.name} (Copy)`,
        sku: suggestSku(src.name + ' copy'),
        barcode: undefined,
        variants: (src.variants || []).map((v) => ({ ...v, id: uuid(), sku: v.sku + '-C', barcode: undefined, openingStock: 0 })),
      });
      const row = tdb('products').insert(copy);
      audit('create', 'product', row.id, { after: row, meta: { duplicatedFrom: src.id } });
      return created(decorateProduct(row));
    });
  });

  router.post('/products/bulk', ({ body }) => {
    const { action, ids = [], patch = {}, items = [] } = body || {};
    return db.tx(() => {
      let affected = 0;
      if (action === 'import') {
        for (const raw of items) {
          try {
            validateProductPayload(raw);
            tdb('products').insert(normalizeProduct(raw));
            affected++;
          } catch (e) {
            /* skip invalid row, continue import */
          }
        }
      } else {
        for (const id of ids) {
          const existing = tdb('products').get(id);
          if (!existing) continue;
          if (action === 'archive') tdb('products').update(id, { archivedAt: now(), status: 'archived' });
          else if (action === 'restore') tdb('products').update(id, { archivedAt: undefined, status: 'active' });
          else if (action === 'update') tdb('products').update(id, patch);
          affected++;
        }
      }
      audit('update', 'product', null, { meta: { bulk: action, count: affected } });
      return ok({ affected });
    });
  });

  /* ---------------------------------------------------- Categories & Brands */

  defineResource(router, {
    base: '/categories',
    collection: 'categories',
    entity: 'category',
    listOptions: {
      searchable: ['name'],
      sortable: ['name', 'order', 'createdAt'],
      defaultSort: 'order',
      defaultDir: 'asc',
      filters: { parentId: 'parentId', status: 'status' },
    },
    beforeCreate: (b) => ({
      name: String(b.name || '').trim(),
      parentId: b.parentId || null,
      imageId: b.imageId || null,
      description: b.description || '',
      order: Number(b.order) || 0,
      status: b.status || 'active',
    }),
    decorate: (c) => ({
      ...c,
      parentName: c.parentId ? tdb('categories').get(c.parentId)?.name || null : null,
      productCount: tdb('products').count((p) => !p.archivedAt && (p.categoryId === c.id || p.subcategoryId === c.id)),
    }),
  });

  defineResource(router, {
    base: '/brands',
    collection: 'brands',
    entity: 'brand',
    listOptions: { searchable: ['name'], sortable: ['name', 'createdAt'], defaultSort: 'name', defaultDir: 'asc' },
    beforeCreate: (b) => ({
      name: String(b.name || '').trim(),
      imageId: b.imageId || null,
      description: b.description || '',
      status: b.status || 'active',
    }),
    decorate: (b) => ({
      ...b,
      productCount: tdb('products').count((p) => !p.archivedAt && p.brandId === b.id),
    }),
  });

  /* --------------------------------------------------------------- Barcode */

  router.post('/barcode/generate', ({ body }) => {
    const count = Math.min(Math.max(1, Number(body?.count) || 1), 500);
    const taken = new Set();
    const codes = Array.from({ length: count }, () => uniqueBarcode(taken));
    return ok({ codes });
  });

  router.post('/barcode/assign', ({ body }) => {
    const { productId, variantId = null, barcode } = body || {};
    const product = tdb('products').get(productId);
    if (!product) notFound('Product');
    const clash = tdb('products').all().find((p) =>
      (p.id !== productId && p.barcode === barcode) ||
      p.variants?.some((v) => v.barcode === barcode && !(p.id === productId && v.id === variantId)),
    );
    if (clash) conflict(`Barcode already used by "${clash.name}"`);
    return db.tx(() => {
      if (variantId) {
        const variants = product.variants.map((v) => (v.id === variantId ? { ...v, barcode } : v));
        tdb('products').update(productId, { variants });
      } else {
        tdb('products').update(productId, { barcode });
      }
      audit('update', 'product', productId, { meta: { field: 'barcode', barcode } });
      return ok({ ok: true });
    });
  });
}
