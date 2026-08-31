<?php
declare(strict_types=1);

namespace Afia\Data;

/** Permission catalogue + role presets. Ported verbatim from js/data/permissions.js. */
final class Roles
{
    public const SUPER = '*';

    public const ALL_PERMISSIONS = [
        'dashboard.view',
        'pos.operate', 'sales.create', 'sales.hold', 'sales.discount.item', 'sales.discount.cart',
        'sales.discount.override', 'sales.price.override', 'sales.cancel', 'sales.refund', 'sales.view',
        'products.view', 'products.create', 'products.edit', 'products.archive', 'products.import',
        'categories.manage', 'brands.manage', 'barcode.manage',
        'inventory.view', 'inventory.adjust', 'inventory.transfer', 'inventory.valuation',
        'purchases.view', 'purchases.create', 'purchases.receive', 'purchases.edit', 'purchases.return', 'suppliers.manage',
        'customers.view', 'customers.create', 'customers.edit', 'customers.balance',
        'expenses.view', 'expenses.manage', 'register.operate', 'register.view', 'taxes.manage', 'discounts.manage',
        'reports.view', 'reports.export', 'reports.financial',
        'employees.view', 'employees.manage', 'roles.manage', 'branches.manage', 'settings.manage',
        'audit.view', 'backup.manage', 'notifications.view',
    ];

    /** @return list<array<string,mixed>> */
    public static function presets(): array
    {
        $all = self::ALL_PERMISSIONS;
        return [
            ['id' => 'role_super_admin', 'name' => 'Super Admin', 'system' => true, 'description' => 'Full unrestricted access across all businesses and branches.', 'permissions' => [self::SUPER], 'discountLimitPct' => 100],
            ['id' => 'role_owner', 'name' => 'Branch Owner', 'system' => true, 'description' => 'Owns the business. Full access to every module and setting.', 'permissions' => [self::SUPER], 'discountLimitPct' => 100],
            ['id' => 'role_admin', 'name' => 'Admin', 'system' => true, 'description' => 'Manages day-to-day operations, catalog, staff and reports.', 'permissions' => array_values(array_filter($all, static fn ($p) => !in_array($p, ['backup.manage', 'roles.manage'], true))), 'discountLimitPct' => 50],
            ['id' => 'role_manager', 'name' => 'Manager', 'system' => true, 'description' => 'Runs a branch: POS, inventory, purchasing, staff supervision.', 'permissions' => [
                'dashboard.view', 'pos.operate', 'sales.create', 'sales.hold', 'sales.discount.item', 'sales.discount.cart',
                'sales.cancel', 'sales.refund', 'sales.view', 'products.view', 'products.create', 'products.edit',
                'categories.manage', 'brands.manage', 'barcode.manage', 'inventory.view', 'inventory.adjust', 'inventory.transfer',
                'inventory.valuation', 'purchases.view', 'purchases.create', 'purchases.receive', 'purchases.edit', 'purchases.return',
                'suppliers.manage', 'customers.view', 'customers.create', 'customers.edit', 'expenses.view', 'expenses.manage',
                'register.operate', 'register.view', 'reports.view', 'reports.export', 'reports.financial', 'employees.view', 'notifications.view',
            ], 'discountLimitPct' => 30],
            ['id' => 'role_cashier', 'name' => 'Cashier', 'system' => true, 'description' => 'Operates the POS terminal for checkout and basic customer lookup.', 'permissions' => [
                'pos.operate', 'sales.create', 'sales.hold', 'sales.discount.item', 'sales.view', 'sales.refund',
                'products.view', 'inventory.view', 'customers.view', 'customers.create', 'register.operate', 'notifications.view',
            ], 'discountLimitPct' => 10],
            ['id' => 'role_inventory', 'name' => 'Inventory Manager', 'system' => true, 'description' => 'Owns stock accuracy: adjustments, transfers, purchasing, receiving.', 'permissions' => [
                'dashboard.view', 'products.view', 'products.create', 'products.edit', 'products.archive', 'products.import',
                'categories.manage', 'brands.manage', 'barcode.manage', 'inventory.view', 'inventory.adjust', 'inventory.transfer',
                'inventory.valuation', 'purchases.view', 'purchases.create', 'purchases.receive', 'purchases.edit', 'purchases.return',
                'suppliers.manage', 'reports.view', 'reports.export', 'notifications.view',
            ], 'discountLimitPct' => 0],
            ['id' => 'role_accountant', 'name' => 'Accountant', 'system' => true, 'description' => 'Read access to finance data plus expenses and register reconciliation.', 'permissions' => [
                'dashboard.view', 'sales.view', 'purchases.view', 'expenses.view', 'expenses.manage', 'register.view',
                'reports.view', 'reports.export', 'reports.financial', 'taxes.manage', 'discounts.manage', 'customers.view',
                'suppliers.manage', 'audit.view', 'notifications.view',
            ], 'discountLimitPct' => 0],
        ];
    }

    public static function defaultSettings(string $businessName): array
    {
        return [
            'id' => 'settings_singleton',
            'business' => [
                'name' => $businessName, 'legalName' => '', 'logoId' => null, 'address' => '', 'phone' => '', 'email' => '',
                'website' => '', 'vatNo' => '', 'currency' => 'BDT', 'currencySymbol' => '৳', 'invoicePrefix' => 'INV',
            ],
            'pos' => [
                'invoiceTemplate' => 'INV-{BR}-{SEQ}', 'receiptSize' => '80', 'printAfterSale' => true,
                'autoFocusBarcode' => true, 'holdSaleLimit' => 20, 'requireOpenRegister' => false,
                'defaultTaxId' => null, 'defaultCustomerId' => null, 'loyaltyPerCurrency' => 0.01,
                'quickCash' => [50, 100, 200, 500, 1000], 'allowPriceOverride' => true, 'roundTotalsTo' => 0, 'showProductImages' => true,
            ],
            'inventory' => ['allowNegativeStock' => false, 'lowStockThreshold' => 5, 'valuationMethod' => 'moving_average', 'autoReorderAlerts' => true],
            'receipt' => ['header' => $businessName, 'footer' => 'Thank you for shopping with us!', 'showLogo' => true, 'showCashier' => true, 'showBarcode' => true, 'showTaxBreakdown' => true],
            'notifications' => ['lowStock' => true, 'newSale' => false, 'refund' => true, 'registerClose' => true, 'purchaseReceived' => true],
            'security' => ['sessionIdleTimeoutMin' => 30, 'requirePinForRefund' => false, 'requirePinForDiscount' => false],
            'printing' => ['paperSize' => '80', 'marginMm' => 4, 'copies' => 1],
        ];
    }
}
