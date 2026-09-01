<?php
declare(strict_types=1);

namespace Afia\Modules;

use Afia\App;
use Afia\Context;
use Afia\Domain\Cart;
use Afia\Domain\Inventory as Ledger;
use Afia\Http\Response;
use Afia\Http\Router;
use Afia\Support\Audit;
use Afia\Support\Branch;
use Afia\Support\Clock;
use Afia\Support\DocNo;
use Afia\Support\HttpError;
use Afia\Support\Money;
use Afia\Support\Notify;
use Afia\Support\Settings;
use Afia\Support\Uuid;

/**
 * The transaction core - ported from js/core/mock/sales.routes.js.
 *
 * POST /sales runs the whole checkout inside one DB transaction:
 *   validate cart -> validate availability -> compute money -> validate payment
 *   -> allocate a unique per-branch invoice number -> create sale + items +
 *   payments + inventory ledger -> update stock + customer -> audit -> notify.
 * A failure rolls the whole thing back: there are no partial sales.
 * Idempotency: a repeated idempotencyKey returns the original sale.
 */
final class Sales
{
    public static function register(Router $r, App $app): void
    {
        $r->get('/sales', fn (Context $c) => self::list($c));
        $r->get('/sales/lookup', fn (Context $c) => self::lookup($c));
        $r->get('/sales/:id', fn (Context $c, $p) => self::show($c, $p));
        $r->post('/sales', fn (Context $c) => self::checkout($c));
        $r->post('/sales/:id/payment', fn (Context $c, $p) => self::duePayment($c, $p));

        $r->get('/held-sales', fn (Context $c) => self::listHeld($c));
        $r->post('/held-sales', fn (Context $c) => self::hold($c));
        $r->delete('/held-sales/:id', fn (Context $c, $p) => self::dropHeld($c, $p));

        $r->get('/sale-returns', fn (Context $c) => self::listReturns($c));
        $r->post('/sales/:id/returns', fn (Context $c, $p) => self::createReturn($c, $p));
    }

    /* ---------------------------------------------------------------- list */

    private static function list(Context $ctx): Response
    {
        $ctx->requirePermission('sales.view');
        $q = $ctx->request->query;
        $where = ['1=1'];
        $params = [];
        foreach (['branchId' => 'branch_id', 'cashierId' => 'cashier_id', 'customerId' => 'customer_id', 'registerSessionId' => 'register_session_id', 'status' => 'status'] as $qk => $col) {
            if (!empty($q[$qk]) && $q[$qk] !== 'all') {
                $where[] = "{$col} = :{$col}";
                $params[":{$col}"] = $q[$qk];
            }
        }
        $result = $ctx->repo()->list([
            'table' => 'sales', 'query' => $q, 'baseWhere' => implode(' AND ', $where), 'params' => $params,
            'searchCols' => ['invoice_no'],
            'sortMap' => ['createdAt' => 'created_at', 'invoiceNo' => 'invoice_no', 'grandTotal' => 'grand_total'],
            'defaultSort' => 'createdAt', 'defaultDir' => 'desc', 'dateColumn' => 'created_at',
        ]);
        $result['data'] = array_map(fn ($s) => self::decorate($ctx, $s), $result['data']);

        // totals over the whole filtered set (not just the page)
        $all = $ctx->repo()->allDocs('sales', implode(' AND ', $where), $params);
        $totals = ['count' => 0, 'gross' => 0, 'discount' => 0, 'tax' => 0, 'profit' => 0];
        foreach ($all as $s) {
            $totals['count']++;
            $totals['gross'] += $s['grandTotal'] ?? 0;
            $totals['discount'] += $s['discountTotal'] ?? 0;
            $totals['tax'] += $s['taxTotal'] ?? 0;
            $totals['profit'] += $s['estimatedProfit'] ?? 0;
        }
        $result['totals'] = $totals;
        return Response::json($result);
    }

    private static function lookup(Context $ctx): Response
    {
        $ctx->requirePermission('sales.view');
        $invoice = trim((string) ($ctx->request->query['invoice'] ?? $ctx->request->query['invoiceNo'] ?? ''));
        if ($invoice === '') {
            throw HttpError::badRequest('Provide an invoice number');
        }
        $sale = $ctx->repo()->findDoc('sales', 'LOWER(invoice_no) = :n', [':n' => strtolower($invoice)])
            ?? throw HttpError::notFound('Invoice');
        return Response::json(self::decorate($ctx, $sale));
    }

    /** Collect a payment against a due (credit) sale. */
    private static function duePayment(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('sales.create');
        $sale = $ctx->repo()->doc('sales', $p['id']) ?? throw HttpError::notFound('Sale');
        $due = (int) ($sale['dueTotal'] ?? 0);
        if ($due <= 0) {
            throw HttpError::badRequest('This sale has no outstanding balance.');
        }
        $b = $ctx->body();
        $amount = (int) ($b['amount'] ?? 0);
        if ($amount <= 0) {
            throw HttpError::badRequest('Enter an amount greater than zero.');
        }
        if ($amount > $due) {
            throw HttpError::badRequest('The amount cannot exceed the ' . Money::format($due) . ' still due.');
        }
        $method = $b['method'] ?? 'cash';

        return $ctx->db->transaction(function () use ($ctx, $sale, $due, $amount, $method, $b) {
            $now = Clock::now();
            $reg = $ctx->repo()->findDoc('register_sessions', "branch_id = :b AND status = 'open'", [':b' => $sale['branchId']]);
            $pid = Uuid::v4();
            $ctx->repo()->insert('payments', $pid, [
                'id' => $pid, 'saleId' => $sale['id'], 'branchId' => $sale['branchId'], 'registerSessionId' => $reg['id'] ?? null,
                'direction' => 'in', 'method' => $method,
                'provider' => $b['provider'] ?? (in_array($method, ['bkash', 'nagad', 'rocket', 'other'], true) ? $method : null),
                'amount' => $amount, 'reference' => isset($b['reference']) ? mb_substr((string) $b['reference'], 0, 40) : null,
                'note' => $b['note'] ?? 'Due payment', 'at' => $now,
            ], ['sale_id' => $sale['id'], 'branch_id' => $sale['branchId'], 'register_session_id' => $reg['id'] ?? null, 'direction' => 'in', 'method' => $method, 'amount' => $amount, 'at' => $now]);

            $nextDue = $due - $amount;
            $ctx->repo()->update('sales', $sale['id'], [
                'paidTotal' => (int) ($sale['paidTotal'] ?? 0) + $amount,
                'dueTotal' => $nextDue,
                'status' => $nextDue <= 0 && ($sale['status'] ?? '') === 'due' ? 'completed' : ($sale['status'] ?? 'completed'),
            ], $nextDue <= 0 && ($sale['status'] ?? '') === 'due' ? ['status' => 'completed'] : []);

            if (!empty($sale['customerId'])) {
                $cust = $ctx->repo()->doc('customers', $sale['customerId']);
                if ($cust) {
                    $ctx->repo()->update('customers', $sale['customerId'], ['outstandingBalance' => max(0, (int) ($cust['outstandingBalance'] ?? 0) - $amount)]);
                }
                $lid = Uuid::v4();
                $ctx->repo()->insert('customer_ledger', $lid, [
                    'id' => $lid, 'customerId' => $sale['customerId'], 'type' => 'payment', 'refType' => 'sale', 'refId' => $sale['id'],
                    'amount' => $amount, 'balanceDelta' => -$amount, 'note' => $b['note'] ?? ('Payment for ' . $sale['invoiceNo']), 'at' => $now,
                ], ['customer_id' => $sale['customerId'], 'type' => 'payment', 'ref_type' => 'sale', 'ref_id' => $sale['id'], 'amount' => $amount, 'at' => $now]);
            }

            Audit::record($ctx, 'update', 'sale', $sale['id'], ['meta' => ['action' => 'due_payment', 'amount' => $amount, 'invoiceNo' => $sale['invoiceNo']]]);
            Notify::push($ctx, 'sale', 'Due payment received', Money::format($amount) . ' against ' . $sale['invoiceNo'] . ($nextDue > 0 ? ' — ' . Money::format($nextDue) . ' still due' : ' — fully paid'), ['level' => 'success', 'link' => '#/sales/' . $sale['id']]);

            $fresh = $ctx->repo()->doc('sales', $sale['id']);
            return Response::json(array_merge(self::decorate($ctx, $fresh), [
                'items' => $ctx->repo()->allDocs('sale_items', 'sale_id = :s', [':s' => $sale['id']], 'created_at ASC'),
                'payments' => $ctx->repo()->allDocs('payments', 'sale_id = :s', [':s' => $sale['id']], 'created_at ASC'),
            ]));
        });
    }

    private static function show(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('sales.view');
        $sale = $ctx->repo()->doc('sales', $p['id']) ?? throw HttpError::notFound('Sale');
        $items = $ctx->repo()->allDocs('sale_items', 'sale_id = :s', [':s' => $sale['id']], 'created_at ASC');
        usort($items, static fn ($a, $b) => ($a['lineNo'] ?? 0) <=> ($b['lineNo'] ?? 0));
        return Response::json(array_merge(self::decorate($ctx, $sale), [
            'items' => $items,
            'payments' => $ctx->repo()->allDocs('payments', 'sale_id = :s', [':s' => $sale['id']], 'created_at ASC'),
            'returns' => $ctx->repo()->allDocs('sale_returns', 'sale_id = :s', [':s' => $sale['id']], 'created_at ASC'),
        ]));
    }

    /* ------------------------------------------------------------ checkout */

    private static function checkout(Context $ctx): Response
    {
        $ctx->requirePermission('sales.create');
        $b = $ctx->body();
        $settings = Settings::get($ctx);
        $allowNegative = (bool) ($settings['inventory']['allowNegativeStock'] ?? false);

        if (!empty($b['idempotencyKey'])) {
            $existing = $ctx->repo()->findDoc('sales', 'idempotency_key = :k', [':k' => $b['idempotencyKey']]);
            if ($existing) {
                return Response::json(array_merge(self::decorate($ctx, $existing), ['_idempotentReplay' => true]));
            }
        }

        $branch = Branch::require($ctx, $b['branchId'] ?? null);
        $stamp = Ledger::actorStamp($ctx);

        $session = $ctx->repo()->findDoc('register_sessions', "branch_id = :b AND status = 'open' AND cashier_id = :c", [':b' => $branch['id'], ':c' => $stamp['userId']])
            ?: $ctx->repo()->findDoc('register_sessions', "branch_id = :b AND status = 'open'", [':b' => $branch['id']]);
        if (($settings['pos']['requireOpenRegister'] ?? false) && !$session) {
            throw HttpError::conflict('The cash register is closed. Open a register session before selling.');
        }

        $lines = self::buildCartLines($ctx, $b['items'] ?? null);
        self::assertAvailability($ctx, $lines, $branch['id'], $allowNegative);

        $cartDiscounts = self::resolveCartDiscounts($ctx, $b['couponCode'] ?? null);
        $calc = Cart::compute($lines, [
            'cartDiscountType' => $b['cartDiscountType'] ?? null,
            'cartDiscountValue' => $b['cartDiscountValue'] ?? 0,
            'taxes' => self::activeTaxes($ctx),
            'autoDiscounts' => $cartDiscounts['autoDiscounts'],
            'coupon' => $cartDiscounts['coupon'],
        ]);
        if ($calc['grandTotal'] < 0) {
            throw HttpError::badRequest('Total cannot be negative.');
        }
        if ($cartDiscounts['coupon'] && !$calc['couponDiscount']) {
            throw HttpError::badRequest(!empty($cartDiscounts['coupon']['minSpend'])
                ? 'This coupon needs a minimum spend of ' . Money::format((int) $cartDiscounts['coupon']['minSpend']) . '.'
                : 'This coupon cannot be applied to the current cart.');
        }

        // loyalty redemption (a tender - the sale total is unchanged)
        $redeemReq = max(0, (int) ($b['redeemPoints'] ?? 0));
        $loyaltyRedeemed = 0;
        $loyaltyRedeemValue = 0;
        if ($redeemReq > 0) {
            if (empty($b['customerId'])) {
                throw HttpError::badRequest('Select a customer to redeem loyalty points.');
            }
            $cust = $ctx->repo()->doc('customers', $b['customerId']) ?? throw HttpError::badRequest('That customer no longer exists.');
            $perPoint = Money::toMinor($settings['pos']['loyaltyRedeemValue'] ?? 1);
            $minRedeem = max(0, (int) ($settings['pos']['loyaltyMinRedeem'] ?? 0));
            if ($perPoint <= 0) {
                throw HttpError::badRequest('Loyalty redemption is turned off (set a value per point in Settings > POS).');
            }
            if ($redeemReq < $minRedeem) {
                throw HttpError::badRequest("Redeem at least {$minRedeem} points.");
            }
            if ($redeemReq > (int) ($cust['loyaltyPoints'] ?? 0)) {
                throw HttpError::badRequest("{$cust['name']} only has " . (int) ($cust['loyaltyPoints'] ?? 0) . ' points.');
            }
            $loyaltyRedeemed = min($redeemReq, intdiv($calc['grandTotal'], $perPoint));
            $loyaltyRedeemValue = $loyaltyRedeemed * $perPoint;
        }

        $isDueSale = ($b['onAccount'] ?? false) === true && !empty($b['customerId']);
        $payableTotal = max(0, $calc['grandTotal'] - $loyaltyRedeemValue);
        $payInfo = ['paid' => 0, 'change' => 0, 'cashPaid' => 0, 'list' => []];
        if (!$isDueSale || !empty($b['payments'])) {
            $payInfo = Cart::validatePayments($b['payments'] ?? null, $isDueSale ? 0 : $payableTotal);
        }
        if ($isDueSale && $payInfo['paid'] > $payableTotal) {
            throw HttpError::badRequest('Amount paid exceeds the total on an account sale.');
        }
        $due = max(0, $payableTotal - $payInfo['paid']);
        if ($due > 0 && empty($b['customerId'])) {
            throw HttpError::conflict('Select a customer to record an outstanding balance for an unpaid amount.');
        }

        return $ctx->db->transaction(function () use ($ctx, $b, $settings, $branch, $stamp, $session, $lines, $calc, $payInfo, $due, $isDueSale, $allowNegative, $cartDiscounts, $loyaltyRedeemed, $loyaltyRedeemValue) {
            $invoiceNo = DocNo::next($ctx->repo(), 'invoice:' . $branch['id'],
                $settings['pos']['invoiceTemplate'] ?? 'INV-{BR}-{SEQ}',
                ['prefix' => $settings['business']['invoicePrefix'] ?? 'INV', 'branchCode' => $branch['code'] ?: 'MAIN', 'seqWidth' => 5]);

            $customer = !empty($b['customerId']) ? $ctx->repo()->doc('customers', $b['customerId']) : null;
            $saleId = Uuid::v4();
            $now = Clock::now();

            $saleDoc = [
                'id' => $saleId, 'invoiceNo' => $invoiceNo, 'idempotencyKey' => $b['idempotencyKey'] ?? Uuid::v4(),
                'branchId' => $branch['id'], 'branchName' => $branch['name'],
                'registerSessionId' => $session['id'] ?? null,
                'cashierId' => $stamp['userId'], 'cashierName' => $stamp['userName'],
                'customerId' => $customer['id'] ?? null,
                'customerName' => $customer['name'] ?? 'Walk-in Customer',
                'customerPhone' => $customer['phone'] ?? null,
                'note' => $b['note'] ?? '', 'status' => $due > 0 ? 'due' : 'completed',
                'subtotal' => $calc['subtotal'], 'itemDiscountTotal' => $calc['itemDiscountTotal'],
                'cartDiscount' => $calc['cartDiscount'], 'cartDiscountType' => $calc['cartDiscountType'],
                'manualCartDiscount' => $calc['manualCartDiscount'], 'autoDiscount' => $calc['autoDiscount'],
                'autoDiscountName' => $calc['autoDiscountName'], 'couponDiscount' => $calc['couponDiscount'],
                'couponCode' => $calc['couponCode'],
                'cartDiscountValue' => $calc['cartDiscountValue'], 'discountTotal' => $calc['discountTotal'],
                'taxTotal' => $calc['taxTotal'], 'taxLines' => $calc['taxLines'],
                'grandTotal' => $calc['grandTotal'], 'totalQty' => $calc['totalQty'],
                'totalCost' => $calc['totalCost'], 'estimatedProfit' => $calc['estimatedProfit'],
                'loyaltyRedeemed' => $loyaltyRedeemed, 'loyaltyRedeemValue' => $loyaltyRedeemValue,
                'paidTotal' => $payInfo['paid'] + $loyaltyRedeemValue, 'changeTotal' => $payInfo['change'], 'dueTotal' => $due,
                'paymentSummary' => implode('+', array_merge(array_column($payInfo['list'], 'method'), $loyaltyRedeemValue ? ['points'] : [])) ?: ($isDueSale ? 'account' : ''),
                'createdAt' => $now,
            ];
            $ctx->repo()->insert('sales', $saleId, $saleDoc, [
                'invoice_no' => $invoiceNo, 'idempotency_key' => $saleDoc['idempotencyKey'],
                'branch_id' => $branch['id'], 'register_session_id' => $session['id'] ?? null,
                'cashier_id' => $stamp['userId'], 'customer_id' => $customer['id'] ?? null,
                'status' => $saleDoc['status'], 'grand_total' => $calc['grandTotal'], 'total_cost' => $calc['totalCost'],
            ]);

            foreach ($calc['items'] as $idx => $it) {
                $src = $lines[$idx];
                $itemId = Uuid::v4();
                $ctx->repo()->insert('sale_items', $itemId, [
                    'id' => $itemId, 'saleId' => $saleId, 'branchId' => $branch['id'], 'lineNo' => $idx + 1,
                    'productId' => $it['productId'], 'variantId' => $it['variantId'],
                    'name' => $src['name'], 'variantLabel' => $src['variantLabel'], 'sku' => $src['sku'], 'barcode' => $src['barcode'],
                    'unit' => $src['unit'], 'unitPrice' => $it['unitPrice'], 'costPrice' => $it['costPrice'], 'qty' => $it['qty'],
                    'lineDiscount' => $it['lineDiscount'], 'cartDiscountShare' => $it['cartDiscountShare'], 'discountTotal' => $it['discountTotal'],
                    'taxId' => $it['taxId'], 'taxRate' => $it['taxRate'], 'taxAmount' => $it['taxAmount'],
                    'taxableAmount' => $it['taxableAmount'], 'lineTotal' => $it['lineTotal'], 'returnedQty' => 0,
                ], [
                    'sale_id' => $saleId, 'branch_id' => $branch['id'], 'product_id' => $it['productId'],
                    'variant_id' => $it['variantId'], 'qty' => $it['qty'], 'line_total' => $it['lineTotal'], 'cost_price' => $it['costPrice'],
                ]);

                if ($src['trackInventory']) {
                    Ledger::post($ctx, [
                        'branchId' => $branch['id'], 'productId' => $it['productId'], 'variantId' => $it['variantId'],
                        'type' => 'sale', 'qtyDelta' => -$it['qty'], 'unitCost' => $it['costPrice'],
                        'refType' => 'sale', 'refId' => $saleId, 'note' => "Invoice {$invoiceNo}", 'allowNegative' => $allowNegative,
                    ]);
                }
            }

            foreach ($payInfo['list'] as $pmt) {
                $pid = Uuid::v4();
                $ctx->repo()->insert('payments', $pid, [
                    'id' => $pid, 'saleId' => $saleId, 'branchId' => $branch['id'], 'registerSessionId' => $session['id'] ?? null,
                    'direction' => 'in', 'method' => $pmt['method'],
                    'provider' => ($pmt['method'] ?? null) === 'mobile' ? ($pmt['provider'] ?? 'other') : null,
                    'amount' => (int) $pmt['amount'],
                    'reference' => isset($pmt['reference']) ? mb_substr((string) $pmt['reference'], 0, 40) : null,
                    'cardLast4' => isset($pmt['cardLast4']) ? substr(preg_replace('/\D/', '', (string) $pmt['cardLast4']), -4) : null,
                    'note' => $pmt['note'] ?? null, 'at' => $now,
                ], [
                    'sale_id' => $saleId, 'branch_id' => $branch['id'], 'register_session_id' => $session['id'] ?? null,
                    'direction' => 'in', 'method' => $pmt['method'], 'amount' => (int) $pmt['amount'], 'at' => $now,
                ]);
            }

            if ($customer) {
                $loyaltyPer = $settings['pos']['loyaltyPerCurrency'] ?? 0;
                $earned = $loyaltyPer ? (int) floor(Money::toMajor($calc['grandTotal']) * $loyaltyPer) : 0;
                $startPoints = (int) ($customer['loyaltyPoints'] ?? 0);
                $nextPoints = $startPoints - $loyaltyRedeemed + $earned;
                $ctx->repo()->update('customers', $customer['id'], [
                    'totalOrders' => ($customer['totalOrders'] ?? 0) + 1,
                    'totalPurchases' => ($customer['totalPurchases'] ?? 0) + $calc['grandTotal'],
                    'outstandingBalance' => ($customer['outstandingBalance'] ?? 0) + $due,
                    'loyaltyPoints' => $nextPoints,
                    'lastPurchaseAt' => $now,
                ]);
                if ($due > 0) {
                    $lid = Uuid::v4();
                    $ctx->repo()->insert('customer_ledger', $lid, [
                        'id' => $lid, 'customerId' => $customer['id'], 'type' => 'sale_due', 'refType' => 'sale', 'refId' => $saleId,
                        'amount' => $due, 'balanceDelta' => $due, 'note' => "Invoice {$invoiceNo}", 'at' => $now,
                    ], ['customer_id' => $customer['id'], 'type' => 'sale_due', 'ref_type' => 'sale', 'ref_id' => $saleId, 'amount' => $due, 'at' => $now]);
                }
                foreach ([
                    ['loyalty_redeem', -$loyaltyRedeemed, $loyaltyRedeemValue, "Redeemed {$loyaltyRedeemed} points on {$invoiceNo}"],
                    ['loyalty_earn', $earned, 0, "Earned {$earned} points on {$invoiceNo}"],
                ] as [$lType, $lPts, $lVal, $lNote]) {
                    if ($lPts === 0) {
                        continue;
                    }
                    $lid = Uuid::v4();
                    $ctx->repo()->insert('customer_ledger', $lid, [
                        'id' => $lid, 'customerId' => $customer['id'], 'type' => $lType, 'refType' => 'sale', 'refId' => $saleId,
                        'amount' => $lVal, 'balanceDelta' => 0, 'points' => $lPts, 'note' => $lNote, 'at' => $now,
                    ], ['customer_id' => $customer['id'], 'type' => $lType, 'ref_type' => 'sale', 'ref_id' => $saleId, 'amount' => $lVal, 'at' => $now]);
                }
            }

            Audit::record($ctx, 'sale', 'sale', $saleId, ['after' => ['invoiceNo' => $invoiceNo, 'grandTotal' => $calc['grandTotal'], 'items' => count($calc['items'])], 'meta' => ['invoiceNo' => $invoiceNo, 'branchId' => $branch['id']]]);
            Notify::push($ctx, 'sale', 'New sale', "{$invoiceNo} - " . Money::format($calc['grandTotal']) . " ({$calc['totalQty']} items)", ['level' => 'success', 'link' => "#/sales/{$saleId}", 'meta' => ['saleId' => $saleId]]);

            // bump coupon / automatic-discount usage counters
            if ($calc['couponDiscount'] && !empty($cartDiscounts['coupon']['id'])) {
                $cid = $cartDiscounts['coupon']['id'];
                $cur = $ctx->repo()->doc('discounts', $cid);
                if ($cur) {
                    $ctx->repo()->update('discounts', $cid, ['usageCount' => ($cur['usageCount'] ?? 0) + 1]);
                }
            }
            if ($calc['autoDiscount'] && $calc['autoDiscountName']) {
                foreach ($cartDiscounts['autoDiscounts'] as $d) {
                    if (($d['name'] ?? 'Automatic discount') === $calc['autoDiscountName']) {
                        $ctx->repo()->update('discounts', $d['id'], ['usageCount' => ($d['usageCount'] ?? 0) + 1]);
                        break;
                    }
                }
            }

            if (!empty($b['fromHeldSaleId'])) {
                $ctx->repo()->delete('held_sales', $b['fromHeldSaleId']);
            }

            $full = self::decorate($ctx, $ctx->repo()->doc('sales', $saleId));
            $full['items'] = $ctx->repo()->allDocs('sale_items', 'sale_id = :s', [':s' => $saleId], 'created_at ASC');
            $full['payments'] = $ctx->repo()->allDocs('payments', 'sale_id = :s', [':s' => $saleId], 'created_at ASC');
            return Response::json($full, 201);
        });
    }

    /* -------------------------------------------------------- held sales */

    private static function listHeld(Context $ctx): Response
    {
        $ctx->requirePermission('sales.hold');
        $q = $ctx->request->query;
        $where = ['1=1'];
        $params = [];
        foreach (['branchId' => 'branch_id', 'cashierId' => 'cashier_id'] as $k => $c) {
            if (!empty($q[$k])) {
                $where[] = "{$c} = :{$c}";
                $params[":{$c}"] = $q[$k];
            }
        }
        return Response::json($ctx->repo()->list([
            'table' => 'held_sales', 'query' => array_merge(['pageSize' => 'all'], $q),
            'baseWhere' => implode(' AND ', $where), 'params' => $params,
            'sortMap' => ['createdAt' => 'created_at'], 'defaultSort' => 'createdAt', 'defaultDir' => 'desc',
        ]));
    }

    private static function hold(Context $ctx): Response
    {
        $ctx->requirePermission('sales.hold');
        $b = $ctx->body();
        $branch = Branch::require($ctx, $b['branchId'] ?? null);
        $stamp = Ledger::actorStamp($ctx);
        $limit = Settings::get($ctx)['pos']['holdSaleLimit'] ?? 20;
        if ($ctx->repo()->count('held_sales', 'cashier_id = :c', [':c' => $stamp['userId']]) >= $limit) {
            throw HttpError::conflict('Too many held sales. Resume or discard one before holding another.');
        }
        return $ctx->db->transaction(function () use ($ctx, $b, $branch, $stamp) {
            $id = Uuid::v4();
            $doc = [
                'id' => $id, 'label' => $b['label'] ?? ('Hold ' . date('H:i:s')),
                'branchId' => $branch['id'], 'cashierId' => $stamp['userId'], 'cashierName' => $stamp['userName'],
                'customerId' => $b['customerId'] ?? null, 'customerName' => $b['customerName'] ?? null,
                'items' => $b['items'] ?? [], 'cartDiscountType' => $b['cartDiscountType'] ?? null,
                'cartDiscountValue' => $b['cartDiscountValue'] ?? 0, 'note' => $b['note'] ?? '',
                'grandTotal' => (int) ($b['grandTotal'] ?? 0), 'createdAt' => Clock::now(),
            ];
            $row = $ctx->repo()->insert('held_sales', $id, $doc, ['branch_id' => $branch['id'], 'cashier_id' => $stamp['userId']]);
            Audit::record($ctx, 'create', 'held_sale', $id);
            return Response::json($row, 201);
        });
    }

    private static function dropHeld(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('sales.hold');
        if (!$ctx->repo()->doc('held_sales', $p['id'])) {
            throw HttpError::notFound('Held sale');
        }
        return $ctx->db->transaction(function () use ($ctx, $p) {
            $ctx->repo()->delete('held_sales', $p['id']);
            Audit::record($ctx, 'delete', 'held_sale', $p['id']);
            return Response::json(['deleted' => true]);
        });
    }

    /* -------------------------------------------------- returns / exchanges */

    private static function listReturns(Context $ctx): Response
    {
        $ctx->requirePermission('sales.view');
        $q = $ctx->request->query;
        $where = ['1=1'];
        $params = [];
        foreach (['branchId' => 'branch_id', 'saleId' => 'sale_id'] as $k => $c) {
            if (!empty($q[$k])) {
                $where[] = "{$c} = :{$c}";
                $params[":{$c}"] = $q[$k];
            }
        }
        return Response::json($ctx->repo()->list([
            'table' => 'sale_returns', 'query' => $q, 'baseWhere' => implode(' AND ', $where), 'params' => $params,
            'searchCols' => ['reference'], 'sortMap' => ['at' => 'at', 'reference' => 'reference'],
            'defaultSort' => 'at', 'defaultDir' => 'desc', 'dateColumn' => 'at',
            'summarize' => static function ($list) {
                $exchanges = count(array_filter($list, static fn ($r) => ($r['type'] ?? '') === 'exchange'));
                return [
                    'returns' => count($list) - $exchanges,
                    'exchanges' => $exchanges,
                    'totalRefunded' => array_sum(array_map(static fn ($r) => (int) ($r['refundTotal'] ?? 0), $list)),
                    'extraCollected' => array_sum(array_map(static fn ($r) => (int) ($r['additionalPayment'] ?? 0), $list)),
                ];
            },
        ]));
    }

    private static function createReturn(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('sales.refund');
        $sale = $ctx->repo()->doc('sales', $p['id']) ?? throw HttpError::notFound('Sale');
        $b = $ctx->body();
        $lines = $b['lines'] ?? [];
        if (!$lines) {
            throw HttpError::badRequest('Select at least one item to return');
        }
        $isExchange = ($b['type'] ?? null) === 'exchange' && !empty($b['replacementItems']);
        $reason = $b['reason'] ?? 'customer_request';
        $settings = Settings::get($ctx);
        $allowNegative = (bool) ($settings['inventory']['allowNegativeStock'] ?? false);
        $saleItems = $ctx->repo()->allDocs('sale_items', 'sale_id = :s', [':s' => $sale['id']]);
        $branch = $ctx->repo()->doc('branches', $sale['branchId']);

        return $ctx->db->transaction(function () use ($ctx, $sale, $b, $lines, $isExchange, $reason, $allowNegative, $saleItems, $branch) {
            $ref = DocNo::next($ctx->repo(), 'sale_return:' . $sale['branchId'], 'RET-{BR}-{SEQ}', ['branchCode' => $branch['code'] ?? 'MAIN', 'seqWidth' => 4]);
            $refundGoods = 0;
            $refundTax = 0;
            $returnItems = [];
            $now = Clock::now();

            foreach ($lines as $line) {
                $item = null;
                foreach ($saleItems as $si) {
                    if ($si['id'] === ($line['saleItemId'] ?? null)) {
                        $item = $si;
                    }
                }
                if (!$item) {
                    throw HttpError::badRequest('A selected line does not belong to this invoice');
                }
                $qty = (int) ($line['qty'] ?? 0);
                $remaining = $item['qty'] - ($item['returnedQty'] ?? 0);
                if ($qty <= 0) {
                    throw HttpError::badRequest("Invalid return quantity for {$item['name']}");
                }
                if ($qty > $remaining) {
                    throw HttpError::conflict("Cannot return {$qty} of \"{$item['name']}\" - only {$remaining} remain returnable.");
                }
                $perUnitNet = (int) round(($item['lineTotal'] - $item['taxAmount']) / $item['qty']);
                $perUnitTax = (int) round($item['taxAmount'] / $item['qty']);
                $refundGoods += $perUnitNet * $qty;
                $refundTax += $perUnitTax * $qty;

                $ctx->repo()->update('sale_items', $item['id'], ['returnedQty' => ($item['returnedQty'] ?? 0) + $qty]);

                $restock = ($line['restock'] ?? true) !== false && $reason !== 'damaged';
                if ($restock) {
                    $product = $ctx->repo()->doc('products', $item['productId']);
                    if (($product['trackInventory'] ?? true) !== false) {
                        Ledger::post($ctx, [
                            'branchId' => $sale['branchId'], 'productId' => $item['productId'], 'variantId' => $item['variantId'],
                            'type' => 'sale_return', 'qtyDelta' => $qty, 'unitCost' => $item['costPrice'],
                            'refType' => 'sale_return', 'refId' => $ref, 'note' => ($isExchange ? 'Exchange' : 'Return') . " of {$sale['invoiceNo']}",
                        ]);
                    }
                }
                $returnItems[] = [
                    'saleItemId' => $item['id'], 'productId' => $item['productId'], 'variantId' => $item['variantId'],
                    'name' => $item['name'], 'sku' => $item['sku'], 'barcode' => $item['barcode'], 'qty' => $qty,
                    'unitPrice' => $perUnitNet + $perUnitTax, 'restock' => $restock, 'refund' => ($perUnitNet + $perUnitTax) * $qty,
                ];
            }
            $returnRefund = $refundGoods + $refundTax;

            $replacementTotal = 0;
            $replacementItems = [];
            if ($isExchange) {
                $repLines = [];
                foreach ($b['replacementItems'] as $r) {
                    $prod = $ctx->repo()->doc('products', $r['productId'] ?? '') ?? throw HttpError::badRequest('A replacement product no longer exists');
                    $variant = null;
                    foreach ($prod['variants'] ?? [] as $v) {
                        if ($v['id'] === ($r['variantId'] ?? null)) {
                            $variant = $v;
                        }
                    }
                    $qty = (int) ($r['qty'] ?? 0);
                    if ($qty <= 0) {
                        throw HttpError::badRequest("Invalid replacement quantity for {$prod['name']}");
                    }
                    $avail = Ledger::qty($ctx, $sale['branchId'], $prod['id'], $r['variantId'] ?? null);
                    if (($prod['trackInventory'] ?? true) !== false && $qty > $avail && !$allowNegative) {
                        throw HttpError::conflict("Insufficient stock for the selected replacement product \"{$prod['name']}\" - {$avail} available at this branch.");
                    }
                    $repLines[] = [
                        'productId' => $prod['id'], 'variantId' => $r['variantId'] ?? null,
                        'name' => $variant ? "{$prod['name']} - {$variant['name']}" : $prod['name'],
                        'sku' => $variant['sku'] ?? $prod['sku'], 'barcode' => $variant['barcode'] ?? $prod['barcode'],
                        'unitPrice' => $variant['sellingPrice'] ?? $prod['discountPrice'] ?? $prod['sellingPrice'],
                        'qty' => $qty, 'taxId' => $prod['taxId'] ?? null, 'costPrice' => $variant['costPrice'] ?? $prod['costPrice'],
                    ];
                }
                $calc = Cart::compute($repLines, ['taxes' => self::activeTaxes($ctx)]);
                $replacementTotal = $calc['grandTotal'];
                foreach ($calc['items'] as $i => $ci) {
                    $src = $repLines[$i];
                    $prod = $ctx->repo()->doc('products', $src['productId']);
                    if (($prod['trackInventory'] ?? true) !== false) {
                        Ledger::post($ctx, [
                            'branchId' => $sale['branchId'], 'productId' => $src['productId'], 'variantId' => $src['variantId'],
                            'type' => 'exchange_out', 'qtyDelta' => -$src['qty'], 'unitCost' => $src['costPrice'],
                            'refType' => 'sale_return', 'refId' => $ref, 'note' => "Exchange for {$sale['invoiceNo']}", 'allowNegative' => $allowNegative,
                        ]);
                    }
                    $replacementItems[] = [
                        'productId' => $src['productId'], 'variantId' => $src['variantId'], 'name' => $src['name'],
                        'sku' => $src['sku'], 'barcode' => $src['barcode'], 'qty' => $src['qty'],
                        'unitPrice' => $src['unitPrice'], 'lineTotal' => $ci['lineTotal'],
                    ];
                }
            }

            $difference = $replacementTotal - $returnRefund;
            $additionalPayment = $difference > 0 ? $difference : 0;
            $refundTotal = $difference < 0 ? -$difference : 0;
            $method = $b['refundMethod'] ?? $b['paymentMethod'] ?? ($b['payments'][0]['method'] ?? 'cash');
            $openReg = $ctx->repo()->findDoc('register_sessions', "branch_id = :b AND status = 'open'", [':b' => $sale['branchId']])['id'] ?? null;
            $stamp = Ledger::actorStamp($ctx);

            $id = Uuid::v4();
            $doc = [
                'id' => $id, 'reference' => $ref, 'type' => $isExchange ? 'exchange' : 'return',
                'saleId' => $sale['id'], 'invoiceNo' => $sale['invoiceNo'], 'branchId' => $sale['branchId'],
                'customerId' => $sale['customerId'] ?? null, 'customerName' => $sale['customerName'] ?? null,
                'cashierId' => $stamp['userId'], 'cashierName' => $stamp['userName'],
                'reason' => $reason, 'note' => $b['note'] ?? '', 'items' => $returnItems, 'replacementItems' => $replacementItems,
                'refundGoods' => $refundGoods, 'refundTax' => $refundTax, 'returnRefund' => $returnRefund,
                'replacementTotal' => $replacementTotal, 'difference' => $difference, 'refundTotal' => $refundTotal,
                'additionalPayment' => $additionalPayment, 'refundMethod' => $method, 'at' => $now,
            ];
            $row = $ctx->repo()->insert('sale_returns', $id, $doc, [
                'reference' => $ref, 'sale_id' => $sale['id'], 'branch_id' => $sale['branchId'],
                'customer_id' => $sale['customerId'] ?? null, 'type' => $doc['type'], 'at' => $now,
            ]);

            foreach ([
                ['cond' => $refundTotal > 0, 'dir' => 'out', 'amt' => $refundTotal, 'note' => ($isExchange ? 'Exchange refund' : 'Refund') . " for {$sale['invoiceNo']}"],
                ['cond' => $additionalPayment > 0, 'dir' => 'in', 'amt' => $additionalPayment, 'note' => "Exchange top-up for {$sale['invoiceNo']}"],
            ] as $pm) {
                if (!$pm['cond']) {
                    continue;
                }
                $pid = Uuid::v4();
                $ctx->repo()->insert('payments', $pid, [
                    'id' => $pid, 'saleId' => $sale['id'], 'saleReturnId' => $id, 'branchId' => $sale['branchId'],
                    'registerSessionId' => $openReg, 'direction' => $pm['dir'], 'method' => $method, 'amount' => $pm['amt'],
                    'reference' => $ref, 'note' => $pm['note'], 'at' => $now,
                ], ['sale_id' => $sale['id'], 'sale_return_id' => $id, 'branch_id' => $sale['branchId'], 'register_session_id' => $openReg, 'direction' => $pm['dir'], 'method' => $method, 'amount' => $pm['amt'], 'at' => $now]);
            }

            $allItems = $ctx->repo()->allDocs('sale_items', 'sale_id = :s', [':s' => $sale['id']]);
            $fully = array_reduce($allItems, static fn ($c, $i) => $c && ($i['returnedQty'] ?? 0) >= $i['qty'], true);
            $any = array_reduce($allItems, static fn ($c, $i) => $c || ($i['returnedQty'] ?? 0) > 0, false);
            $ctx->repo()->update('sales', $sale['id'], ['status' => $fully ? 'refunded' : ($any ? 'partially_refunded' : $sale['status'])], ['status' => $fully ? 'refunded' : ($any ? 'partially_refunded' : $sale['status'])]);

            if (!empty($sale['customerId'])) {
                $cust = $ctx->repo()->doc('customers', $sale['customerId']);
                if ($cust) {
                    $ctx->repo()->update('customers', $cust['id'], [
                        'totalPurchases' => max(0, ($cust['totalPurchases'] ?? 0) - $returnRefund + $replacementTotal),
                    ]);
                }
            }

            Audit::record($ctx, $isExchange ? 'exchange' : 'refund', 'sale_return', $id, ['after' => $row, 'meta' => ['invoiceNo' => $sale['invoiceNo'], 'refundTotal' => $refundTotal, 'additionalPayment' => $additionalPayment]]);
            Notify::push($ctx, 'refund', $isExchange ? 'Product exchanged' : 'Sale returned',
                "{$ref} - " . ($isExchange ? "exchange against {$sale['invoiceNo']}" : 'refund ' . Money::format($refundTotal) . " against {$sale['invoiceNo']}"),
                ['level' => 'warning', 'link' => "#/sales/{$sale['id']}"]);
            return Response::json($row, 201);
        });
    }

    /* ------------------------------------------------------------ helpers */

    private static function activeTaxes(Context $ctx): array
    {
        return $ctx->repo()->allDocs('taxes', 'archived_at IS NULL');
    }

    /** Active discount rules that are in their date window right now. */
    private static function activeDiscounts(Context $ctx): array
    {
        $now = Clock::now();
        return array_values(array_filter(
            $ctx->repo()->allDocs('discounts', 'archived_at IS NULL'),
            static function (array $d) use ($now) {
                if (($d['status'] ?? 'active') !== 'active') {
                    return false;
                }
                if (!empty($d['startsAt']) && $d['startsAt'] > $now) {
                    return false;
                }
                if (!empty($d['endsAt']) && $d['endsAt'] < $now) {
                    return false;
                }
                return true;
            },
        ));
    }

    /**
     * @return array{autoDiscounts:list<array>,coupon:?array}
     */
    private static function resolveCartDiscounts(Context $ctx, ?string $code): array
    {
        $all = self::activeDiscounts($ctx);
        $auto = array_values(array_map(static fn (array $d) => [
            'id' => $d['id'], 'name' => $d['name'] ?? null, 'type' => $d['type'], 'value' => $d['value'],
            'minSpend' => $d['minSpend'] ?? 0, 'maxDiscount' => $d['maxDiscount'] ?? 0,
            'scope' => $d['scope'] ?? 'cart', 'appliesTo' => $d['appliesTo'] ?? [],
        ], array_filter($all, static fn (array $d) => empty($d['code'])
            && (empty($d['usageLimit']) || ($d['usageCount'] ?? 0) < $d['usageLimit']))));

        $coupon = null;
        $wanted = strtoupper(trim((string) $code));
        if ($wanted !== '') {
            $match = null;
            foreach ($all as $d) {
                if (!empty($d['code']) && strtoupper($d['code']) === $wanted) {
                    $match = $d;
                }
            }
            if (!$match) {
                throw HttpError::badRequest("Coupon \"{$wanted}\" is no longer valid.");
            }
            if (!empty($match['usageLimit']) && ($match['usageCount'] ?? 0) >= $match['usageLimit']) {
                throw HttpError::conflict('This coupon has reached its usage limit.');
            }
            $coupon = [
                'id' => $match['id'], 'code' => $match['code'], 'name' => $match['name'] ?? null,
                'type' => $match['type'], 'value' => $match['value'],
                'minSpend' => $match['minSpend'] ?? 0, 'maxDiscount' => $match['maxDiscount'] ?? 0,
                'scope' => $match['scope'] ?? 'cart', 'appliesTo' => $match['appliesTo'] ?? [],
            ];
        }
        return ['autoDiscounts' => $auto, 'coupon' => $coupon];
    }

    private static function buildCartLines(Context $ctx, ?array $rawItems): array
    {
        if (!$rawItems) {
            throw HttpError::badRequest('The cart is empty. Add at least one product.');
        }
        $out = [];
        foreach ($rawItems as $it) {
            $product = $ctx->repo()->doc('products', $it['productId'] ?? '') ?? throw HttpError::badRequest('A product in the cart no longer exists.');
            if (!empty($product['archivedAt'])) {
                throw HttpError::badRequest("\"{$product['name']}\" has been archived and cannot be sold.");
            }
            $variant = null;
            if (!empty($it['variantId'])) {
                foreach ($product['variants'] ?? [] as $v) {
                    if ($v['id'] === $it['variantId']) {
                        $variant = $v;
                    }
                }
                if (!$variant) {
                    throw HttpError::badRequest("A selected variant of \"{$product['name']}\" no longer exists.");
                }
            }
            $qty = (int) ($it['qty'] ?? 0);
            if ($qty <= 0 || $qty != ($it['qty'] ?? 0)) {
                throw HttpError::badRequest("Quantity for \"{$product['name']}\" must be a whole number greater than 0.");
            }
            $basePrice = $variant ? $variant['sellingPrice'] : ($product['discountPrice'] ?? $product['sellingPrice']);
            $unitPrice = isset($it['unitPriceOverride']) ? max(0, (int) $it['unitPriceOverride']) : $basePrice;
            $out[] = [
                'productId' => $product['id'], 'variantId' => $variant['id'] ?? null, 'name' => $product['name'],
                'categoryId' => $product['categoryId'] ?? null,
                'variantLabel' => $variant ? ($variant['name'] ?: $variant['sku']) : null,
                'sku' => $variant['sku'] ?? $product['sku'], 'barcode' => $variant['barcode'] ?? $product['barcode'],
                'unit' => $product['unit'] ?? 'pcs', 'unitPrice' => (int) $unitPrice,
                'costPrice' => (int) ($variant['costPrice'] ?? $product['costPrice']), 'qty' => $qty,
                'discountType' => $it['discountType'] ?? null, 'discountValue' => $it['discountValue'] ?? 0,
                'taxId' => $it['taxId'] ?? $product['taxId'] ?? null,
                'trackInventory' => ($product['trackInventory'] ?? true) !== false,
            ];
        }
        return $out;
    }

    private static function assertAvailability(Context $ctx, array $lines, string $branchId, bool $allowNegative): void
    {
        if ($allowNegative) {
            return;
        }
        $need = [];
        foreach ($lines as $l) {
            if (!$l['trackInventory']) {
                continue;
            }
            $key = $l['productId'] . ':' . ($l['variantId'] ?: 'base');
            $need[$key] = ($need[$key] ?? 0) + $l['qty'];
        }
        foreach ($need as $key => $qty) {
            [$productId, $variantRaw] = explode(':', $key);
            $variantId = $variantRaw === 'base' ? null : $variantRaw;
            $available = Ledger::qty($ctx, $branchId, $productId, $variantId);
            if ($available < $qty) {
                $p = $ctx->repo()->doc('products', $productId);
                throw HttpError::conflict("Stock is insufficient for \"" . ($p['name'] ?? $productId) . "\". Available {$available}, cart needs {$qty}.");
            }
        }
    }

    private static function decorate(Context $ctx, array $sale): array
    {
        $customer = !empty($sale['customerId']) ? $ctx->repo()->doc('customers', $sale['customerId']) : null;
        $branch = $ctx->repo()->doc('branches', $sale['branchId']);
        $returns = $ctx->repo()->allDocs('sale_returns', 'sale_id = :s', [':s' => $sale['id']]);
        return array_merge($sale, [
            'customerName' => $customer['name'] ?? $sale['customerName'] ?? 'Walk-in Customer',
            'customerPhone' => $customer['phone'] ?? $sale['customerPhone'] ?? null,
            'branchName' => $branch['name'] ?? null,
            'returnedTotal' => array_sum(array_map(static fn ($r) => $r['refundTotal'] ?? 0, $returns)),
        ]);
    }
}
