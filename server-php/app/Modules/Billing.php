<?php
declare(strict_types=1);

namespace Afia\Modules;

use Afia\App;
use Afia\Context;
use Afia\Http\Response;
use Afia\Http\Router;
use Afia\Support\Audit;
use Afia\Support\Clock;
use Afia\Support\Gateway;
use Afia\Support\HttpError;
use Afia\Support\Provision;
use Afia\Support\Uuid;

/**
 * A merchant's own subscription & payments (self-service, tenant-scoped).
 *   GET  /billing/summary        - plan, charges, next billing, amount due,
 *                                  branch usage, recent payments, gateway info
 *   POST /billing/pay            - pay the setup fee or a monthly charge
 *   POST /billing/branch-request - request + pay for an extra branch (phase 5)
 *
 * The amount is computed server-side from the subscription; the client never
 * sends it.
 */
final class Billing
{
    public static function register(Router $r, App $app): void
    {
        $r->get('/billing/summary', fn (Context $c) => self::summary($c));
        $r->post('/billing/pay', fn (Context $c) => self::pay($c));
        $r->post('/billing/branch-request', fn (Context $c) => self::branchRequest($c));
        $r->post('/billing/payments/:id/cancel', fn (Context $c, $p) => self::cancel($c, $p));
    }

    private const MAX_PROOF = 2_800_000; // ~2 MB as a data URL

    private const TYPE_LABEL = [
        'initial' => 'Initial plan purchase',
        'monthly' => 'Monthly server & backup charge',
        'branch' => 'Additional branch',
    ];

    /** Validate + extract a manual payment submission. */
    private static function readPaymentFields(Context $ctx, array $b, string $driver): array
    {
        $methods = Provision::platformSettings($ctx->db)['paymentMethods'] ?? [];
        $methodId = isset($b['methodId']) ? (string) $b['methodId'] : null;
        $rec = null;
        foreach ($methods as $m) {
            if (($m['id'] ?? null) === $methodId) {
                $rec = $m;
            }
        }
        if ($methodId !== null && $rec === null) {
            throw HttpError::badRequest('Unknown payment method.', ['methodId' => 'Unknown']);
        }
        if ($rec !== null && ($rec['status'] ?? 'enabled') === 'disabled') {
            throw HttpError::badRequest('That payment method is not available.', ['methodId' => 'Unavailable']);
        }
        $method = (string) ($b['method'] ?? ($rec['name'] ?? 'manual'));
        $reference = isset($b['reference']) ? trim((string) $b['reference']) : '';
        $accountNumber = isset($b['accountNumber']) ? trim((string) $b['accountNumber']) : '';
        $proofImage = isset($b['proofImage']) ? (string) $b['proofImage'] : '';
        if ($driver === 'manual') {
            if ($reference === '') {
                throw HttpError::badRequest('Enter the transaction ID from your payment.', ['reference' => 'Required']);
            }
            if ($accountNumber === '') {
                throw HttpError::badRequest('Enter the phone / account number you paid from.', ['accountNumber' => 'Required']);
            }
        }
        if ($proofImage !== '' && strlen($proofImage) > self::MAX_PROOF) {
            throw HttpError::badRequest('The proof image is too large — keep it under 2 MB.', ['proofImage' => 'Too large']);
        }
        return [
            'methodId' => $methodId,
            'method' => $method,
            'reference' => $reference !== '' ? $reference : null,
            'accountNumber' => $accountNumber !== '' ? $accountNumber : null,
            'proofImage' => $proofImage !== '' ? $proofImage : null,
            'note' => isset($b['note']) && trim((string) $b['note']) !== '' ? trim((string) $b['note']) : null,
            'paidAt' => isset($b['paidAt']) ? (string) $b['paidAt'] : null,
        ];
    }

    /** Prefilled WhatsApp link to POS TXbd for a just-submitted payment. */
    private static function whatsappLink(Context $ctx, string $mid, string $type, int $amount, ?string $reference, string $method, ?string $planOrBranch): ?string
    {
        $wa = preg_replace('/[^0-9]/', '', (string) (Provision::platformSettings($ctx->db)['contact']['whatsapp'] ?? ''));
        if ($wa === '') {
            return null;
        }
        $bizRow = $ctx->db->first('SELECT doc FROM businesses WHERE merchant_id = :m', [':m' => $mid]);
        $biz = $bizRow ? (json_decode($bizRow['doc'], true)['name'] ?? 'my business') : 'my business';
        $lines = array_filter([
            'Hello POS TXbd Team,', '',
            'I have submitted a payment request.', '',
            'Business: ' . $biz,
            'Payment Type: ' . (self::TYPE_LABEL[$type] ?? $type),
            $planOrBranch ? 'Plan / Branch: ' . $planOrBranch : null,
            'Amount: ৳' . number_format($amount / 100),
            $reference ? 'Transaction ID: ' . $reference : null,
            'Payment Method: ' . $method, '',
            'My payment request has been submitted and is currently pending approval.',
            'Please verify and approve my request as soon as possible.',
        ], static fn ($x) => $x !== null);
        return 'https://wa.me/' . $wa . '?text=' . rawurlencode(implode("\n", $lines));
    }

    private static function merchantId(Context $ctx): string
    {
        $ctx->requireActor();
        $mid = $ctx->merchantId ?? '';
        if ($mid === '') {
            throw HttpError::badRequest('This account has no merchant subscription.');
        }
        return $mid;
    }

    private static function subscription(Context $ctx, string $mid): ?array
    {
        $row = $ctx->db->first('SELECT doc FROM subscriptions WHERE merchant_id = :m', [':m' => $mid]);
        return $row ? json_decode($row['doc'], true) : null;
    }

    private static function summaryPayload(Context $ctx, string $mid): array
    {
        $sub = self::subscription($ctx, $mid);
        $now = Clock::now();
        $status = $sub ? Platform::liveStatus($sub, $now, Platform::graceDays($ctx)) : 'none';
        $branchesUsed = 0;
        foreach ($ctx->db->all('SELECT doc FROM branches WHERE merchant_id = :m', [':m' => $mid]) as $b) {
            if (empty(json_decode($b['doc'], true)['archivedAt'])) {
                $branchesUsed++;
            }
        }
        $pays = array_map(
            static fn ($x) => json_decode($x['doc'], true),
            $ctx->db->all('SELECT doc FROM subscription_payments WHERE merchant_id = :m ORDER BY at DESC LIMIT 20', [':m' => $mid]),
        );
        $included = (int) ($sub['includedBranches'] ?? 1);
        $extra = (int) ($sub['extraBranchesPaid'] ?? 0);
        return [
            'subscription' => $sub ? [
                'planId' => $sub['planId'] ?? null, 'planName' => $sub['planName'] ?? null,
                'status' => $status, 'billingPeriod' => $sub['billingPeriod'] ?? 'monthly',
                'setupPrice' => (int) ($sub['setupPrice'] ?? 0), 'setupPaid' => !empty($sub['setupPaid']),
                'monthlyPrice' => (int) ($sub['monthlyPrice'] ?? $sub['planPrice'] ?? 0),
                'startedAt' => $sub['startedAt'] ?? null, 'expiresAt' => $sub['expiresAt'] ?? null,
                'nextBillingAt' => $sub['nextBillingAt'] ?? ($sub['expiresAt'] ?? null),
                'lastPaymentAt' => $sub['lastPaymentAt'] ?? null,
                'daysLeft' => !empty($sub['expiresAt'])
                    ? (int) ceil(((new \DateTimeImmutable($sub['expiresAt']))->getTimestamp() - (new \DateTimeImmutable($now))->getTimestamp()) / 86400)
                    : null,
                'dueAmount' => Platform::dueAmount($sub, $status),
            ] : null,
            'branches' => ['used' => $branchesUsed, 'included' => $included, 'extraPaid' => $extra, 'limit' => $included + $extra],
            'gateway' => Gateway::active($ctx->db),
            'paymentMethods' => Provision::enabledPaymentMethods($ctx->db),
            'payments' => $pays,
            'branchRequests' => array_map(
                static fn ($x) => json_decode($x['doc'], true),
                $ctx->db->all('SELECT doc FROM branch_requests WHERE merchant_id = :m ORDER BY at DESC', [':m' => $mid]),
            ),
            'extraBranchPrice' => $sub ? Provision::extraBranchPrice($ctx->db, $sub) : 0,
        ];
    }

    private static function summary(Context $ctx): Response
    {
        return Response::json(self::summaryPayload($ctx, self::merchantId($ctx)));
    }

    private static function pay(Context $ctx): Response
    {
        $mid = self::merchantId($ctx);
        $sub = self::subscription($ctx, $mid) ?? throw HttpError::notFound('Subscription');
        $b = $ctx->body();
        $type = in_array($b['type'] ?? null, ['initial', 'monthly'], true) ? $b['type'] : null;
        if ($type === null) {
            throw HttpError::badRequest('type must be "initial" or "monthly"');
        }
        if ($type === 'initial' && !empty($sub['setupPaid'])) {
            throw HttpError::badRequest('The setup fee is already paid.');
        }
        $amount = $type === 'initial'
            ? (int) ($sub['setupPrice'] ?? 0)
            : (int) ($sub['monthlyPrice'] ?? $sub['planPrice'] ?? 0);
        if ($amount <= 0) {
            throw HttpError::badRequest('Nothing to pay for this item.');
        }
        $charge = Gateway::charge($ctx->db, ['merchantId' => $mid, 'type' => $type, 'amount' => $amount]);
        $f = self::readPaymentFields($ctx, $b, $charge['driver']);
        $id = Uuid::v4();
        $now = Clock::now();
        $subId = $ctx->db->value('SELECT id FROM subscriptions WHERE merchant_id = :m', [':m' => $mid]);
        $doc = [
            'id' => $id, 'merchantId' => $mid, 'subscriptionId' => $subId, 'planId' => $sub['planId'] ?? null,
            'type' => $type, 'status' => $charge['status'], 'amount' => $amount,
            'method' => $f['method'], 'methodId' => $f['methodId'], 'reference' => $f['reference'],
            'accountNumber' => $f['accountNumber'], 'proofImage' => $f['proofImage'], 'note' => $f['note'], 'paidAt' => $f['paidAt'],
            'gatewayRef' => $charge['gatewayRef'], 'gatewayDriver' => $charge['driver'],
            'adminNote' => $charge['status'] === 'pending' ? 'Awaiting approval' : '',
            'submittedBy' => $ctx->actor['name'] ?? 'Merchant',
            'confirmedBy' => $charge['status'] === 'paid' ? 'Gateway' : null,
            'confirmedAt' => $charge['status'] === 'paid' ? $now : null,
            'periodStart' => $now, 'periodEnd' => $sub['expiresAt'] ?? null,
            'at' => $now, 'createdAt' => $now, 'updatedAt' => $now,
        ];
        $ctx->db->run(
            'INSERT INTO subscription_payments (id, merchant_id, subscription_id, plan_id, type, status, amount, method, period_start, period_end, at, doc, created_at, updated_at)
             VALUES (:id,:m,:sid,:pid,:ty,:st,:amt,:mth,:ps,:pe,:at,:d,:c,:c)',
            [':id' => $id, ':m' => $mid, ':sid' => $subId, ':pid' => $doc['planId'], ':ty' => $type, ':st' => $charge['status'], ':amt' => $amount,
             ':mth' => $f['method'], ':ps' => $now, ':pe' => $doc['periodEnd'], ':at' => $now, ':d' => json_encode($doc), ':c' => $now],
        );
        if ($charge['status'] === 'paid') {
            Platform::applyConfirmedPayment($ctx, $doc);
        } else {
            Platform::notifyPaymentRequest($ctx, $doc, $sub['planName'] ?? null);
        }
        Audit::record($ctx, 'create', 'subscription_payment', $id, ['meta' => ['self' => true, 'type' => $type, 'status' => $charge['status']]]);
        return Response::json([
            'payment' => $doc,
            'summary' => self::summaryPayload($ctx, $mid),
            'whatsapp' => self::whatsappLink($ctx, $mid, $type, $amount, $f['reference'], $f['method'], $sub['planName'] ?? null),
        ], 201);
    }

    private static function branchRequest(Context $ctx): Response
    {
        $mid = self::merchantId($ctx);
        $sub = self::subscription($ctx, $mid) ?? throw HttpError::notFound('Subscription');
        $b = $ctx->body();
        $name = trim((string) ($b['name'] ?? ''));
        if ($name === '') {
            throw HttpError::badRequest('Branch name is required', ['name' => 'Required']);
        }
        $price = Provision::extraBranchPrice($ctx->db, $sub);
        if ($price <= 0) {
            throw HttpError::badRequest('Additional branches are not priced for this plan — contact support.');
        }
        $now = Clock::now();
        $charge = Gateway::charge($ctx->db, ['merchantId' => $mid, 'type' => 'branch', 'amount' => $price]);
        $f = self::readPaymentFields($ctx, $b, $charge['driver']);

        $reqId = Uuid::v4();
        $payId = Uuid::v4();
        $reqDoc = [
            'id' => $reqId, 'merchantId' => $mid, 'name' => $name,
            'code' => trim((string) ($b['code'] ?? '')) ?: null,
            'address' => trim((string) ($b['address'] ?? '')),
            'price' => $price, 'status' => 'pending', 'paymentId' => $payId, 'branchId' => null,
            'at' => $now, 'createdAt' => $now, 'updatedAt' => $now,
        ];
        $ctx->db->run('INSERT INTO branch_requests (id, merchant_id, status, at, doc, created_at, updated_at) VALUES (:id,:m,:s,:at,:d,:c,:c)',
            [':id' => $reqId, ':m' => $mid, ':s' => 'pending', ':at' => $now, ':d' => json_encode($reqDoc), ':c' => $now]);

        $subId = $ctx->db->value('SELECT id FROM subscriptions WHERE merchant_id = :m', [':m' => $mid]);
        $payDoc = [
            'id' => $payId, 'merchantId' => $mid, 'subscriptionId' => $subId, 'planId' => $sub['planId'] ?? null,
            'type' => 'branch', 'status' => $charge['status'], 'amount' => $price,
            'method' => $f['method'], 'methodId' => $f['methodId'], 'reference' => $f['reference'], 'branchRef' => $reqId,
            'accountNumber' => $f['accountNumber'], 'proofImage' => $f['proofImage'], 'note' => $f['note'], 'paidAt' => $f['paidAt'],
            'gatewayRef' => $charge['gatewayRef'], 'gatewayDriver' => $charge['driver'],
            'adminNote' => $charge['status'] === 'pending' ? 'Additional branch — awaiting approval' : 'Additional branch',
            'submittedBy' => $ctx->actor['name'] ?? 'Merchant',
            'confirmedBy' => $charge['status'] === 'paid' ? 'Gateway' : null,
            'confirmedAt' => $charge['status'] === 'paid' ? $now : null,
            'periodStart' => $now, 'periodEnd' => $sub['expiresAt'] ?? null,
            'at' => $now, 'createdAt' => $now, 'updatedAt' => $now,
        ];
        $ctx->db->run(
            'INSERT INTO subscription_payments (id, merchant_id, subscription_id, plan_id, type, status, amount, method, period_start, period_end, at, doc, created_at, updated_at)
             VALUES (:id,:m,:sid,:pid,:ty,:st,:amt,:mth,:ps,:pe,:at,:d,:c,:c)',
            [':id' => $payId, ':m' => $mid, ':sid' => $subId, ':pid' => $payDoc['planId'], ':ty' => 'branch', ':st' => $charge['status'], ':amt' => $price,
             ':mth' => $f['method'], ':ps' => $now, ':pe' => $payDoc['periodEnd'], ':at' => $now, ':d' => json_encode($payDoc), ':c' => $now],
        );
        if ($charge['status'] === 'paid') {
            Platform::applyConfirmedPayment($ctx, $payDoc);
        } else {
            Platform::notifyPaymentRequest($ctx, $payDoc, $name);
        }
        Audit::record($ctx, 'create', 'branch_request', $reqId, ['meta' => ['status' => $charge['status'], 'price' => $price]]);
        $freshReq = $ctx->db->first('SELECT doc FROM branch_requests WHERE id = :id', [':id' => $reqId]);
        return Response::json([
            'request' => $freshReq ? json_decode($freshReq['doc'], true) : $reqDoc,
            'payment' => $payDoc,
            'summary' => self::summaryPayload($ctx, $mid),
            'whatsapp' => self::whatsappLink($ctx, $mid, 'branch', $price, $f['reference'], $f['method'], $name),
        ], 201);
    }

    private static function cancel(Context $ctx, array $params): Response
    {
        $mid = self::merchantId($ctx);
        $row = $ctx->db->first('SELECT doc FROM subscription_payments WHERE id = :id AND merchant_id = :m', [':id' => $params['id'], ':m' => $mid]);
        if (!$row) {
            throw HttpError::notFound('Payment');
        }
        $pay = json_decode($row['doc'], true);
        if (($pay['status'] ?? 'pending') !== 'pending') {
            throw HttpError::badRequest('Only a pending request can be cancelled.');
        }
        $now = Clock::now();
        $pay['status'] = 'cancelled';
        $pay['cancelledAt'] = $now;
        $pay['updatedAt'] = $now;
        $ctx->db->run('UPDATE subscription_payments SET status = :s, doc = :d, updated_at = :u WHERE id = :id',
            [':s' => 'cancelled', ':d' => json_encode($pay), ':u' => $now, ':id' => $pay['id']]);
        if (!empty($pay['branchRef'])) {
            $br = $ctx->db->first('SELECT doc FROM branch_requests WHERE id = :id', [':id' => $pay['branchRef']]);
            if ($br) {
                $brDoc = json_decode($br['doc'], true);
                if (($brDoc['status'] ?? '') === 'pending') {
                    $brDoc['status'] = 'rejected';
                    $brDoc['updatedAt'] = $now;
                    $ctx->db->run('UPDATE branch_requests SET status = :s, doc = :d, updated_at = :u WHERE id = :id',
                        [':s' => 'rejected', ':d' => json_encode($brDoc), ':u' => $now, ':id' => $brDoc['id']]);
                }
            }
        }
        Audit::record($ctx, 'update', 'subscription_payment', $pay['id'], ['meta' => ['status' => 'cancelled', 'self' => true]]);
        return Response::json(['payment' => $pay, 'summary' => self::summaryPayload($ctx, $mid)]);
    }
}
