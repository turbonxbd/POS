<?php
declare(strict_types=1);

namespace Afia\Modules;

use Afia\App;
use Afia\Context;
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

/** Expenses, taxes/VAT, discounts, and the cash register. Ported from finance.routes.js. */
final class Finance
{
    private const EXPENSE_CATEGORIES = ['Rent', 'Electricity', 'Internet', 'Salary', 'Transport', 'Maintenance', 'Marketing', 'Supplies', 'Other'];

    public static function register(Router $r, App $app): void
    {
        $r->get('/expense-categories', static fn () => Response::json(self::EXPENSE_CATEGORIES));

        /* ---- expenses (hard-deletable, generated reference) ---- */
        Resource::register($r, $app, [
            'base' => '/expenses', 'table' => 'expenses', 'entity' => 'expense', 'softDelete' => false, 'except' => ['create'],
            'perms' => ['view' => 'expenses.view', 'create' => 'expenses.manage', 'edit' => 'expenses.manage', 'archive' => 'expenses.manage'],
            'list' => [
                'searchCols' => ['category', 'reference'],
                'sortMap' => ['at' => 'at', 'amount' => 'amount', 'category' => 'category'],
                'defaultSort' => 'at', 'defaultDir' => 'desc',
                'filters' => ['category' => 'category', 'branchId' => 'branch_id'], 'dateColumn' => 'at',
                'summarize' => static fn ($list) => [
                    'totalAmount' => array_sum(array_map(static fn ($e) => (int) ($e['amount'] ?? 0), $list)),
                    'count' => count($list),
                ],
            ],
            'columns' => static fn (array $d) => ['reference' => $d['reference'] ?? null, 'branch_id' => $d['branchId'] ?? null, 'category' => $d['category'] ?? null, 'amount' => (int) ($d['amount'] ?? 0), 'at' => $d['at'] ?? Clock::now()],
            'normalize' => static function (array $b, ?array $e) use ($app) {
                if ($e !== null) {
                    return array_merge($e, array_filter([
                        'description' => $b['description'] ?? null, 'category' => $b['category'] ?? null,
                        'note' => $b['note'] ?? null,
                    ], static fn ($v) => $v !== null));
                }
                if (!in_array($b['category'] ?? null, self::EXPENSE_CATEGORIES, true)) {
                    throw HttpError::badRequest('Choose a valid expense category', ['category' => 'Invalid']);
                }
                $amount = (int) ($b['amount'] ?? 0);
                if ($amount <= 0) {
                    throw HttpError::badRequest('Amount must be greater than zero', ['amount' => 'Required']);
                }
                return [
                    '__deferred' => true, // reference + branch resolved in a wrapper below
                    'category' => $b['category'], 'description' => trim((string) ($b['description'] ?? '')), 'amount' => $amount,
                    'paymentMethod' => $b['paymentMethod'] ?? 'cash', 'branchId' => $b['branchId'] ?? null,
                    'note' => $b['note'] ?? '', 'attachmentRef' => $b['attachmentRef'] ?? null, 'at' => $b['at'] ?? Clock::now(),
                ];
            },
        ]);
        // the Resource create can't allocate a per-merchant reference; override create.
        $r->post('/expenses', fn (Context $c) => self::createExpense($c));

        /* ---- taxes ---- */
        Resource::register($r, $app, [
            'base' => '/taxes', 'table' => 'taxes', 'entity' => 'tax',
            'perms' => ['view' => 'products.view', 'create' => 'taxes.manage', 'edit' => 'taxes.manage'],
            'list' => ['searchCols' => ['name'], 'sortMap' => ['name' => 'name'], 'defaultSort' => 'name', 'defaultDir' => 'asc', 'pageSize' => 'all'],
            'columns' => static fn (array $d) => ['name' => $d['name'] ?? '', 'is_default' => !empty($d['isDefault']) ? 1 : 0, 'status' => $d['status'] ?? 'active'],
            'normalize' => static function (array $b, ?array $e) {
                $type = $b['type'] ?? ($e['type'] ?? 'percent');
                $base = array_merge($e ?? [], [
                    'name' => trim((string) ($b['name'] ?? ($e['name'] ?? ''))),
                    'type' => $type,
                    'scope' => $b['scope'] ?? ($e['scope'] ?? 'product'),
                    'isDefault' => (bool) ($b['isDefault'] ?? ($e['isDefault'] ?? false)),
                    'status' => $b['status'] ?? ($e['status'] ?? 'active'),
                ]);
                if ($type === 'fixed') {
                    $amount = (int) ($b['amount'] ?? ($e['amount'] ?? 0));
                    if ($amount <= 0) {
                        throw HttpError::badRequest('Enter a VAT amount greater than zero', ['amount' => 'Invalid']);
                    }
                    $base['amount'] = $amount;
                    $base['rate'] = 0.0;
                    $base['inclusive'] = false;
                } else {
                    $rate = $b['rate'] ?? ($e['rate'] ?? null);
                    if (!is_numeric($rate) || $rate < 0 || $rate > 100) {
                        throw HttpError::badRequest('Rate must be between 0 and 100', ['rate' => 'Invalid']);
                    }
                    $base['rate'] = (float) $rate;
                    $base['amount'] = 0;
                    $base['inclusive'] = (bool) ($b['inclusive'] ?? ($e['inclusive'] ?? false));
                }
                return $base;
            },
            'decorate' => static function (Context $ctx, array $t) {
                if (!empty($t['isDefault'])) {
                    self::clearOtherDefaults($ctx, 'taxes', $t['id']);
                }
                return $t;
            },
        ]);

        /* ---- discounts ---- */
        Resource::register($r, $app, [
            'base' => '/discounts', 'table' => 'discounts', 'entity' => 'discount',
            'perms' => ['view' => 'discounts.manage', 'create' => 'discounts.manage', 'edit' => 'discounts.manage'],
            'list' => ['searchCols' => ['code'], 'sortMap' => ['createdAt' => 'created_at'], 'defaultSort' => 'created_at', 'defaultDir' => 'desc'],
            'columns' => static fn (array $d) => ['code' => $d['code'] ?? null, 'status' => $d['status'] ?? 'active'],
            'normalize' => static function (array $b, ?array $e) {
                if ($e === null) {
                    if (empty($b['name'])) {
                        throw HttpError::badRequest('Discount name is required', ['name' => 'Required']);
                    }
                    if (!in_array($b['type'] ?? null, ['percent', 'fixed'], true)) {
                        throw HttpError::badRequest('Choose a discount type', ['type' => 'Invalid']);
                    }
                }
                return array_merge($e ?? [], array_filter([
                    'name' => isset($b['name']) ? trim((string) $b['name']) : null,
                    'code' => array_key_exists('code', $b) ? ($b['code'] ? strtoupper(trim((string) $b['code'])) : null) : null,
                    'type' => $b['type'] ?? null, 'value' => isset($b['value']) ? (float) $b['value'] : null,
                    'scope' => $b['scope'] ?? null, 'appliesTo' => $b['appliesTo'] ?? null,
                    'minSpend' => isset($b['minSpend']) ? (int) $b['minSpend'] : null,
                    'maxDiscount' => isset($b['maxDiscount']) ? (int) $b['maxDiscount'] : null,
                    'customerId' => $b['customerId'] ?? null, 'startsAt' => $b['startsAt'] ?? null, 'endsAt' => $b['endsAt'] ?? null,
                    'usageLimit' => isset($b['usageLimit']) ? (int) $b['usageLimit'] : null, 'status' => $b['status'] ?? null,
                ], static fn ($v) => $v !== null) + ($e === null ? ['usageCount' => 0, 'appliesTo' => $b['appliesTo'] ?? [], 'status' => $b['status'] ?? 'active'] : []));
            },
        ]);

        $r->post('/discounts/validate', fn (Context $c) => self::validateDiscount($c));

        /* ---- cash register ---- */
        $r->get('/cash-register/current', fn (Context $c) => self::currentRegister($c));
        $r->get('/cash-register/sessions', fn (Context $c) => self::listSessions($c));
        $r->get('/cash-register/sessions/:id', fn (Context $c, $p) => self::getSession($c, $p));
        $r->post('/cash-register/open', fn (Context $c) => self::openRegister($c));
        $r->post('/cash-register/sessions/:id/movements', fn (Context $c, $p) => self::addMovement($c, $p));
        $r->post('/cash-register/sessions/:id/close', fn (Context $c, $p) => self::closeRegister($c, $p));
    }

    /* ------------------------------------------------------------ expenses */

    private static function createExpense(Context $ctx): Response
    {
        $ctx->requirePermission('expenses.manage');
        $b = $ctx->body();
        if (!in_array($b['category'] ?? null, self::EXPENSE_CATEGORIES, true)) {
            throw HttpError::badRequest('Choose a valid expense category', ['category' => 'Invalid']);
        }
        $amount = (int) ($b['amount'] ?? 0);
        if ($amount <= 0) {
            throw HttpError::badRequest('Amount must be greater than zero', ['amount' => 'Required']);
        }
        $branch = Branch::require($ctx, $b['branchId'] ?? null);
        return $ctx->db->transaction(function () use ($ctx, $b, $amount, $branch) {
            $ref = DocNo::next($ctx->repo(), 'expense', 'EXP-{YY}{MM}-{SEQ}', ['seqWidth' => 4]);
            $openReg = $ctx->repo()->findDoc('register_sessions', "branch_id = :x AND status = 'open'", [':x' => $branch['id']]);
            $stamp = ['userId' => $ctx->actor['id'], 'userName' => $ctx->actor['name']];
            $id = Uuid::v4();
            $doc = [
                'id' => $id, 'reference' => $ref, 'category' => $b['category'], 'description' => trim((string) ($b['description'] ?? '')),
                'amount' => $amount, 'paymentMethod' => $b['paymentMethod'] ?? 'cash', 'branchId' => $branch['id'],
                'employeeId' => $b['employeeId'] ?? $stamp['userId'], 'employeeName' => $stamp['userName'],
                'note' => $b['note'] ?? '', 'attachmentRef' => $b['attachmentRef'] ?? null,
                'registerSessionId' => $openReg['id'] ?? null, 'at' => $b['at'] ?? Clock::now(),
            ];
            $row = $ctx->repo()->insert('expenses', $id, $doc, ['reference' => $ref, 'branch_id' => $branch['id'], 'category' => $b['category'], 'amount' => $amount, 'at' => $doc['at']]);
            Audit::record($ctx, 'create', 'expense', $id, ['after' => $row]);
            return Response::json($row, 201);
        });
    }

    /* ------------------------------------------------------------ discounts */

    private static function validateDiscount(Context $ctx): Response
    {
        $ctx->requireActor();
        $b = $ctx->body();
        $code = strtoupper(trim((string) ($b['code'] ?? '')));
        $subtotal = (int) ($b['subtotal'] ?? 0);
        $d = $ctx->repo()->findDoc('discounts', "code = :c AND status = 'active' AND archived_at IS NULL", [':c' => $code]);
        if (!$d) {
            return Response::json(['valid' => false, 'message' => 'Coupon not found or inactive.']);
        }
        $t = time();
        if (!empty($d['startsAt']) && strtotime($d['startsAt']) > $t) {
            return Response::json(['valid' => false, 'message' => 'This coupon is not active yet.']);
        }
        if (!empty($d['endsAt']) && strtotime($d['endsAt']) < $t) {
            return Response::json(['valid' => false, 'message' => 'This coupon has expired.']);
        }
        if (!empty($d['usageLimit']) && ($d['usageCount'] ?? 0) >= $d['usageLimit']) {
            return Response::json(['valid' => false, 'message' => 'This coupon has reached its usage limit.']);
        }
        if (!empty($d['minSpend']) && $subtotal < $d['minSpend']) {
            return Response::json(['valid' => false, 'message' => 'Spend at least ' . Money::format($d['minSpend']) . ' to use this coupon.']);
        }
        $amount = ($d['type'] ?? '') === 'percent' ? Money::percent($subtotal, $d['value'] ?? 0) : Money::toMinor($d['value'] ?? 0);
        if (!empty($d['maxDiscount'])) {
            $amount = min($amount, $d['maxDiscount']);
        }
        return Response::json(['valid' => true, 'discount' => $d, 'amount' => $amount, 'type' => $d['type'], 'value' => $d['value']]);
    }

    /* ------------------------------------------------------- cash register */

    private static function currentRegister(Context $ctx): Response
    {
        $ctx->requirePermission('register.view');
        $branch = Branch::require($ctx, $ctx->request->query['branchId'] ?? null);
        $mine = ($ctx->request->query['mine'] ?? null) === 'true';
        $session = $ctx->repo()->findDoc('register_sessions', "branch_id = :b AND status = 'open'" . ($mine ? ' AND cashier_id = :c' : ''),
            $mine ? [':b' => $branch['id'], ':c' => $ctx->actor['id']] : [':b' => $branch['id']]);
        return Response::json($session ? self::withTotals($ctx, $session) : null);
    }

    private static function listSessions(Context $ctx): Response
    {
        $ctx->requirePermission('register.view');
        $q = $ctx->request->query;
        $where = ['1=1'];
        $params = [];
        foreach (['branchId' => 'branch_id', 'cashierId' => 'cashier_id', 'status' => 'status'] as $k => $c) {
            if (!empty($q[$k]) && $q[$k] !== 'all') {
                $where[] = "{$c} = :{$c}";
                $params[":{$c}"] = $q[$k];
            }
        }
        $result = $ctx->repo()->list([
            'table' => 'register_sessions', 'query' => $q, 'baseWhere' => implode(' AND ', $where), 'params' => $params,
            'searchCols' => ['reference'], 'sortMap' => ['openedAt' => 'opened_at', 'reference' => 'reference'],
            'defaultSort' => 'openedAt', 'defaultDir' => 'desc',
            'summarize' => function ($list) use ($ctx) {
                $open = array_values(array_filter($list, static fn ($s) => ($s['status'] ?? '') === 'open'));
                $cashOpen = 0;
                foreach ($open as $s) {
                    $cashOpen += (int) (self::withTotals($ctx, $s)['expectedCash'] ?? 0);
                }
                return [
                    'sessions' => count($list),
                    'open' => count($open),
                    'cashOnHandOpen' => $cashOpen,
                    'discrepancies' => count(array_filter($list, static fn ($s) => !empty($s['difference']))),
                ];
            },
        ]);
        $result['data'] = array_map(fn ($s) => self::withTotals($ctx, $s), $result['data']);
        return Response::json($result);
    }

    private static function getSession(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('register.view');
        $s = $ctx->repo()->doc('register_sessions', $p['id']) ?? throw HttpError::notFound('Register session');
        return Response::json(self::withTotals($ctx, $s, true));
    }

    private static function openRegister(Context $ctx): Response
    {
        $ctx->requirePermission('register.operate');
        $b = $ctx->body();
        $branch = Branch::require($ctx, $b['branchId'] ?? null);
        if ($ctx->repo()->exists('register_sessions', "branch_id = :b AND status = 'open' AND cashier_id = :c", [':b' => $branch['id'], ':c' => $ctx->actor['id']])) {
            throw HttpError::conflict('You already have an open register session at this branch.');
        }
        $opening = (int) ($b['openingCash'] ?? 0);
        if ($opening < 0) {
            throw HttpError::badRequest('Opening cash cannot be negative');
        }
        return $ctx->db->transaction(function () use ($ctx, $b, $branch, $opening) {
            $ref = DocNo::next($ctx->repo(), 'register:' . $branch['id'], 'REG-{BR}-{SEQ}', ['branchCode' => $branch['code'] ?: 'MAIN', 'seqWidth' => 4]);
            $id = Uuid::v4();
            $doc = [
                'id' => $id, 'reference' => $ref, 'branchId' => $branch['id'], 'branchName' => $branch['name'],
                'cashierId' => $ctx->actor['id'], 'cashierName' => $ctx->actor['name'],
                'openingCash' => $opening, 'openingNote' => $b['note'] ?? '', 'status' => 'open',
                'openedAt' => Clock::now(), 'closedAt' => null, 'closingCountedCash' => null,
                'closingExpectedCash' => null, 'difference' => null, 'closingNote' => '',
            ];
            $row = $ctx->repo()->insert('register_sessions', $id, $doc, ['reference' => $ref, 'branch_id' => $branch['id'], 'cashier_id' => $ctx->actor['id'], 'status' => 'open', 'opened_at' => $doc['openedAt']]);
            Audit::record($ctx, 'update', 'register_session', $id, ['meta' => ['action' => 'open', 'openingCash' => $opening]]);
            return Response::json(self::withTotals($ctx, $row), 201);
        });
    }

    private static function addMovement(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('register.operate');
        $session = $ctx->repo()->doc('register_sessions', $p['id']) ?? throw HttpError::notFound('Register session');
        if ($session['status'] !== 'open') {
            throw HttpError::conflict('This register session is closed.');
        }
        $b = $ctx->body();
        $amount = (int) ($b['amount'] ?? 0);
        if ($amount <= 0) {
            throw HttpError::badRequest('Amount must be greater than zero');
        }
        if (!in_array($b['direction'] ?? null, ['in', 'out'], true)) {
            throw HttpError::badRequest('Direction must be "in" or "out"');
        }
        return $ctx->db->transaction(function () use ($ctx, $session, $b, $amount) {
            $id = Uuid::v4();
            $doc = [
                'id' => $id, 'sessionId' => $session['id'], 'branchId' => $session['branchId'], 'direction' => $b['direction'],
                'amount' => $amount, 'reason' => $b['reason'] ?? ($b['direction'] === 'in' ? 'cash_in' : 'cash_out'),
                'note' => $b['note'] ?? '', 'at' => Clock::now(), 'userId' => $ctx->actor['id'],
            ];
            $row = $ctx->repo()->insert('register_movements', $id, $doc, ['session_id' => $session['id'], 'branch_id' => $session['branchId'], 'direction' => $b['direction'], 'amount' => $amount, 'at' => $doc['at']]);
            Audit::record($ctx, 'update', 'register_session', $session['id'], ['meta' => ['movement' => $b['direction'], 'amount' => $amount]]);
            return Response::json($row, 201);
        });
    }

    private static function closeRegister(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('register.operate');
        $session = $ctx->repo()->doc('register_sessions', $p['id']) ?? throw HttpError::notFound('Register session');
        if ($session['status'] !== 'open') {
            throw HttpError::conflict('This register session is already closed.');
        }
        $b = $ctx->body();
        $counted = (int) ($b['countedCash'] ?? 0);
        return $ctx->db->transaction(function () use ($ctx, $session, $b, $counted) {
            $totals = self::computeCash($ctx, $session);
            $difference = $counted - $totals['expectedCash'];
            $row = $ctx->repo()->update('register_sessions', $session['id'], [
                'status' => 'closed', 'closedAt' => Clock::now(),
                'closingCountedCash' => $counted, 'closingExpectedCash' => $totals['expectedCash'],
                'difference' => $difference, 'closingNote' => $b['note'] ?? '', 'totalsSnapshot' => $totals,
            ], ['status' => 'closed', 'closed_at' => Clock::now()]);
            Audit::record($ctx, 'update', 'register_session', $session['id'], ['meta' => ['action' => 'close', 'difference' => $difference, 'counted' => $counted]]);
            Notify::push($ctx, 'register_close', 'Register closed',
                "{$session['reference']}: expected " . Money::format($totals['expectedCash']) . ", counted " . Money::format($counted) .
                ' (' . ($difference === 0 ? 'balanced' : ($difference > 0 ? 'over ' : 'short ') . Money::format(abs($difference))) . ').',
                ['level' => $difference === 0 ? 'success' : 'warning', 'link' => '#/cash-register']);
            return Response::json(self::withTotals($ctx, $row, true));
        });
    }

    private static function computeCash(Context $ctx, array $session): array
    {
        $from = $session['openedAt'];
        $to = $session['closedAt'] ?? Clock::now();
        $inWin = static fn ($iso) => strtotime($iso) >= strtotime($from) && strtotime($iso) <= strtotime($to);

        $payments = $ctx->repo()->allDocs('payments', 'branch_id = :b AND at >= :f AND at <= :t', [':b' => $session['branchId'], ':f' => $from, ':t' => $to]);
        $cashSales = 0;
        $cashRefunds = 0;
        $cardSales = 0;
        foreach ($payments as $pm) {
            if (($pm['method'] ?? '') === 'cash' && ($pm['direction'] ?? '') === 'in' && empty($pm['saleReturnId'])) {
                $cashSales += $pm['amount'];
            } elseif (($pm['method'] ?? '') === 'cash' && ($pm['direction'] ?? '') === 'out') {
                $cashRefunds += $pm['amount'];
            } elseif (($pm['method'] ?? '') !== 'cash' && ($pm['direction'] ?? '') === 'in') {
                $cardSales += $pm['amount'];
            }
        }
        $expenses = 0;
        foreach ($ctx->repo()->allDocs('expenses', 'branch_id = :b AND at >= :f AND at <= :t', [':b' => $session['branchId'], ':f' => $from, ':t' => $to]) as $e) {
            if (($e['paymentMethod'] ?? '') === 'cash') {
                $expenses += $e['amount'];
            }
        }
        $cashIn = 0;
        $cashOut = 0;
        foreach ($ctx->repo()->allDocs('register_movements', 'session_id = :s', [':s' => $session['id']]) as $m) {
            $m['direction'] === 'in' ? $cashIn += $m['amount'] : $cashOut += $m['amount'];
        }
        $salesCount = $ctx->repo()->count('sales', 'branch_id = :b AND created_at >= :f AND created_at <= :t', [':b' => $session['branchId'], ':f' => $from, ':t' => $to]);
        $expected = $session['openingCash'] + $cashSales + $cashIn - $cashRefunds - $expenses - $cashOut;

        return compact('cashSales', 'cardSales', 'cashRefunds', 'cashIn', 'cashOut', 'salesCount')
            + ['openingCash' => $session['openingCash'], 'cashExpenses' => $expenses, 'expectedCash' => $expected];
    }

    private static function withTotals(Context $ctx, array $session, bool $full = false): array
    {
        $totals = ($session['status'] === 'closed' && !empty($session['totalsSnapshot']))
            ? $session['totalsSnapshot']
            : self::computeCash($ctx, $session);
        $out = array_merge($session, $totals, ['expectedCash' => $totals['expectedCash']]);
        if ($full) {
            $out['movements'] = $ctx->repo()->allDocs('register_movements', 'session_id = :s', [':s' => $session['id']], 'at ASC');
        }
        return $out;
    }

    private static function clearOtherDefaults(Context $ctx, string $table, string $keepId): void
    {
        foreach ($ctx->repo()->allDocs($table, 'id <> :k', [':k' => $keepId]) as $row) {
            if (!empty($row['isDefault'])) {
                $ctx->repo()->update($table, $row['id'], ['isDefault' => false], ['is_default' => 0]);
            }
        }
    }
}
