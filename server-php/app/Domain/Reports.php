<?php
declare(strict_types=1);

namespace Afia\Domain;

use Afia\Context;
use Afia\Support\Money;

/**
 * The single source of truth for every dashboard number and every report row.
 * /dashboard and /reports/:type both call these, so a card always equals the
 * report it drills into. Ported from js/core/mock/report-lib.js.
 */
final class Reports
{
    public const PAYMENT_LABELS = [
        'cash' => 'Cash', 'card' => 'Card', 'bank_transfer' => 'Bank Transfer',
        'bkash' => 'bKash', 'nagad' => 'Nagad', 'rocket' => 'Rocket', 'mobile' => 'Mobile Banking', 'other' => 'Other',
    ];

    /* ---------------------------------------------------------- selection */

    public static function sales(Context $ctx, array $s): array
    {
        $w = $s['branchId'] ? 'branch_id = :b AND created_at >= :f AND created_at <= :t' : 'created_at >= :f AND created_at <= :t';
        $p = $s['branchId'] ? [':b' => $s['branchId'], ':f' => $s['from'], ':t' => $s['to']] : [':f' => $s['from'], ':t' => $s['to']];
        return $ctx->repo()->allDocs('sales', $w, $p, 'created_at DESC');
    }

    public static function payments(Context $ctx, array $s): array
    {
        $w = $s['branchId'] ? 'branch_id = :b AND at >= :f AND at <= :t' : 'at >= :f AND at <= :t';
        $p = $s['branchId'] ? [':b' => $s['branchId'], ':f' => $s['from'], ':t' => $s['to']] : [':f' => $s['from'], ':t' => $s['to']];
        return $ctx->repo()->allDocs('payments', $w, $p, 'at DESC');
    }

    public static function returns(Context $ctx, array $s): array
    {
        $w = $s['branchId'] ? 'branch_id = :b AND at >= :f AND at <= :t' : 'at >= :f AND at <= :t';
        $p = $s['branchId'] ? [':b' => $s['branchId'], ':f' => $s['from'], ':t' => $s['to']] : [':f' => $s['from'], ':t' => $s['to']];
        return $ctx->repo()->allDocs('sale_returns', $w, $p, 'at DESC');
    }

    public static function expenses(Context $ctx, array $s): array
    {
        $w = $s['branchId'] ? 'branch_id = :b AND at >= :f AND at <= :t' : 'at >= :f AND at <= :t';
        $p = $s['branchId'] ? [':b' => $s['branchId'], ':f' => $s['from'], ':t' => $s['to']] : [':f' => $s['from'], ':t' => $s['to']];
        return $ctx->repo()->allDocs('expenses', $w, $p, 'at DESC');
    }

    public static function purchases(Context $ctx, array $s): array
    {
        $w = $s['branchId'] ? 'branch_id = :b AND created_at >= :f AND created_at <= :t' : 'created_at >= :f AND created_at <= :t';
        $p = $s['branchId'] ? [':b' => $s['branchId'], ':f' => $s['from'], ':t' => $s['to']] : [':f' => $s['from'], ':t' => $s['to']];
        return $ctx->repo()->allDocs('purchases', $w, $p, 'created_at DESC');
    }

    /** sale_id => list<sale_item doc>, one query for the whole set. */
    public static function itemsBySale(Context $ctx, array $sales): array
    {
        if (!$sales) {
            return [];
        }
        $ids = array_column($sales, 'id');
        $in = implode(',', array_fill(0, count($ids), '?'));
        $rows = $ctx->db->all(
            "SELECT doc FROM sale_items WHERE merchant_id = ? AND sale_id IN ({$in})",
            array_merge([$ctx->repo()->merchantId()], $ids),
        );
        $out = [];
        foreach ($rows as $r) {
            $d = json_decode($r['doc'], true);
            $out[$d['saleId']][] = $d;
        }
        return $out;
    }

    /* ---------------------------------------------------------- payments */

    public static function paymentKey(array $p): string
    {
        if (($p['method'] ?? null) === 'mobile') {
            return strtolower($p['provider'] ?? 'mobile');
        }
        return $p['method'] ?? 'other';
    }

    public static function paymentBreakdown(array $payments): array
    {
        $by = [];
        $cashIn = $cashOut = $eIn = $eOut = 0;
        foreach ($payments as $p) {
            $key = self::paymentKey($p);
            $acc = $by[$key] ?? ['key' => $key, 'label' => self::PAYMENT_LABELS[$key] ?? $key, 'inflow' => 0, 'refund' => 0, 'count' => 0];
            if (($p['direction'] ?? '') === 'out') {
                $acc['refund'] += $p['amount'];
                $key === 'cash' ? $cashOut += $p['amount'] : $eOut += $p['amount'];
            } else {
                $acc['inflow'] += $p['amount'];
                $acc['count']++;
                $key === 'cash' ? $cashIn += $p['amount'] : $eIn += $p['amount'];
            }
            $by[$key] = $acc;
        }
        $groups = array_values(array_map(static fn ($g) => $g + ['net' => $g['inflow'] - $g['refund']], $by));
        usort($groups, static fn ($a, $b) => $b['inflow'] <=> $a['inflow']);
        return [
            'groups' => $groups,
            'cash' => ['inflow' => $cashIn, 'refund' => $cashOut, 'net' => $cashIn - $cashOut],
            'epayment' => ['inflow' => $eIn, 'refund' => $eOut, 'net' => $eIn - $eOut],
            'epaymentGroups' => array_values(array_filter($groups, static fn ($g) => $g['key'] !== 'cash')),
            'total' => $cashIn + $eIn,
        ];
    }

    /* ---------------------------------------------------------- KPI core */

    public static function periodKpis(Context $ctx, array $s): array
    {
        $sales = self::sales($ctx, $s);
        $pay = self::paymentBreakdown(self::payments($ctx, $s));
        $returns = self::returns($ctx, $s);
        $expenses = self::expenses($ctx, $s);
        $purchases = self::purchases($ctx, $s);

        $unitsSold = 0;
        $customers = [];
        $totalSales = $totalDiscount = $grossProfit = 0;
        $couponDiscount = $autoDiscount = $taxCollected = 0;
        foreach ($sales as $sa) {
            $unitsSold += $sa['totalQty'] ?? 0;
            if (!empty($sa['customerId'])) {
                $customers[$sa['customerId']] = true;
            }
            $totalSales += $sa['grandTotal'] ?? 0;
            $totalDiscount += $sa['discountTotal'] ?? 0;
            $couponDiscount += $sa['couponDiscount'] ?? 0;
            $autoDiscount += $sa['autoDiscount'] ?? 0;
            $taxCollected += $sa['taxTotal'] ?? 0;
            $grossProfit += $sa['estimatedProfit'] ?? 0;
        }
        $returnsTotal = array_sum(array_map(static fn ($r) => $r['refundTotal'] ?? 0, $returns));
        $expensesTotal = array_sum(array_map(static fn ($e) => $e['amount'] ?? 0, $expenses));
        $purchaseTotal = array_sum(array_map(static fn ($p) => $p['grandTotal'] ?? 0, $purchases));

        $stockCost = $stockRetail = 0;
        $stock = $ctx->repo()->allDocs('stock', $s['branchId'] ? 'branch_id = :b AND quantity <> 0' : 'quantity <> 0', $s['branchId'] ? [':b' => $s['branchId']] : []);
        foreach ($stock as $st) {
            $prod = $ctx->repo()->doc('products', $st['productId']);
            if (!$prod) {
                continue;
            }
            $sell = $prod['sellingPrice'] ?? 0;
            foreach ($prod['variants'] ?? [] as $v) {
                if ($v['id'] === ($st['variantId'] ?? null)) {
                    $sell = $v['sellingPrice'] ?? $sell;
                }
            }
            $stockCost += Money::mul((int) $st['avgCost'], (int) $st['quantity']);
            $stockRetail += Money::mul((int) $sell, (int) $st['quantity']);
        }
        $receivable = 0;
        foreach ($ctx->repo()->allDocs('sales', '1=1') as $sa) {
            $receivable += $sa['dueTotal'] ?? 0;
        }

        return [
            'totalSales' => $totalSales, 'invoiceCount' => count($sales),
            'cashPayments' => $pay['cash']['inflow'], 'cashNet' => $pay['cash']['net'],
            'ePayments' => $pay['epayment']['inflow'], 'ePaymentGroups' => $pay['epaymentGroups'],
            'paymentGroups' => $pay['groups'], 'customersServed' => count($customers), 'unitsSold' => $unitsSold,
            'totalDiscount' => $totalDiscount, 'couponDiscount' => $couponDiscount,
            'autoDiscount' => $autoDiscount, 'taxCollected' => $taxCollected,
            'purchaseTotal' => $purchaseTotal,
            'stockCost' => $stockCost, 'stockRetail' => $stockRetail, 'potentialProfit' => $stockRetail - $stockCost,
            'grossProfit' => $grossProfit, 'netProfit' => $grossProfit - $expensesTotal,
            'returnsTotal' => $returnsTotal, 'returnsCount' => count($returns),
            'exchangesCount' => count(array_filter($returns, static fn ($r) => ($r['type'] ?? '') === 'exchange')),
            'exchangeAddon' => array_sum(array_map(static fn ($r) => $r['additionalPayment'] ?? 0, $returns)),
            'expensesTotal' => $expensesTotal, 'receivable' => $receivable,
            'avgOrderValue' => $sales ? (int) round($totalSales / count($sales)) : 0,
        ];
    }

    /* ---------------------------------------------------------- rows */

    public static function saleRows(array $sales): array
    {
        return array_map(static fn ($s) => [
            'id' => $s['id'], 'invoiceNo' => $s['invoiceNo'], 'date' => $s['createdAt'],
            'customer' => $s['customerName'] ?? 'Walk-in Customer', 'customerId' => $s['customerId'] ?? null,
            'cashier' => $s['cashierName'] ?? '-', 'items' => $s['totalQty'] ?? 0, 'subtotal' => $s['subtotal'] ?? 0,
            'discount' => $s['discountTotal'] ?? 0, 'tax' => $s['taxTotal'] ?? 0, 'total' => $s['grandTotal'] ?? 0,
            'paid' => $s['paidTotal'] ?? 0, 'due' => $s['dueTotal'] ?? 0, 'profit' => $s['estimatedProfit'] ?? 0,
            'payment' => $s['paymentSummary'] ?: '-', 'status' => $s['status'] ?? null,
        ], $sales);
    }

    public static function productsSoldRows(Context $ctx, array $sales): array
    {
        $items = self::itemsBySale($ctx, $sales);
        $map = [];
        foreach ($sales as $s) {
            foreach ($items[$s['id']] ?? [] as $it) {
                $acc = $map[$it['productId']] ?? ['productId' => $it['productId'], 'product' => $it['name'], 'sku' => $it['sku'] ?? null, 'barcode' => $it['barcode'] ?? null, 'qtySold' => 0, 'revenue' => 0, 'discount' => 0, 'cost' => 0, 'profit' => 0, 'transactions' => 0];
                $acc['qtySold'] += $it['qty'];
                $acc['revenue'] += $it['lineTotal'] - $it['taxAmount'];
                $acc['discount'] += $it['discountTotal'];
                $acc['cost'] += Money::mul((int) $it['costPrice'], (int) $it['qty']);
                $acc['profit'] = $acc['revenue'] - $acc['cost'];
                $acc['transactions']++;
                $map[$it['productId']] = $acc;
            }
        }
        $rows = array_values($map);
        usort($rows, static fn ($a, $b) => $b['revenue'] <=> $a['revenue']);
        return $rows;
    }

    public static function inventoryValuationRows(Context $ctx, ?string $branchId): array
    {
        $rows = [];
        $stock = $ctx->repo()->allDocs('stock', $branchId ? 'branch_id = :b AND quantity <> 0' : 'quantity <> 0', $branchId ? [':b' => $branchId] : []);
        foreach ($stock as $st) {
            $p = $ctx->repo()->doc('products', $st['productId']);
            if (!$p || !empty($p['archivedAt'])) {
                continue;
            }
            $sell = $p['sellingPrice'] ?? 0;
            $vlabel = '';
            foreach ($p['variants'] ?? [] as $v) {
                if ($v['id'] === ($st['variantId'] ?? null)) {
                    $sell = $v['sellingPrice'] ?? $sell;
                    $vlabel = " ({$v['name']})";
                }
            }
            $stockValue = Money::mul((int) $st['avgCost'], (int) $st['quantity']);
            $retail = Money::mul((int) $sell, (int) $st['quantity']);
            $rows[] = [
                'productId' => $p['id'], 'product' => $p['name'] . $vlabel, 'sku' => $p['sku'] ?? null,
                'quantity' => (int) $st['quantity'], 'avgCost' => (int) $st['avgCost'], 'sellingPrice' => (int) $sell,
                'stockValue' => $stockValue, 'potentialSales' => $retail, 'potentialProfit' => $retail - $stockValue,
            ];
        }
        usort($rows, static fn ($a, $b) => $b['stockValue'] <=> $a['stockValue']);
        return $rows;
    }

    /** Dead-stock / slow-mover / ageing. `days` is the idle threshold marking a line "dead". */
    public static function deadStockRows(Context $ctx, ?string $branchId, int $days = 90): array
    {
        $nowMs = (int) (microtime(true) * 1000);
        $cutoff = $nowMs - $days * 86400000;
        $win30 = $nowMs - 30 * 86400000;
        $win90 = $nowMs - 90 * 86400000;

        $where = ['type = :t'];
        $params = [':t' => 'sale'];
        if ($branchId) {
            $where[] = 'branch_id = :b';
            $params[':b'] = $branchId;
        }
        $sale = [];
        foreach ($ctx->repo()->allDocs('inventory_transactions', implode(' AND ', $where), $params) as $t) {
            $key = $t['productId'] . ':' . ($t['variantId'] ?? 'base');
            $at = (int) (strtotime((string) $t['at']) * 1000);
            $units = abs((int) ($t['qtyDelta'] ?? 0));
            $acc = $sale[$key] ?? ['last' => 0, 'q30' => 0, 'q90' => 0];
            if ($at > $acc['last']) {
                $acc['last'] = $at;
            }
            if ($at >= $win30) {
                $acc['q30'] += $units;
            }
            if ($at >= $win90) {
                $acc['q90'] += $units;
            }
            $sale[$key] = $acc;
        }

        $rows = [];
        $stock = $ctx->repo()->allDocs('stock', $branchId ? 'branch_id = :b AND quantity > 0' : 'quantity > 0', $branchId ? [':b' => $branchId] : []);
        foreach ($stock as $st) {
            $p = $ctx->repo()->doc('products', $st['productId']);
            if (!$p || !empty($p['archivedAt']) || ($p['trackInventory'] ?? true) === false) {
                continue;
            }
            $vName = '';
            $vSku = null;
            foreach ($p['variants'] ?? [] as $v) {
                if ($v['id'] === ($st['variantId'] ?? null)) {
                    $vName = $v['name'] ?? '';
                    $vSku = $v['sku'] ?? null;
                }
            }
            $key = $st['productId'] . ':' . ($st['variantId'] ?? 'base');
            $agg = $sale[$key] ?? null;
            $lastMs = $agg['last'] ?? 0;
            $sinceMs = $lastMs ?: (int) (strtotime((string) ($st['lastMovementAt'] ?? $p['createdAt'] ?? 'now')) * 1000);
            $stockValue = Money::mul((int) $st['avgCost'], (int) $st['quantity']);
            $status = (!$lastMs || $lastMs < $cutoff) ? 'dead' : (empty($agg['q30']) ? 'slow' : 'ok');
            $rows[] = [
                'productId' => $p['id'],
                'product' => $p['name'] . ($vName ? " ({$vName})" : ''),
                'sku' => $vSku ?: ($p['sku'] ?? null),
                'category' => !empty($p['categoryId']) ? ($ctx->repo()->doc('categories', $p['categoryId'])['name'] ?? '-') : '-',
                'quantity' => (int) $st['quantity'],
                'avgCost' => (int) $st['avgCost'],
                'stockValue' => $stockValue,
                'lastSold' => $lastMs ? gmdate('c', (int) ($lastMs / 1000)) : null,
                'daysIdle' => max(0, (int) floor(($nowMs - $sinceMs) / 86400000)),
                'soldLast30' => $agg['q30'] ?? 0,
                'soldLast90' => $agg['q90'] ?? 0,
                'status' => $status,
            ];
        }
        usort($rows, static fn ($a, $b) => $b['stockValue'] <=> $a['stockValue']);
        return $rows;
    }

    public static function expenseRows(array $expenses): array
    {
        return array_map(static fn ($e) => [
            'reference' => $e['reference'] ?? null, 'category' => $e['category'] ?? null, 'description' => $e['description'] ?? '',
            'amount' => $e['amount'] ?? 0, 'paymentMethod' => $e['paymentMethod'] ?? null, 'employee' => $e['employeeName'] ?? '-', 'date' => $e['at'],
        ], $expenses);
    }

    public static function returnRows(array $returns): array
    {
        $rows = [];
        foreach ($returns as $r) {
            foreach ($r['items'] ?? [] as $it) {
                $rows[] = [
                    'returnRef' => $r['reference'], 'type' => $r['type'] ?? 'return', 'saleId' => $r['saleId'],
                    'invoiceNo' => $r['invoiceNo'], 'date' => $r['at'], 'customer' => $r['customerName'] ?? 'Walk-in Customer',
                    'cashier' => $r['cashierName'] ?? '-', 'product' => $it['name'] ?? $it['productId'], 'qty' => $it['qty'],
                    'amount' => $it['refund'] ?? 0, 'reason' => $r['reason'] ?? null, 'method' => $r['refundMethod'] ?? 'cash',
                ];
            }
        }
        usort($rows, static fn ($a, $b) => strcmp($b['date'], $a['date']));
        return $rows;
    }

    public static function purchaseRows(Context $ctx, array $purchases): array
    {
        return array_map(static fn ($p) => [
            'reference' => $p['reference'], 'purchaseId' => $p['id'], 'date' => $p['createdAt'],
            'supplier' => $ctx->repo()->doc('suppliers', $p['supplierId'] ?? '')['name'] ?? '-',
            'items' => count($p['lines'] ?? []), 'subtotal' => $p['subtotal'] ?? 0, 'tax' => $p['taxTotal'] ?? 0,
            'total' => $p['grandTotal'] ?? 0, 'paid' => $p['paidTotal'] ?? 0, 'due' => $p['dueTotal'] ?? 0, 'status' => $p['status'] ?? null,
        ], $purchases);
    }

    public static function receivableRows(Context $ctx): array
    {
        $rows = [];
        foreach ($ctx->repo()->allDocs('sales', '1=1') as $s) {
            if (($s['dueTotal'] ?? 0) <= 0) {
                continue;
            }
            $rows[] = [
                'saleId' => $s['id'], 'invoiceNo' => $s['invoiceNo'], 'date' => $s['createdAt'],
                'customer' => $s['customerName'] ?? 'Walk-in Customer', 'customerId' => $s['customerId'] ?? null,
                'phone' => $s['customerPhone'] ?? '-', 'total' => $s['grandTotal'], 'paid' => $s['paidTotal'], 'due' => $s['dueTotal'], 'status' => $s['status'],
            ];
        }
        usort($rows, static fn ($a, $b) => $b['due'] <=> $a['due']);
        return $rows;
    }

    public static function aggregate(array $rows, array $keys): array
    {
        $out = [];
        foreach ($keys as $k) {
            $sum = array_sum(array_map(static fn ($r) => (float) ($r[$k] ?? 0), $rows));
            // money + counts are whole numbers; keep them ints so responses match the mock
            $out[$k] = ($sum == (int) $sum) ? (int) $sum : round($sum, 2);
        }
        $out['count'] = count($rows);
        return $out;
    }

    public static function salesSeries(array $sales, string $granularity): array
    {
        $map = [];
        foreach ($sales as $s) {
            $key = substr($s['createdAt'], 0, $granularity === 'month' ? 7 : 10);
            $acc = $map[$key] ?? ['date' => $key, 'revenue' => 0, 'profit' => 0, 'orders' => 0];
            $acc['revenue'] += $s['grandTotal'];
            $acc['profit'] += $s['estimatedProfit'];
            $acc['orders']++;
            $map[$key] = $acc;
        }
        ksort($map);
        return array_values($map);
    }
}
