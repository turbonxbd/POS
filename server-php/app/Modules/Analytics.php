<?php
declare(strict_types=1);

namespace Afia\Modules;

use Afia\App;
use Afia\Context;
use Afia\Domain\Reports;
use Afia\Http\Response;
use Afia\Http\Router;
use Afia\Support\Branch;
use Afia\Support\HttpError;
use Afia\Support\Money;
use Afia\Support\Range;

/** Dashboard aggregates + the reports engine. Ported from analytics.routes.js. */
final class Analytics
{
    public static function register(Router $r, App $app): void
    {
        $r->get('/dashboard', fn (Context $c) => self::dashboard($c));
        $r->get('/reports/:type', fn (Context $c, $p) => self::report($c, $p));
    }

    private static function scope(Context $ctx): array
    {
        $q = $ctx->request->query;
        // branchId 'all' means "every branch" - a null branchId is treated as no filter downstream.
        $branchId = ($q['branchId'] ?? null) === 'all' ? null : Branch::resolveId($ctx, $q['branchId'] ?? null);
        $range = (!empty($q['from']) || !empty($q['to']))
            ? Range::resolve(null, $q['from'] ?? null, $q['to'] ?? null)
            : Range::resolve($q['preset'] ?? 'this_month');
        return ['branchId' => $branchId, 'range' => $range, 'from' => $range['from'], 'to' => $range['to']];
    }

    /* ---------------------------------------------------------- dashboard */

    private static function dashboard(Context $ctx): Response
    {
        $ctx->requirePermission('dashboard.view');
        $s = self::scope($ctx);
        $k = Reports::periodKpis($ctx, $s);
        $sales = Reports::sales($ctx, $s);
        $items = Reports::itemsBySale($ctx, $sales);

        // low / out of stock (current)
        $low = 0;
        $out = 0;
        foreach ($ctx->repo()->allDocs('products', "archived_at IS NULL AND track_inventory = 1") as $p) {
            $targets = !empty($p['variants'])
                ? array_map(static fn ($v) => ['id' => $v['id'], 'min' => $v['minStock'] ?? $p['minStock']], $p['variants'])
                : [['id' => 'base', 'min' => $p['minStock'] ?? 0]];
            foreach ($targets as $tg) {
                $row = $ctx->repo()->doc('stock', 'stk_' . ($s['branchId'] ?? '') . '_' . $p['id'] . '_' . $tg['id']);
                $qty = (int) ($row['quantity'] ?? 0);
                if ($qty <= 0) {
                    $out++;
                } elseif (($tg['min'] ?? 0) > 0 && $qty <= $tg['min']) {
                    $low++;
                }
            }
        }

        $cashInRegister = 0;
        foreach ($ctx->repo()->allDocs('register_sessions', "status = 'open'" . ($s['branchId'] ? ' AND branch_id = :b' : ''), $s['branchId'] ? [':b' => $s['branchId']] : []) as $rs) {
            $cashInRegister += $rs['totalsSnapshot']['expectedCash'] ?? $rs['openingCash'] ?? 0;
        }

        $days = (strtotime($s['to']) - strtotime($s['from'])) / 86400;
        $granularity = $days > 120 ? 'month' : 'day';
        $series = Reports::salesSeries($sales, $granularity);

        $catMap = $prodMap = $cashierMap = $custMap = [];
        foreach ($sales as $sale) {
            $cid = $sale['cashierId'] ?? 'u';
            $cashierMap[$cid] = ['id' => $sale['cashierId'] ?? null, 'label' => $sale['cashierName'] ?? '-',
                'value' => ($cashierMap[$cid]['value'] ?? 0) + $sale['grandTotal'], 'orders' => ($cashierMap[$cid]['orders'] ?? 0) + 1];
            if (!empty($sale['customerId'])) {
                $cu = $custMap[$sale['customerId']] ?? ['id' => $sale['customerId'], 'label' => $sale['customerName'], 'value' => 0, 'orders' => 0];
                $cu['value'] += $sale['grandTotal'];
                $cu['orders']++;
                $custMap[$sale['customerId']] = $cu;
            }
            foreach ($items[$sale['id']] ?? [] as $it) {
                $product = $ctx->repo()->doc('products', $it['productId']);
                $catName = $product && !empty($product['categoryId']) ? ($ctx->repo()->doc('categories', $product['categoryId'])['name'] ?? 'Other') : 'Other';
                $catMap[$catName] = ($catMap[$catName] ?? 0) + ($it['lineTotal'] - $it['taxAmount']);
                $pa = $prodMap[$it['productId']] ?? ['id' => $it['productId'], 'name' => $it['name'], 'qty' => 0, 'revenue' => 0, 'profit' => 0];
                $pa['qty'] += $it['qty'];
                $pa['revenue'] += $it['lineTotal'] - $it['taxAmount'];
                $pa['profit'] += $it['lineTotal'] - $it['taxAmount'] - Money::mul((int) $it['costPrice'], (int) $it['qty']);
                $prodMap[$it['productId']] = $pa;
            }
        }

        $topProducts = array_values($prodMap);
        usort($topProducts, static fn ($a, $b) => $b['revenue'] <=> $a['revenue']);
        $topCustomers = array_values($custMap);
        usort($topCustomers, static fn ($a, $b) => $b['value'] <=> $a['value']);
        $topCashiers = array_values($cashierMap);
        usort($topCashiers, static fn ($a, $b) => $b['value'] <=> $a['value']);
        $salesByCategory = [];
        foreach ($catMap as $label => $value) {
            $salesByCategory[] = ['label' => $label, 'value' => $value];
        }
        usort($salesByCategory, static fn ($a, $b) => $b['value'] <=> $a['value']);

        return Response::json([
            'range' => $s['range'], 'granularity' => $granularity,
            'preset' => (!empty($ctx->request->query['from']) || !empty($ctx->request->query['to'])) ? 'custom' : ($ctx->request->query['preset'] ?? 'this_month'),
            'kpis' => array_merge($k, [
                'totalProducts' => $ctx->repo()->count('products', 'archived_at IS NULL'),
                'lowStockProducts' => $low, 'outOfStockProducts' => $out,
                'totalCustomers' => $ctx->repo()->count('customers', 'archived_at IS NULL'),
                'totalSuppliers' => $ctx->repo()->count('suppliers', 'archived_at IS NULL'),
                'pendingPurchases' => $ctx->repo()->count('purchases', "status IN ('ordered','partially_received','draft')"),
                'cashInRegister' => $cashInRegister,
            ]),
            'salesSeries' => array_map(static fn ($d) => [
                'label' => $granularity === 'month' ? $d['date'] : substr($d['date'], 5),
                'date' => $d['date'], 'revenue' => $d['revenue'], 'profit' => $d['profit'], 'orders' => $d['orders'],
            ], $series),
            'salesByCategory' => $salesByCategory,
            'topProducts' => array_slice($topProducts, 0, 8),
            'topCustomers' => array_slice($topCustomers, 0, 8),
            'topCashiers' => $topCashiers,
            'paymentGroups' => $k['paymentGroups'],
            'paymentMix' => array_map(static fn ($g) => ['label' => $g['label'], 'key' => $g['key'], 'value' => $g['inflow'], 'count' => $g['count']], $k['paymentGroups']),
        ]);
    }

    /* ------------------------------------------------------------ reports */

    private static function report(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('reports.view');
        $s = self::scope($ctx);
        $q = $ctx->request->query;
        $sales = Reports::sales($ctx, $s);
        $type = $p['type'];

        switch ($type) {
            case 'sales':
                $rows = Reports::saleRows($sales);
                if (!empty($q['status']) && $q['status'] !== 'all') {
                    $rows = array_values(array_filter($rows, static fn ($r) => $r['status'] === $q['status']));
                }
                if (!empty($q['customerId'])) {
                    $rows = array_values(array_filter($rows, static fn ($r) => $r['customerId'] === $q['customerId']));
                }
                return Response::json(['range' => $s['range'], 'rows' => $rows, 'totals' => Reports::aggregate($rows, ['items', 'subtotal', 'discount', 'tax', 'total', 'paid', 'due', 'profit'])]);

            case 'products-sold':
            case 'product-performance':
                $rows = Reports::productsSoldRows($ctx, $sales);
                $sort = $q['sort'] ?? null;
                if ($sort === 'qtySold') {
                    usort($rows, static fn ($a, $b) => $b['qtySold'] <=> $a['qtySold']);
                } elseif ($sort === 'profit') {
                    usort($rows, static fn ($a, $b) => $b['profit'] <=> $a['profit']);
                } elseif ($sort === 'least') {
                    usort($rows, static fn ($a, $b) => $a['qtySold'] <=> $b['qtySold']);
                }
                return Response::json(['range' => $s['range'], 'rows' => $rows, 'totals' => Reports::aggregate($rows, ['qtySold', 'revenue', 'discount', 'cost', 'profit', 'transactions'])]);

            case 'inventory':
            case 'inventory-valuation':
                $rows = Reports::inventoryValuationRows($ctx, $s['branchId']);
                return Response::json(['rows' => $rows, 'totals' => Reports::aggregate($rows, ['quantity', 'stockValue', 'potentialSales', 'potentialProfit'])]);

            case 'loyalty':
                $rows = Reports::loyaltyRows($ctx);
                return Response::json(['rows' => $rows, 'totals' => Reports::aggregate($rows, ['earned', 'redeemed', 'redeemValue', 'balance'])]);

            case 'dead-stock':
                $days = max(1, (int) ($q['days'] ?? 90));
                $rows = Reports::deadStockRows($ctx, $s['branchId'], $days);
                if (!empty($q['stockStatus']) && $q['stockStatus'] !== 'all') {
                    $rows = array_values(array_filter($rows, static fn ($r) => $r['status'] === $q['stockStatus']));
                }
                $totals = Reports::aggregate($rows, ['quantity', 'stockValue', 'soldLast30', 'soldLast90']);
                $totals['deadValue'] = array_sum(array_map(static fn ($r) => $r['status'] === 'dead' ? $r['stockValue'] : 0, $rows));
                $totals['deadCount'] = count(array_filter($rows, static fn ($r) => $r['status'] === 'dead'));
                $totals['slowCount'] = count(array_filter($rows, static fn ($r) => $r['status'] === 'slow'));
                return Response::json(['range' => $s['range'], 'rows' => $rows, 'totals' => $totals, 'days' => $days]);

            case 'expenses':
                $rows = Reports::expenseRows(Reports::expenses($ctx, $s));
                if (!empty($q['category']) && $q['category'] !== 'all') {
                    $rows = array_values(array_filter($rows, static fn ($r) => $r['category'] === $q['category']));
                }
                return Response::json(['range' => $s['range'], 'rows' => $rows, 'totals' => Reports::aggregate($rows, ['amount'])]);

            case 'returns':
                $rows = Reports::returnRows(Reports::returns($ctx, $s));
                return Response::json(['range' => $s['range'], 'rows' => $rows, 'totals' => Reports::aggregate($rows, ['qty', 'amount'])]);

            case 'purchases':
                $rows = Reports::purchaseRows($ctx, Reports::purchases($ctx, $s));
                if (!empty($q['status']) && $q['status'] !== 'all') {
                    $rows = array_values(array_filter($rows, static fn ($r) => $r['status'] === $q['status']));
                }
                return Response::json(['range' => $s['range'], 'rows' => $rows, 'totals' => Reports::aggregate($rows, ['items', 'subtotal', 'tax', 'total', 'paid', 'due'])]);

            case 'receivables':
                $rows = Reports::receivableRows($ctx);
                if (!empty($q['status']) && $q['status'] !== 'all') {
                    $rows = array_values(array_filter($rows, static fn ($r) => $r['status'] === $q['status']));
                }
                return Response::json(['rows' => $rows, 'totals' => Reports::aggregate($rows, ['total', 'paid', 'due'])]);

            case 'payments':
                $bd = Reports::paymentBreakdown(Reports::payments($ctx, $s));
                $rows = array_map(static fn ($g) => ['method' => $g['label'], 'inflow' => $g['inflow'], 'refund' => $g['refund'], 'net' => $g['net'], 'count' => $g['count']], $bd['groups']);
                return Response::json(['range' => $s['range'], 'rows' => $rows, 'totals' => Reports::aggregate($rows, ['inflow', 'refund', 'net', 'count'])]);

            case 'profit':
                return Response::json(self::reportProfit($sales, $s['range']));

            case 'tax':
                return Response::json(self::reportTax($sales));

            case 'cashier':
                return Response::json(self::reportCashier($ctx, $sales, $s));

            case 'customers':
                return Response::json(self::reportCustomers($ctx));

            case 'suppliers':
                return Response::json(self::reportSuppliers($ctx));

            case 'category-performance':
                return Response::json(self::reportCategoryPerformance($ctx, $sales));

            case 'daily-closing':
                return Response::json(self::reportDailyClosing($ctx, $s));

            default:
                throw HttpError::badRequest("Unknown report \"{$type}\"");
        }
    }

    private static function reportProfit(array $sales, array $range): array
    {
        $byDay = [];
        foreach ($sales as $s) {
            $key = substr($s['createdAt'], 0, 10);
            $acc = $byDay[$key] ?? ['date' => $key, 'revenue' => 0, 'cost' => 0, 'tax' => 0, 'profit' => 0, 'orders' => 0];
            $acc['revenue'] += $s['grandTotal'] - $s['taxTotal'];
            $acc['cost'] += $s['totalCost'];
            $acc['tax'] += $s['taxTotal'];
            $acc['profit'] += $s['estimatedProfit'];
            $acc['orders']++;
            $byDay[$key] = $acc;
        }
        ksort($byDay);
        $rows = array_map(static fn ($r) => $r + ['margin' => $r['revenue'] ? round($r['profit'] / $r['revenue'] * 100, 1) : 0], array_values($byDay));
        return ['range' => $range, 'rows' => $rows, 'totals' => Reports::aggregate($rows, ['revenue', 'cost', 'tax', 'profit', 'orders'])];
    }

    private static function reportTax(array $sales): array
    {
        $map = [];
        foreach ($sales as $s) {
            foreach ($s['taxLines'] ?? [] as $t) {
                $acc = $map[$t['taxId']] ?? ['name' => $t['name'], 'rate' => $t['rate'], 'base' => 0, 'amount' => 0];
                $acc['base'] += $t['base'];
                $acc['amount'] += $t['amount'];
                $map[$t['taxId']] = $acc;
            }
        }
        $rows = array_values($map);
        return ['rows' => $rows, 'totals' => Reports::aggregate($rows, ['base', 'amount'])];
    }

    private static function reportCashier(Context $ctx, array $sales, array $s): array
    {
        $map = [];
        foreach ($sales as $sale) {
            $key = $sale['cashierId'] ?? 'u';
            $acc = $map[$key] ?? ['cashierId' => $sale['cashierId'] ?? null, 'cashier' => $sale['cashierName'] ?? '-', 'orders' => 0, 'revenue' => 0, 'discount' => 0, 'refunds' => 0];
            $acc['orders']++;
            $acc['revenue'] += $sale['grandTotal'];
            $acc['discount'] += $sale['discountTotal'];
            $map[$key] = $acc;
        }
        foreach (Reports::returns($ctx, $s) as $r) {
            $key = $r['cashierId'] ?? 'u';
            if (isset($map[$key])) {
                $map[$key]['refunds'] += $r['refundTotal'] ?? 0;
            }
        }
        $rows = array_map(static fn ($r) => $r + ['avgSale' => $r['orders'] ? (int) round($r['revenue'] / $r['orders']) : 0], array_values($map));
        usort($rows, static fn ($a, $b) => $b['revenue'] <=> $a['revenue']);
        return ['rows' => $rows, 'totals' => Reports::aggregate($rows, ['orders', 'revenue', 'discount', 'refunds'])];
    }

    private static function reportCustomers(Context $ctx): array
    {
        $rows = array_map(static fn ($c) => [
            'customerId' => $c['id'], 'name' => $c['name'], 'phone' => $c['phone'] ?? null,
            'orders' => $c['totalOrders'] ?? 0, 'spent' => $c['totalPurchases'] ?? 0,
            'outstanding' => $c['outstandingBalance'] ?? 0, 'loyalty' => $c['loyaltyPoints'] ?? 0, 'lastPurchase' => $c['lastPurchaseAt'] ?? null,
        ], $ctx->repo()->allDocs('customers', 'archived_at IS NULL'));
        usort($rows, static fn ($a, $b) => $b['spent'] <=> $a['spent']);
        return ['rows' => $rows, 'totals' => Reports::aggregate($rows, ['orders', 'spent', 'outstanding', 'loyalty'])];
    }

    private static function reportSuppliers(Context $ctx): array
    {
        $rows = [];
        foreach ($ctx->repo()->allDocs('suppliers', 'archived_at IS NULL') as $sup) {
            $purchases = $ctx->repo()->allDocs('purchases', 'supplier_id = :x', [':x' => $sup['id']]);
            $rows[] = [
                'name' => $sup['name'], 'phone' => $sup['phone'] ?? null, 'purchases' => count($purchases),
                'totalValue' => array_sum(array_map(static fn ($p) => $p['grandTotal'] ?? 0, $purchases)),
                'balance' => $sup['currentBalance'] ?? 0,
            ];
        }
        usort($rows, static fn ($a, $b) => $b['totalValue'] <=> $a['totalValue']);
        return ['rows' => $rows, 'totals' => Reports::aggregate($rows, ['purchases', 'totalValue', 'balance'])];
    }

    private static function reportCategoryPerformance(Context $ctx, array $sales): array
    {
        $items = Reports::itemsBySale($ctx, $sales);
        $map = [];
        foreach ($sales as $s) {
            foreach ($items[$s['id']] ?? [] as $it) {
                $product = $ctx->repo()->doc('products', $it['productId']);
                $cat = $product && !empty($product['categoryId']) ? ($ctx->repo()->doc('categories', $product['categoryId'])['name'] ?? 'Other') : 'Other';
                $acc = $map[$cat] ?? ['category' => $cat, 'qtySold' => 0, 'revenue' => 0, 'profit' => 0];
                $acc['qtySold'] += $it['qty'];
                $acc['revenue'] += $it['lineTotal'] - $it['taxAmount'];
                $acc['profit'] += $it['lineTotal'] - $it['taxAmount'] - Money::mul((int) $it['costPrice'], (int) $it['qty']);
                $map[$cat] = $acc;
            }
        }
        $rows = array_values($map);
        usort($rows, static fn ($a, $b) => $b['revenue'] <=> $a['revenue']);
        return ['rows' => $rows, 'totals' => Reports::aggregate($rows, ['qtySold', 'revenue', 'profit'])];
    }

    private static function reportDailyClosing(Context $ctx, array $s): array
    {
        $byDay = [];
        foreach (Reports::sales($ctx, $s) as $sale) {
            $key = substr($sale['createdAt'], 0, 10);
            $acc = $byDay[$key] ?? ['date' => $key, 'orders' => 0, 'gross' => 0, 'discount' => 0, 'tax' => 0, 'net' => 0, 'cash' => 0, 'epayment' => 0, 'profit' => 0];
            $acc['orders']++;
            $acc['gross'] += $sale['subtotal'];
            $acc['discount'] += $sale['discountTotal'];
            $acc['tax'] += $sale['taxTotal'];
            $acc['net'] += $sale['grandTotal'];
            $acc['profit'] += $sale['estimatedProfit'];
            $byDay[$key] = $acc;
        }
        foreach (Reports::payments($ctx, $s) as $pmt) {
            if (($pmt['direction'] ?? '') !== 'in') {
                continue;
            }
            $key = substr($pmt['at'], 0, 10);
            if (!isset($byDay[$key])) {
                continue;
            }
            Reports::paymentKey($pmt) === 'cash' ? $byDay[$key]['cash'] += $pmt['amount'] : $byDay[$key]['epayment'] += $pmt['amount'];
        }
        krsort($byDay);
        $rows = array_values($byDay);
        return ['range' => $s['range'], 'rows' => $rows, 'totals' => Reports::aggregate($rows, ['orders', 'gross', 'discount', 'tax', 'net', 'cash', 'epayment', 'profit'])];
    }
}
