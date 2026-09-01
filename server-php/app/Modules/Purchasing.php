<?php
declare(strict_types=1);

namespace Afia\Modules;

use Afia\App;
use Afia\Context;
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
use Afia\Support\Resource;
use Afia\Support\Uuid;

/** Suppliers, purchases (with receiving), purchase returns. Ported from purchasing.routes.js. */
final class Purchasing
{
    public static function register(Router $r, App $app): void
    {
        Resource::register($r, $app, [
            'base' => '/suppliers', 'table' => 'suppliers', 'entity' => 'supplier',
            'perms' => ['view' => 'purchases.view', 'create' => 'suppliers.manage', 'edit' => 'suppliers.manage'],
            'list' => ['searchCols' => ['name', 'phone'], 'sortMap' => ['name' => 'name', 'createdAt' => 'created_at'], 'defaultSort' => 'name', 'defaultDir' => 'asc', 'filters' => ['status' => 'status']],
            'columns' => static fn (array $d) => ['name' => $d['name'] ?? '', 'phone' => $d['phone'] ?? null, 'status' => $d['status'] ?? 'active'],
            'normalize' => static function (array $b, ?array $e) {
                if ($e === null) {
                    return [
                        'name' => trim((string) ($b['name'] ?? '')), 'phone' => $b['phone'] ?? '', 'email' => $b['email'] ?? '',
                        'company' => $b['company'] ?? '', 'address' => $b['address'] ?? '',
                        'openingBalance' => (int) ($b['openingBalance'] ?? 0), 'currentBalance' => (int) ($b['openingBalance'] ?? 0),
                        'status' => $b['status'] ?? 'active', 'note' => $b['note'] ?? '',
                    ];
                }
                return array_merge($e, array_filter([
                    'name' => isset($b['name']) ? trim((string) $b['name']) : null, 'phone' => $b['phone'] ?? null,
                    'email' => $b['email'] ?? null, 'company' => $b['company'] ?? null, 'address' => $b['address'] ?? null,
                    'note' => $b['note'] ?? null, 'status' => $b['status'] ?? null,
                ], static fn ($v) => $v !== null));
            },
            'decorate' => static function (Context $ctx, array $s) {
                $purchases = $ctx->repo()->allDocs('purchases', 'supplier_id = :x', [':x' => $s['id']]);
                $s['totalPurchases'] = array_sum(array_map(static fn ($p) => $p['grandTotal'] ?? 0, $purchases));
                $s['purchaseCount'] = count($purchases);
                return $s;
            },
        ]);

        $r->get('/suppliers/:id/statement', fn (Context $c, $p) => self::statement($c, $p));
        $r->post('/suppliers/:id/payments', fn (Context $c, $p) => self::supplierPayment($c, $p));

        $r->get('/purchases', fn (Context $c) => self::listPurchases($c));
        $r->get('/purchases/:id', fn (Context $c, $p) => self::getPurchase($c, $p));
        $r->post('/purchases', fn (Context $c) => self::createPurchase($c));
        $r->patch('/purchases/:id', fn (Context $c, $p) => self::updatePurchase($c, $p));
        $r->post('/purchases/:id/receive', fn (Context $c, $p) => self::receive($c, $p));
        $r->post('/purchases/:id/cancel', fn (Context $c, $p) => self::cancel($c, $p));

        $r->get('/purchase-returns', fn (Context $c) => self::listPurchaseReturns($c));
        $r->post('/purchases/:id/returns', fn (Context $c, $p) => self::purchaseReturn($c, $p));
    }

    /* ------------------------------------------------------------ suppliers */

    private static function statement(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('purchases.view');
        $supplier = $ctx->repo()->doc('suppliers', $p['id']) ?? throw HttpError::notFound('Supplier');
        $entries = [];
        foreach ($ctx->repo()->allDocs('purchases', 'supplier_id = :x', [':x' => $p['id']]) as $pu) {
            $entries[] = ['type' => 'purchase', 'ref' => $pu['reference'], 'amount' => $pu['grandTotal'], 'paid' => $pu['paidTotal'] ?? 0, 'at' => $pu['createdAt']];
        }
        foreach ($ctx->repo()->allDocs('supplier_payments', 'supplier_id = :x', [':x' => $p['id']]) as $pm) {
            $entries[] = ['type' => 'payment', 'ref' => $pm['reference'], 'amount' => $pm['amount'], 'at' => $pm['at']];
        }
        usort($entries, static fn ($a, $b) => strcmp($a['at'], $b['at']));
        return Response::json(['supplier' => $supplier, 'entries' => $entries]);
    }

    private static function supplierPayment(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('purchases.edit');
        $supplier = $ctx->repo()->doc('suppliers', $p['id']) ?? throw HttpError::notFound('Supplier');
        $b = $ctx->body();
        $amount = (int) ($b['amount'] ?? 0);
        if ($amount <= 0) {
            throw HttpError::badRequest('Payment amount must be greater than zero');
        }
        return $ctx->db->transaction(function () use ($ctx, $p, $supplier, $b, $amount) {
            $ref = DocNo::next($ctx->repo(), 'supplier_payment', 'SPMT-{YY}{MM}-{SEQ}', ['seqWidth' => 4]);
            $id = Uuid::v4();
            $doc = ['id' => $id, 'reference' => $ref, 'supplierId' => $p['id'], 'amount' => $amount, 'method' => $b['method'] ?? 'cash', 'note' => $b['note'] ?? '', 'at' => Clock::now()];
            $row = $ctx->repo()->insert('supplier_payments', $id, $doc, ['reference' => $ref, 'supplier_id' => $p['id'], 'amount' => $amount, 'at' => $doc['at']]);
            $ctx->repo()->update('suppliers', $p['id'], ['currentBalance' => ($supplier['currentBalance'] ?? 0) - $amount]);
            Audit::record($ctx, 'create', 'supplier_payment', $id, ['after' => $row]);
            return Response::json($row, 201);
        });
    }

    /* ------------------------------------------------------------ purchases */

    private static function computePurchase(array $lines, int $freight = 0): array
    {
        $subtotal = 0;
        $discountTotal = 0;
        $taxTotal = 0;
        $items = array_map(static function ($l) use (&$subtotal, &$discountTotal, &$taxTotal) {
            $qty = (int) ($l['qty'] ?? 0);
            $gross = Money::mul((int) ($l['unitCost'] ?? 0), $qty);
            $disc = ($l['discountType'] ?? null) === 'percent'
                ? Money::percent($gross, (float) ($l['discountValue'] ?? 0))
                : Money::mul((int) ($l['discountValue'] ?? 0), $qty);
            $net = max(0, $gross - $disc);
            $tax = !empty($l['taxRate']) ? Money::percent($net, (float) $l['taxRate']) : 0;
            $subtotal += $gross;
            $discountTotal += $disc;
            $taxTotal += $tax;
            return array_merge($l, [
                'id' => $l['id'] ?? Uuid::v4(), 'qty' => $qty, 'gross' => $gross, 'discount' => $disc, 'tax' => $tax,
                'lineTotal' => $net + $tax, 'receivedQty' => $l['receivedQty'] ?? 0, 'returnedQty' => $l['returnedQty'] ?? 0,
            ]);
        }, $lines);
        $freightTotal = max(0, $freight);
        return [
            'items' => $items, 'subtotal' => $subtotal, 'discountTotal' => $discountTotal, 'taxTotal' => $taxTotal,
            'freightTotal' => $freightTotal, 'grandTotal' => $subtotal - $discountTotal + $taxTotal + $freightTotal,
        ];
    }

    private static function decorate(Context $ctx, array $p): array
    {
        $p['supplierName'] = $ctx->repo()->doc('suppliers', $p['supplierId'] ?? '')['name'] ?? '-';
        $p['branchName'] = $ctx->repo()->doc('branches', $p['branchId'] ?? '')['name'] ?? null;
        return $p;
    }

    private static function listPurchases(Context $ctx): Response
    {
        $ctx->requirePermission('purchases.view');
        $q = $ctx->request->query;
        $where = ['1=1'];
        $params = [];
        foreach (['supplierId' => 'supplier_id', 'branchId' => 'branch_id', 'status' => 'status'] as $k => $c) {
            if (!empty($q[$k]) && $q[$k] !== 'all') {
                $where[] = "{$c} = :{$c}";
                $params[":{$c}"] = $q[$k];
            }
        }
        $result = $ctx->repo()->list([
            'table' => 'purchases', 'query' => $q, 'baseWhere' => implode(' AND ', $where), 'params' => $params,
            'searchCols' => ['reference'], 'sortMap' => ['createdAt' => 'created_at', 'reference' => 'reference', 'grandTotal' => 'grand_total', 'status' => 'status'],
            'defaultSort' => 'createdAt', 'defaultDir' => 'desc', 'dateColumn' => 'created_at',
            'summarize' => static fn ($list) => [
                'orders' => count($list),
                'totalValue' => array_sum(array_map(static fn ($r) => (int) ($r['grandTotal'] ?? 0), $list)),
                'outstandingPayable' => array_sum(array_map(static fn ($r) => (int) ($r['dueTotal'] ?? 0), $list)),
            ],
        ]);
        $result['data'] = array_map(fn ($p) => self::decorate($ctx, $p), $result['data']);
        return Response::json($result);
    }

    private static function getPurchase(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('purchases.view');
        $row = $ctx->repo()->doc('purchases', $p['id']) ?? throw HttpError::notFound('Purchase');
        return Response::json(self::decorate($ctx, $row));
    }

    private static function createPurchase(Context $ctx): Response
    {
        $ctx->requirePermission('purchases.create');
        $b = $ctx->body();
        $branch = Branch::require($ctx, $b['branchId'] ?? null);
        $supplier = $ctx->repo()->doc('suppliers', $b['supplierId'] ?? '') ?? throw HttpError::badRequest('Select a supplier', ['supplierId' => 'Required']);
        if (empty($b['lines'])) {
            throw HttpError::badRequest('Add at least one product line', ['lines' => 'Required']);
        }
        $calc = self::computePurchase($b['lines'], (int) ($b['freight'] ?? 0));
        $paid = (int) ($b['paidTotal'] ?? 0);
        if ($paid > $calc['grandTotal']) {
            throw HttpError::badRequest('Paid amount exceeds the purchase total');
        }
        return $ctx->db->transaction(function () use ($ctx, $b, $branch, $supplier, $calc, $paid) {
            $ref = DocNo::next($ctx->repo(), 'purchase', 'PO-{YY}{MM}-{SEQ}', ['seqWidth' => 4]);
            $status = ($b['status'] ?? null) === 'draft' ? 'draft' : 'ordered';
            $id = Uuid::v4();
            $doc = [
                'id' => $id, 'reference' => $ref, 'branchId' => $branch['id'], 'supplierId' => $supplier['id'],
                'invoiceRef' => $b['invoiceRef'] ?? '', 'note' => $b['note'] ?? '',
                'lines' => $calc['items'], 'subtotal' => $calc['subtotal'], 'discountTotal' => $calc['discountTotal'],
                'taxTotal' => $calc['taxTotal'], 'freightTotal' => $calc['freightTotal'], 'grandTotal' => $calc['grandTotal'],
                'paidTotal' => $paid, 'dueTotal' => $calc['grandTotal'] - $paid, 'status' => $status,
                'expectedAt' => $b['expectedAt'] ?? null, 'createdAt' => Clock::now(), 'receivedAt' => null,
            ];
            $row = $ctx->repo()->insert('purchases', $id, $doc, ['reference' => $ref, 'branch_id' => $branch['id'], 'supplier_id' => $supplier['id'], 'status' => $status, 'grand_total' => $calc['grandTotal']]);
            $ctx->repo()->update('suppliers', $supplier['id'], ['currentBalance' => ($supplier['currentBalance'] ?? 0) + ($calc['grandTotal'] - $paid)]);
            Audit::record($ctx, 'create', 'purchase', $id, ['after' => $row, 'meta' => ['reference' => $ref]]);
            return Response::json(self::decorate($ctx, $row), 201);
        });
    }

    private static function updatePurchase(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('purchases.edit');
        $existing = $ctx->repo()->doc('purchases', $p['id']) ?? throw HttpError::notFound('Purchase');
        if (in_array($existing['status'], ['received', 'cancelled'], true)) {
            throw HttpError::conflict("A {$existing['status']} purchase cannot be edited.");
        }
        $b = $ctx->body();
        return $ctx->db->transaction(function () use ($ctx, $p, $existing, $b) {
            $patch = $b;
            unset($patch['freight']);
            if (!empty($b['lines'])) {
                $freight = (int) ($b['freight'] ?? $existing['freightTotal'] ?? 0);
                $calc = self::computePurchase($b['lines'], $freight);
                $patch = array_merge($patch, [
                    'lines' => $calc['items'], 'subtotal' => $calc['subtotal'], 'discountTotal' => $calc['discountTotal'],
                    'taxTotal' => $calc['taxTotal'], 'freightTotal' => $calc['freightTotal'], 'grandTotal' => $calc['grandTotal'],
                    'dueTotal' => $calc['grandTotal'] - ($b['paidTotal'] ?? $existing['paidTotal']),
                ]);
            }
            $row = $ctx->repo()->update('purchases', $p['id'], $patch, ['status' => $patch['status'] ?? $existing['status'], 'grand_total' => $patch['grandTotal'] ?? $existing['grandTotal']]);
            Audit::record($ctx, 'update', 'purchase', $p['id'], ['before' => $existing, 'after' => $row]);
            return Response::json(self::decorate($ctx, $row));
        });
    }

    private static function receive(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('purchases.receive');
        $purchase = $ctx->repo()->doc('purchases', $p['id']) ?? throw HttpError::notFound('Purchase');
        if ($purchase['status'] === 'cancelled') {
            throw HttpError::conflict('This purchase was cancelled.');
        }
        if ($purchase['status'] === 'received') {
            throw HttpError::conflict('This purchase is already fully received.');
        }
        $b = $ctx->body();
        $receiveLines = $b['lines'] ?? array_map(static fn ($l) => ['lineId' => $l['id'] ?? $l['productId'], 'qty' => $l['qty'] - ($l['receivedQty'] ?? 0)], $purchase['lines']);

        return $ctx->db->transaction(function () use ($ctx, $purchase, $receiveLines) {
            $anyReceived = false;
            $nextLines = array_map(function ($l) use ($ctx, $purchase, $receiveLines, &$anyReceived) {
                $key = $l['id'] ?? $l['productId'];
                $match = null;
                foreach ($receiveLines as $rl) {
                    if (($rl['lineId'] ?? $rl['productId'] ?? null) === $key) {
                        $match = $rl;
                    }
                }
                $receiveQty = $match ? min((int) ($match['qty'] ?? 0), $l['qty'] - ($l['receivedQty'] ?? 0)) : 0;
                if ($receiveQty > 0) {
                    $anyReceived = true;
                    Ledger::post($ctx, [
                        'branchId' => $purchase['branchId'], 'productId' => $l['productId'], 'variantId' => $l['variantId'] ?? null,
                        'type' => 'purchase', 'qtyDelta' => $receiveQty, 'unitCost' => $l['unitCost'],
                        'refType' => 'purchase', 'refId' => $purchase['id'], 'note' => "PO {$purchase['reference']}",
                    ]);
                }
                return array_merge($l, ['receivedQty' => ($l['receivedQty'] ?? 0) + $receiveQty]);
            }, $purchase['lines']);
            if (!$anyReceived) {
                throw HttpError::badRequest('Nothing left to receive on this purchase');
            }
            $fully = array_reduce($nextLines, static fn ($c, $l) => $c && ($l['receivedQty'] ?? 0) >= $l['qty'], true);
            $row = $ctx->repo()->update('purchases', $purchase['id'], [
                'lines' => $nextLines, 'status' => $fully ? 'received' : 'partially_received',
                'receivedAt' => $fully ? Clock::now() : ($purchase['receivedAt'] ?? null),
            ], ['status' => $fully ? 'received' : 'partially_received']);
            Audit::record($ctx, 'receive', 'purchase', $purchase['id'], ['meta' => ['reference' => $purchase['reference'], 'fully' => $fully]]);
            $bn = $ctx->repo()->doc('branches', $purchase['branchId'])['name'] ?? 'branch';
            Notify::push($ctx, 'purchase_received', 'Stock received', "{$purchase['reference']} " . ($fully ? 'fully' : 'partially') . " received into {$bn}.", ['level' => 'success', 'link' => "#/purchases/{$purchase['id']}"]);
            return Response::json(self::decorate($ctx, $row));
        });
    }

    private static function cancel(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('purchases.edit');
        $purchase = $ctx->repo()->doc('purchases', $p['id']) ?? throw HttpError::notFound('Purchase');
        if (in_array($purchase['status'], ['received', 'partially_received'], true)) {
            throw HttpError::conflict('Cannot cancel a purchase that already received stock. Create a purchase return instead.');
        }
        return $ctx->db->transaction(function () use ($ctx, $p, $purchase) {
            $row = $ctx->repo()->update('purchases', $p['id'], ['status' => 'cancelled'], ['status' => 'cancelled']);
            $sup = $ctx->repo()->doc('suppliers', $purchase['supplierId']);
            if ($sup) {
                $ctx->repo()->update('suppliers', $sup['id'], ['currentBalance' => max(0, ($sup['currentBalance'] ?? 0) - ($purchase['dueTotal'] ?? 0))]);
            }
            Audit::record($ctx, 'update', 'purchase', $p['id'], ['meta' => ['action' => 'cancel']]);
            return Response::json(self::decorate($ctx, $row));
        });
    }

    /* ------------------------------------------------------ purchase returns */

    private static function listPurchaseReturns(Context $ctx): Response
    {
        $ctx->requirePermission('purchases.view');
        $q = $ctx->request->query;
        $where = ['1=1'];
        $params = [];
        if (!empty($q['supplierId'])) {
            $where[] = 'supplier_id = :s';
            $params[':s'] = $q['supplierId'];
        }
        return Response::json($ctx->repo()->list([
            'table' => 'purchase_returns', 'query' => $q, 'baseWhere' => implode(' AND ', $where), 'params' => $params,
            'searchCols' => ['reference'], 'sortMap' => ['at' => 'at', 'reference' => 'reference'],
            'defaultSort' => 'at', 'defaultDir' => 'desc', 'dateColumn' => 'at',
        ]));
    }

    private static function purchaseReturn(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('purchases.return');
        $purchase = $ctx->repo()->doc('purchases', $p['id']) ?? throw HttpError::notFound('Purchase');
        $b = $ctx->body();
        $lines = $b['lines'] ?? [];
        if (!$lines) {
            throw HttpError::badRequest('Select items to return');
        }
        return $ctx->db->transaction(function () use ($ctx, $p, $purchase, $b, $lines) {
            $ref = DocNo::next($ctx->repo(), 'purchase_return', 'PRET-{YY}{MM}-{SEQ}', ['seqWidth' => 4]);
            $returnTotal = 0;
            $items = [];
            $pLines = $purchase['lines'];
            foreach ($lines as $line) {
                $key = $line['lineId'] ?? $line['productId'] ?? null;
                $idx = null;
                foreach ($pLines as $i => $pl) {
                    if (($pl['id'] ?? $pl['productId']) === $key) {
                        $idx = $i;
                    }
                }
                if ($idx === null) {
                    throw HttpError::badRequest('A line does not belong to this purchase');
                }
                $pl = $pLines[$idx];
                $qty = (int) ($line['qty'] ?? 0);
                $returnable = ($pl['receivedQty'] ?? 0) - ($pl['returnedQty'] ?? 0);
                if ($qty <= 0) {
                    throw HttpError::badRequest('Invalid return quantity');
                }
                if ($qty > $returnable) {
                    $nm = $ctx->repo()->doc('products', $pl['productId'])['name'] ?? $pl['productId'];
                    throw HttpError::conflict("Only {$returnable} of \"{$nm}\" can be returned.");
                }
                Ledger::post($ctx, [
                    'branchId' => $purchase['branchId'], 'productId' => $pl['productId'], 'variantId' => $pl['variantId'] ?? null,
                    'type' => 'purchase_return', 'qtyDelta' => -$qty, 'unitCost' => $pl['unitCost'],
                    'refType' => 'purchase_return', 'refId' => $ref, 'note' => "Return to supplier - {$purchase['reference']}",
                ]);
                $amount = Money::mul((int) $pl['unitCost'], $qty);
                $returnTotal += $amount;
                $items[] = ['productId' => $pl['productId'], 'variantId' => $pl['variantId'] ?? null, 'name' => $ctx->repo()->doc('products', $pl['productId'])['name'] ?? null, 'qty' => $qty, 'amount' => $amount];
                $pLines[$idx]['returnedQty'] = ($pl['returnedQty'] ?? 0) + $qty;
            }
            $ctx->repo()->update('purchases', $purchase['id'], ['lines' => $pLines]);
            $supplier = $ctx->repo()->doc('suppliers', $purchase['supplierId']);
            $id = Uuid::v4();
            $doc = [
                'id' => $id, 'reference' => $ref, 'purchaseId' => $purchase['id'], 'purchaseRef' => $purchase['reference'],
                'supplierId' => $purchase['supplierId'], 'supplierName' => $supplier['name'] ?? null, 'branchId' => $purchase['branchId'],
                'reason' => $b['reason'] ?? 'defective', 'note' => $b['note'] ?? '', 'items' => $items, 'returnTotal' => $returnTotal,
                'at' => Clock::now(), 'userId' => $ctx->actor['id'], 'userName' => $ctx->actor['name'],
            ];
            $row = $ctx->repo()->insert('purchase_returns', $id, $doc, ['reference' => $ref, 'purchase_id' => $purchase['id'], 'supplier_id' => $purchase['supplierId'], 'branch_id' => $purchase['branchId'], 'at' => $doc['at']]);
            if ($supplier) {
                $ctx->repo()->update('suppliers', $supplier['id'], ['currentBalance' => max(0, ($supplier['currentBalance'] ?? 0) - $returnTotal)]);
            }
            Audit::record($ctx, 'refund', 'purchase_return', $id, ['after' => $row]);
            Notify::push($ctx, 'system', 'Purchase returned', "{$ref} - " . Money::format($returnTotal) . " returned to " . ($supplier['name'] ?? 'supplier') . '.', ['level' => 'info']);
            return Response::json($row, 201);
        });
    }
}
