/**
 * permissions.js - the permission catalog and role presets.
 *
 * Permissions are granular strings ('products.create'). Roles map to a set of
 * permissions. A user carries a roleId plus optional per-user permission
 * overrides (grant / revoke). rbac.js resolves the effective set.
 */

export const PERMISSION_GROUPS = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    permissions: [['dashboard.view', 'View dashboard & analytics']],
  },
  {
    key: 'pos',
    label: 'Point of Sale',
    permissions: [
      ['pos.operate', 'Open the POS terminal & sell'],
      ['sales.create', 'Complete sales'],
      ['sales.hold', 'Hold / resume sales'],
      ['sales.discount.item', 'Apply item-level discounts'],
      ['sales.discount.cart', 'Apply cart-level discounts'],
      ['sales.discount.override', 'Exceed the role discount limit'],
      ['sales.price.override', 'Override selling price at checkout'],
      ['sales.cancel', 'Cancel / void an in-progress sale'],
      ['sales.refund', 'Process sales returns & refunds'],
      ['sales.view', 'View sales history'],
    ],
  },
  {
    key: 'catalog',
    label: 'Catalog',
    permissions: [
      ['products.view', 'View products'],
      ['products.create', 'Create products'],
      ['products.edit', 'Edit products'],
      ['products.archive', 'Archive / restore products'],
      ['products.import', 'Bulk import / export products'],
      ['categories.manage', 'Manage categories & subcategories'],
      ['brands.manage', 'Manage brands'],
      ['barcode.manage', 'Generate & print barcodes'],
    ],
  },
  {
    key: 'inventory',
    label: 'Inventory',
    permissions: [
      ['inventory.view', 'View stock levels & movements'],
      ['inventory.adjust', 'Create stock adjustments'],
      ['inventory.transfer', 'Transfer stock between branches'],
      ['inventory.valuation', 'View inventory valuation'],
    ],
  },
  {
    key: 'purchasing',
    label: 'Purchasing',
    permissions: [
      ['purchases.view', 'View purchases'],
      ['purchases.create', 'Create purchase orders'],
      ['purchases.receive', 'Receive stock against purchases'],
      ['purchases.edit', 'Edit / cancel purchases'],
      ['purchases.return', 'Create purchase returns'],
      ['suppliers.manage', 'Manage suppliers'],
    ],
  },
  {
    key: 'crm',
    label: 'Customers',
    permissions: [
      ['customers.view', 'View customers'],
      ['customers.create', 'Create customers'],
      ['customers.edit', 'Edit customers'],
      ['customers.balance', 'Adjust customer outstanding balance'],
    ],
  },
  {
    key: 'finance',
    label: 'Finance',
    permissions: [
      ['expenses.view', 'View expenses'],
      ['expenses.manage', 'Create & edit expenses'],
      ['register.operate', 'Open / close cash register'],
      ['register.view', 'View register sessions'],
      ['taxes.manage', 'Configure taxes / VAT'],
      ['discounts.manage', 'Configure discounts & coupons'],
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    permissions: [
      ['reports.view', 'View reports'],
      ['reports.export', 'Export reports'],
      ['reports.financial', 'View profit & financial reports'],
    ],
  },
  {
    key: 'org',
    label: 'Organisation',
    permissions: [
      ['employees.view', 'View employees'],
      ['employees.manage', 'Create & edit employees'],
      ['roles.manage', 'Manage roles & permissions'],
      ['branches.manage', 'Manage branches'],
      ['settings.manage', 'Manage business settings'],
      ['audit.view', 'View audit logs'],
      ['backup.manage', 'Backup, restore & reset data'],
      ['notifications.view', 'View notifications'],
    ],
  },
];

/** Flat list of every permission string. */
export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.permissions.map(([p]) => p));

export const PERMISSION_LABELS = Object.fromEntries(
  PERMISSION_GROUPS.flatMap((g) => g.permissions.map(([p, label]) => [p, label])),
);

/** Wildcard super permission - rbac.can() treats '*' as "everything". */
export const SUPER = '*';

export const ROLE_PRESETS = [
  {
    id: 'role_super_admin',
    name: 'Super Admin',
    system: true,
    description: 'Full unrestricted access across all businesses and branches.',
    permissions: [SUPER],
    discountLimitPct: 100,
  },
  {
    id: 'role_owner',
    name: 'Branch Owner',
    system: true,
    description: 'Owns the business. Full access to every module and setting.',
    permissions: [SUPER],
    discountLimitPct: 100,
  },
  {
    id: 'role_admin',
    name: 'Admin',
    system: true,
    description: 'Manages day-to-day operations, catalog, staff and reports.',
    permissions: ALL_PERMISSIONS.filter(
      (p) => !['backup.manage', 'roles.manage'].includes(p),
    ),
    discountLimitPct: 50,
  },
  {
    id: 'role_manager',
    name: 'Manager',
    system: true,
    description: 'Runs a branch: POS, inventory, purchasing, staff supervision.',
    permissions: [
      'dashboard.view', 'pos.operate', 'sales.create', 'sales.hold', 'sales.discount.item',
      'sales.discount.cart', 'sales.cancel', 'sales.refund', 'sales.view', 'products.view',
      'products.create', 'products.edit', 'categories.manage', 'brands.manage', 'barcode.manage',
      'inventory.view', 'inventory.adjust', 'inventory.transfer', 'inventory.valuation',
      'purchases.view', 'purchases.create', 'purchases.receive', 'purchases.edit', 'purchases.return',
      'suppliers.manage', 'customers.view', 'customers.create', 'customers.edit', 'expenses.view',
      'expenses.manage', 'register.operate', 'register.view', 'reports.view', 'reports.export',
      'reports.financial', 'employees.view', 'notifications.view',
    ],
    discountLimitPct: 30,
  },
  {
    id: 'role_cashier',
    name: 'Cashier',
    system: true,
    description: 'Operates the POS terminal for checkout and basic customer lookup.',
    permissions: [
      'pos.operate', 'sales.create', 'sales.hold', 'sales.discount.item', 'sales.view',
      'sales.refund', 'products.view', 'inventory.view', 'customers.view', 'customers.create',
      'register.operate', 'notifications.view',
    ],
    discountLimitPct: 10,
  },
  {
    id: 'role_inventory',
    name: 'Inventory Manager',
    system: true,
    description: 'Owns stock accuracy: adjustments, transfers, purchasing, receiving.',
    permissions: [
      'dashboard.view', 'products.view', 'products.create', 'products.edit', 'products.archive',
      'products.import', 'categories.manage', 'brands.manage', 'barcode.manage', 'inventory.view',
      'inventory.adjust', 'inventory.transfer', 'inventory.valuation', 'purchases.view',
      'purchases.create', 'purchases.receive', 'purchases.edit', 'purchases.return',
      'suppliers.manage', 'reports.view', 'reports.export', 'notifications.view',
    ],
    discountLimitPct: 0,
  },
  {
    id: 'role_accountant',
    name: 'Accountant',
    system: true,
    description: 'Read access to finance data plus expenses and register reconciliation.',
    permissions: [
      'dashboard.view', 'sales.view', 'purchases.view', 'expenses.view', 'expenses.manage',
      'register.view', 'reports.view', 'reports.export', 'reports.financial', 'taxes.manage',
      'discounts.manage', 'customers.view', 'suppliers.manage', 'audit.view', 'notifications.view',
    ],
    discountLimitPct: 0,
  },
];

export function presetById(id) {
  return ROLE_PRESETS.find((r) => r.id === id) || null;
}
