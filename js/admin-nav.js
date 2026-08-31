/**
 * admin-nav.js - sidebar navigation model. Each item declares the permission
 * required to see AND reach it (router guard enforces the same string).
 */
export const NAV_GROUPS = [
  {
    label: null,
    items: [
      { path: '/', label: 'Dashboard', icon: 'dashboard', permission: 'dashboard.view' },
      { path: '/pos', label: 'POS / Sales', icon: 'pos', permission: 'pos.operate', external: 'cashier.html' },
    ],
  },
  {
    label: 'Catalog',
    items: [
      { path: '/products', label: 'Products', icon: 'box', permission: 'products.view' },
      { path: '/categories', label: 'Categories', icon: 'layers', permission: 'products.view' },
      { path: '/brands', label: 'Brands', icon: 'tag', permission: 'products.view' },
      { path: '/barcodes', label: 'Barcode Generator', icon: 'barcode', permission: 'barcode.manage' },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { path: '/inventory', label: 'Inventory', icon: 'warehouse', permission: 'inventory.view' },
      { path: '/stock-adjustments', label: 'Stock Adjustments', icon: 'sliders', permission: 'inventory.adjust' },
      { path: '/stock-transfers', label: 'Stock Transfers', icon: 'truck', permission: 'inventory.transfer' },
    ],
  },
  {
    label: 'Purchasing',
    items: [
      { path: '/purchases', label: 'Purchases', icon: 'truck', permission: 'purchases.view' },
      { path: '/purchase-returns', label: 'Purchase Returns', icon: 'rotate-ccw', permission: 'purchases.return' },
      { path: '/suppliers', label: 'Suppliers', icon: 'building', permission: 'purchases.view' },
    ],
  },
  {
    label: 'Sales',
    items: [
      { path: '/sales', label: 'Sales', icon: 'receipt', permission: 'sales.view' },
      { path: '/sales-returns', label: 'Exchange / Return', icon: 'undo', permission: 'sales.view' },
      { path: '/invoices', label: 'Invoice Management', icon: 'file', permission: 'sales.view' },
    ],
  },
  {
    label: 'People',
    items: [
      { path: '/customers', label: 'Customers', icon: 'users', permission: 'customers.view' },
      { path: '/employees', label: 'Employees', icon: 'user', permission: 'employees.view' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { path: '/expenses', label: 'Expenses', icon: 'wallet', permission: 'expenses.view' },
      { path: '/cash-register', label: 'Cash Register', icon: 'drawer', permission: 'register.view' },
      { path: '/discounts', label: 'Discounts & Coupons', icon: 'tag', permission: 'discounts.manage' },
      { path: '/taxes', label: 'Discount & VAT', icon: 'percent', permission: 'taxes.manage' },
    ],
  },
  {
    label: 'Insights',
    items: [
      { path: '/reports', label: 'Reports', icon: 'chart', permission: 'reports.view' },
      { path: '/audit-logs', label: 'Audit Logs', icon: 'history', permission: 'audit.view' },
      { path: '/notifications', label: 'Notifications', icon: 'bell', permission: 'notifications.view' },
    ],
  },
  {
    label: 'Organisation',
    items: [
      { path: '/branches', label: 'Branches', icon: 'building', permission: 'branches.manage' },
      { path: '/billing', label: 'Subscription & Billing', icon: 'credit-card', permission: 'settings.manage' },
      { path: '/settings', label: 'Settings', icon: 'settings', permission: 'settings.manage' },
      { path: '/backup', label: 'Backup / Data', icon: 'database', permission: 'backup.manage' },
      { path: '/help', label: 'Help / Support', icon: 'help', permission: null },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);
