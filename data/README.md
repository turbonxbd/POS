# Data shapes

In `mock` mode the whole dataset lives in `localStorage` under
`afia_pos_db_v3` as one JSON tree:

```jsonc
{
  "__v": 1,
  "meta": {
    "sequences": { "invoice:<branchId>": 42, "purchase": 9, "expense": 12, ... },
    "seededAt": "2026-08-27T…",
    "demo": true
  },
  "collections": {
    "businesses": [ { "id", "name", "address", "phone", "vatNo", "currency", … } ],
    "branches":   [ { "id", "name", "code", "address", "isDefault", "status" } ],
    "roles":      [ { "id", "name", "permissions": ["*"|"products.view",…], "discountLimitPct", "system" } ],
    "users":      [ { "id", "name", "email", "passwordHash", "roleId", "status",
                      "permissionGrants": [], "permissionRevokes": [], "lastLoginAt" } ],
    "employees":  [ { "id", "userId", "branchIds": [], "joinDate" } ],

    "categories": [ { "id", "name", "parentId", "order", "status" } ],
    "brands":     [ { "id", "name", "status" } ],
    "taxes":      [ { "id", "name", "rate", "inclusive", "scope", "isDefault" } ],
    "discounts":  [ { "id", "name", "code", "type", "value", "scope", "minSpend",
                      "maxDiscount", "usageLimit", "usageCount", "status" } ],

    "products": [ {
      "id", "name", "sku", "barcode", "description", "imageId",
      "categoryId", "subcategoryId", "brandId", "supplierId", "unit",
      "costPrice", "sellingPrice", "wholesalePrice", "discountPrice", "taxId",
      "minStock", "maxStock", "trackInventory", "status", "archivedAt?",
      "hasVariants", "variants": [ { "id", "name", "options", "sku", "barcode",
                                    "costPrice", "sellingPrice", "minStock" } ]
    } ],

    // Inventory: the ledger is the source of truth; `stock` is a cached balance.
    "stock": [ { "id": "stk_<branch>_<product>_<variant|base>", "branchId",
                 "productId", "variantId", "quantity", "reserved", "avgCost",
                 "lastMovementAt" } ],
    "inventory_transactions": [ {
      "id", "branchId", "productId", "variantId",
      "type": "opening|purchase|sale|sale_return|purchase_return|adjustment|damage|lost|transfer_in|transfer_out",
      "qtyDelta", "balanceAfter", "unitCost", "refType", "refId", "userId", "at"
    } ],
    "stock_adjustments": [ { "id", "reference", "branchId", "type", "reason",
                             "lines": [ { "productId", "deltaQty", "note" } ], "netUnits", "at" } ],
    "stock_transfers":   [ { "id", "reference", "fromBranchId", "toBranchId", "lines", "at" } ],

    // Sales — immutable once created.
    "sales": [ {
      "id", "invoiceNo", "idempotencyKey", "branchId", "cashierId", "customerId",
      "status": "completed|due|partially_refunded|refunded",
      "subtotal", "discountTotal", "taxTotal", "taxLines", "grandTotal",
      "totalCost", "estimatedProfit", "paidTotal", "changeTotal", "dueTotal",
      "paymentSummary", "createdAt"
    } ],
    "sale_items": [ { "id", "saleId", "productId", "variantId", "name", "sku",
                      "unitPrice", "costPrice", "qty", "discountTotal",
                      "taxId", "taxRate", "taxAmount", "lineTotal", "returnedQty" } ],
    "payments": [ { "id", "saleId", "saleReturnId?", "branchId", "direction": "in|out",
                    "method": "cash|card|mobile|bank_transfer", "amount",
                    "reference?", "cardLast4?", "at" } ],
    "held_sales": [ { "id", "label", "branchId", "cashierId", "items", "createdAt" } ],
    "sale_returns": [ { "id", "reference", "saleId", "invoiceNo", "reason",
                        "items", "refundGoods", "refundTax", "refundTotal", "refundMethod", "at" } ],

    // Purchasing
    "suppliers": [ { "id", "name", "phone", "email", "openingBalance", "currentBalance", "status" } ],
    "purchases": [ { "id", "reference", "branchId", "supplierId", "lines",
                     "subtotal", "taxTotal", "grandTotal", "paidTotal", "dueTotal",
                     "status": "draft|ordered|partially_received|received|cancelled", "createdAt" } ],
    "purchase_returns": [ { "id", "reference", "purchaseId", "supplierId", "items", "returnTotal", "at" } ],
    "supplier_payments": [ { "id", "reference", "supplierId", "amount", "method", "at" } ],

    // People & CRM
    "customers": [ { "id", "name", "phone", "email", "address", "openingBalance",
                     "outstandingBalance", "totalOrders", "totalPurchases",
                     "loyaltyPoints", "lastPurchaseAt", "status" } ],
    "customer_ledger": [ { "id", "customerId", "type", "amount", "balanceDelta", "at" } ],

    // Finance
    "expenses": [ { "id", "reference", "category", "description", "amount",
                    "paymentMethod", "branchId", "employeeId", "at" } ],
    "register_sessions": [ { "id", "reference", "branchId", "cashierId",
                             "openingCash", "status": "open|closed", "openedAt",
                             "closedAt?", "closingCountedCash?", "closingExpectedCash?", "difference?" } ],
    "register_movements": [ { "id", "sessionId", "direction": "in|out", "amount", "reason", "at" } ],

    // System
    "notifications": [ { "id", "type", "title", "message", "level", "read", "link", "at" } ],
    "audit_logs":    [ { "id", "action", "entity", "entityId", "actorId", "actorName",
                         "before", "after", "meta", "at" } ],
    "settings":      [ { "id": "settings_singleton", "business", "pos", "inventory",
                         "receipt", "notifications", "security", "printing" } ],
    "subscriptions": [ { "id", "planId", "planName", "price", "status", "renewsAt" } ]
  }
}
```

Product / logo images are stored separately under `afia_pos_media_v1`
(`{ imageId: dataURL }`) so the main tree stays small and fast to parse.

The offline sales queue is under `afia_pos_sync_queue_v1`; the session token
reference is under `afia_pos_session_v1`; UI preferences under `afia_pos_prefs_v1`.
