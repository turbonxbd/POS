<?php
declare(strict_types=1);

namespace Afia\Modules;

use Afia\App;
use Afia\Context;
use Afia\Http\Response;
use Afia\Http\Router;
use Afia\Support\Audit;
use Afia\Support\Clock;
use Afia\Support\HttpError;
use Afia\Support\Password;
use Afia\Support\Provision;
use Afia\Support\Uuid;

/**
 * Platform / Super Admin - system-level management for the POS TXbd owners.
 * Every route requires is_platform_admin = 1 and bypasses merchant scoping.
 * The merchant panels never call these.
 */
final class Platform
{
    public static function register(Router $r, App $app): void
    {
        $r->get('/platform/dashboard', fn (Context $c) => self::dashboard($c));
        $r->get('/platform/stats', fn (Context $c) => self::dashboard($c));

        $r->get('/platform/merchants', fn (Context $c) => self::merchants($c));
        $r->get('/platform/merchants/:id', fn (Context $c, $p) => self::merchantDetail($c, $p));
        $r->post('/platform/merchants', fn (Context $c) => self::createMerchant($c));
        $r->patch('/platform/merchants/:id', fn (Context $c, $p) => self::updateMerchant($c, $p));
        $r->post('/platform/merchants/:id/notes', fn (Context $c, $p) => self::addMerchantNote($c, $p));
        $r->delete('/platform/merchants/:id/notes/:noteId', fn (Context $c, $p) => self::deleteMerchantNote($c, $p));
        $r->post('/platform/merchants/:id/message', fn (Context $c, $p) => self::messageMerchant($c, $p));
        $r->post('/platform/merchants/:id/reset-owner', fn (Context $c, $p) => self::resetOwner($c, $p));

        $r->get('/platform/subscriptions', fn (Context $c) => self::subscriptions($c));
        $r->patch('/platform/subscriptions/:id', fn (Context $c, $p) => self::updateSubscription($c, $p));

        $r->get('/platform/subscription-payments', fn (Context $c) => self::payments($c));
        $r->post('/platform/subscription-payments', fn (Context $c) => self::recordPayment($c));
        $r->patch('/platform/subscription-payments/:id', fn (Context $c, $p) => self::updatePayment($c, $p));

        $r->get('/platform/revenue', fn (Context $c) => self::revenue($c));

        $r->get('/public-settings', fn (Context $c) => self::publicSettings($c));
        $r->get('/platform/settings', fn (Context $c) => self::getSettings($c));
        $r->patch('/platform/settings', fn (Context $c) => self::updateSettings($c));

        $r->get('/platform/support', fn (Context $c) => self::support($c));
        $r->post('/platform/support/:id/reply', fn (Context $c, $p) => self::supportReply($c, $p));
        $r->patch('/platform/support/:id', fn (Context $c, $p) => self::supportStatus($c, $p));

        $r->get('/platform/audit', fn (Context $c) => self::auditLog($c));
        $r->get('/platform/notifications', fn (Context $c) => self::notifications($c));
        $r->post('/platform/notifications/:id/read', fn (Context $c, $p) => self::notificationRead($c, $p));
        $r->post('/platform/notifications/read-all', fn (Context $c) => self::notificationsReadAll($c));
        $r->delete('/platform/notifications/:id', fn (Context $c, $p) => self::notificationDelete($c, $p));

        $r->get('/platform/approvals', fn (Context $c) => self::approvals($c));
        $r->post('/platform/approvals/:merchantId/approve', fn (Context $c, $p) => self::approve($c, $p));
        $r->post('/platform/approvals/:merchantId/reject', fn (Context $c, $p) => self::reject($c, $p));

        $r->get('/platform/backups', fn (Context $c) => self::listBackups($c));
        $r->post('/platform/backups/run', fn (Context $c) => self::runBackup($c));
        $r->get('/platform/backups/download', fn (Context $c) => self::downloadBackup($c));
        $r->delete('/platform/backups', fn (Context $c) => self::deleteBackup($c));
    }

    /* --------------------------------------------------------- backups */

    private static function backupDir(Context $ctx): string
    {
        $dir = rtrim((string) ($ctx->config['app']['storage_dir'] ?? (getcwd() . '/storage')), '/') . '/backups';
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        return $dir;
    }

    /** Resolve a client-supplied file name to a safe path inside the backup dir. */
    private static function backupPath(Context $ctx, string $name): string
    {
        $name = basename(trim($name));
        if ($name === '' || !preg_match('/^[A-Za-z0-9._-]+\.(sql|json|gz)$/', $name)) {
            throw HttpError::badRequest('Invalid backup file name.');
        }
        $path = self::backupDir($ctx) . '/' . $name;
        if (!is_file($path)) {
            throw HttpError::notFound('Backup');
        }
        return $path;
    }

    private static function listBackups(Context $ctx): Response
    {
        $dir = self::backupDir($ctx);
        $files = [];
        foreach (glob($dir . '/*.{sql,json,gz}', GLOB_BRACE) ?: [] as $f) {
            $files[] = [
                'name' => basename($f),
                'bytes' => filesize($f) ?: 0,
                'at' => date('c', filemtime($f) ?: time()),
            ];
        }
        usort($files, static fn ($a, $b) => strcmp($b['at'], $a['at']));

        $cron = trim((string) @shell_exec('command -v mysqldump')) !== '';
        return Response::json([
            'files' => $files,
            'dir' => $dir,
            'mysqldump' => $cron,
            'retain' => 14,
            'note' => 'Wire bin/backup.php to a daily cron (hPanel -> Advanced -> Cron Jobs) and copy these dumps off-server.',
        ]);
    }

    private static function runBackup(Context $ctx): Response
    {
        $script = dirname(__DIR__, 2) . '/bin/backup.php';
        if (!is_file($script)) {
            throw HttpError::conflict('Backup script not found on the server.');
        }
        $php = PHP_BINARY ?: 'php';
        $out = [];
        $code = 0;
        exec(escapeshellarg($php) . ' ' . escapeshellarg($script) . ' 2>&1', $out, $code);
        Audit::record($ctx, 'settings', 'backup', null, ['meta' => ['action' => 'run', 'exit' => $code]]);
        if ($code !== 0) {
            throw HttpError::conflict('Backup failed: ' . implode(' ', array_slice($out, -3)));
        }
        return Response::json(['ok' => true, 'output' => implode("\n", $out)]);
    }

    private static function downloadBackup(Context $ctx): Response
    {
        $path = self::backupPath($ctx, (string) ($ctx->request->query['file'] ?? ''));
        Audit::record($ctx, 'settings', 'backup', null, ['meta' => ['action' => 'download', 'file' => basename($path)]]);
        $r = new Response(200, null, [
            'Content-Type' => 'application/octet-stream',
            'Content-Disposition' => 'attachment; filename="' . basename($path) . '"',
            'Content-Length' => (string) (filesize($path) ?: 0),
        ]);
        $r->raw = (string) file_get_contents($path);
        return $r;
    }

    private static function deleteBackup(Context $ctx): Response
    {
        $path = self::backupPath($ctx, (string) ($ctx->request->query['file'] ?? ''));
        @unlink($path);
        Audit::record($ctx, 'settings', 'backup', null, ['meta' => ['action' => 'delete', 'file' => basename($path)]]);
        return Response::json(['ok' => true]);
    }

    /* -------------------------------------------------- approvals inbox */

    /** @return array<int,array> merchants that need Super Admin action */
    private static function approvalRows(Context $ctx): array
    {
        $grace = self::graceDays($ctx);
        $now = Clock::now();
        $out = [];
        foreach ($ctx->db->all('SELECT id, doc FROM merchants') as $mrow) {
            $m = json_decode($mrow['doc'], true);
            $mid = $mrow['id'];
            $srow = $ctx->db->first('SELECT doc FROM subscriptions WHERE merchant_id = :m', [':m' => $mid]);
            $sub = $srow ? json_decode($srow['doc'], true) : null;
            $live = $sub ? self::liveStatus($sub, $now, $grace) : 'none';
            $pend = self::pendingPayment($ctx, $mid);
            if (!in_array($live, ['pending', 'past_due', 'expired'], true) && $pend === null) {
                continue;
            }
            $biz = $ctx->db->first('SELECT doc FROM businesses WHERE merchant_id = :m', [':m' => $mid]);
            $bizDoc = $biz ? json_decode($biz['doc'], true) : [];
            $owner = $ctx->db->first("SELECT doc FROM users WHERE merchant_id = :m AND is_platform_admin = 0 AND role_id = 'role_owner'", [':m' => $mid])
                ?? $ctx->db->first('SELECT doc FROM users WHERE merchant_id = :m AND is_platform_admin = 0', [':m' => $mid]);
            $ownerDoc = $owner ? json_decode($owner['doc'], true) : [];
            $phone = preg_replace('/[^0-9]/', '', (string) ($bizDoc['phone'] ?? $ownerDoc['phone'] ?? ''));
            $out[] = [
                'merchantId' => $mid,
                'businessName' => $bizDoc['name'] ?? ($m['name'] ?? '—'),
                'ownerName' => $ownerDoc['name'] ?? '—',
                'email' => $ownerDoc['email'] ?? '—',
                'phone' => $phone,
                'planName' => $sub['planName'] ?? null,
                'setupPrice' => (int) ($sub['setupPrice'] ?? 0),
                'monthlyPrice' => (int) ($sub['monthlyPrice'] ?? $sub['planPrice'] ?? 0),
                'setupPaid' => !empty($sub['setupPaid']),
                'subscriptionStatus' => $live,
                'dueAmount' => $sub ? self::dueAmount($sub, $live) : 0,
                'registeredAt' => $m['createdAt'] ?? null,
                'accountStatus' => $m['status'] ?? 'active',
                'pendingPayment' => $pend ? [
                    'id' => $pend['id'], 'type' => $pend['type'] ?? 'monthly', 'amount' => (int) ($pend['amount'] ?? 0),
                    'method' => $pend['method'] ?? null, 'reference' => $pend['reference'] ?? null,
                    'accountNumber' => $pend['accountNumber'] ?? null, 'proofImage' => $pend['proofImage'] ?? null,
                    'note' => $pend['note'] ?? null, 'at' => $pend['at'] ?? null,
                ] : null,
                'whatsapp' => $phone !== '' ? 'https://wa.me/' . $phone : null,
            ];
        }
        usort($out, static fn ($a, $b) => ($b['pendingPayment'] ? 1 : 0) <=> ($a['pendingPayment'] ? 1 : 0)
            ?: strcmp((string) ($a['registeredAt'] ?? ''), (string) ($b['registeredAt'] ?? '')));
        return $out;
    }

    private static function pendingPayment(Context $ctx, string $mid): ?array
    {
        $row = $ctx->db->first(
            "SELECT doc FROM subscription_payments WHERE merchant_id = :m AND status = 'pending' ORDER BY at DESC LIMIT 1",
            [':m' => $mid],
        );
        return $row ? json_decode($row['doc'], true) : null;
    }

    private static function approvalCounts(array $rows): array
    {
        return [
            'accounts' => count(array_filter($rows, static fn ($r) => $r['subscriptionStatus'] === 'pending')),
            'payments' => count(array_filter($rows, static fn ($r) => $r['pendingPayment'] !== null)),
            'overdue' => count(array_filter($rows, static fn ($r) => in_array($r['subscriptionStatus'], ['past_due', 'expired'], true))),
        ];
    }

    private static function notifyMerchant(Context $ctx, string $mid, array $n): void
    {
        $now = Clock::now();
        $doc = [
            'id' => Uuid::v4(), 'merchantId' => $mid, 'type' => $n['type'] ?? 'billing',
            'title' => $n['title'] ?? '', 'message' => $n['message'] ?? '',
            'level' => $n['level'] ?? 'info', 'link' => $n['link'] ?? '#/billing',
            'read' => false, 'readAt' => null, 'meta' => [],
            'at' => $now, 'createdAt' => $now, 'updatedAt' => $now,
        ];
        $ctx->db->run(
            'INSERT INTO notifications (id, merchant_id, type, is_read, at, doc, created_at, updated_at) VALUES (:id,:m,:ty,0,:at,:d,:c,:c)',
            [':id' => $doc['id'], ':m' => $mid, ':ty' => $doc['type'], ':at' => $now, ':d' => json_encode($doc, JSON_UNESCAPED_UNICODE), ':c' => $now],
        );
    }

    private static function approvals(Context $ctx): Response
    {
        $ctx->requirePlatformAdmin();
        $rows = self::approvalRows($ctx);
        return Response::json(['data' => $rows, 'counts' => self::approvalCounts($rows)]);
    }

    private static function approve(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $mid = $p['merchantId'];
        $mrow = $ctx->db->first('SELECT id, doc FROM merchants WHERE id = :id', [':id' => $mid]) ?? throw HttpError::notFound('Merchant');
        $m = json_decode($mrow['doc'], true);
        $pend = self::pendingPayment($ctx, $mid);
        $now = Clock::now();
        if ($pend) {
            $pend['status'] = 'paid';
            $pend['confirmedBy'] = $ctx->actor['name'] ?? 'Super Admin';
            $pend['confirmedAt'] = $now;
            $pend['updatedAt'] = $now;
            $ctx->db->run('UPDATE subscription_payments SET status = :s, doc = :d, updated_at = :u WHERE id = :id',
                [':s' => 'paid', ':d' => json_encode($pend), ':u' => $now, ':id' => $pend['id']]);
            self::applyConfirmedPayment($ctx, $pend);
        } else {
            $srow = $ctx->db->first('SELECT doc FROM subscriptions WHERE merchant_id = :m', [':m' => $mid]);
            if ($srow) {
                $sub = json_decode($srow['doc'], true);
                Provision::subscribe($ctx->db, $mid, $sub['planId'] ?? null, 'active', $now, null, [
                    'setupPaid' => true, 'lastPaymentAt' => $now,
                ]);
            }
        }
        if (($m['status'] ?? 'active') !== 'active') {
            $m['status'] = 'active';
            $m['updatedAt'] = $now;
            $ctx->db->run('UPDATE merchants SET status = :s, doc = :d, updated_at = :u WHERE id = :id',
                [':s' => 'active', ':d' => json_encode($m), ':u' => $now, ':id' => $mid]);
        }
        self::notifyMerchant($ctx, $mid, [
            'title' => 'Account approved',
            'message' => 'Your POS TXbd account has been verified and approved. You now have full access.',
        ]);
        Audit::record($ctx, 'update', 'merchant', $mid, ['meta' => ['action' => 'approve']]);
        return Response::json(['ok' => true, 'merchantId' => $mid]);
    }

    private static function reject(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $mid = $p['merchantId'];
        if (!$ctx->db->first('SELECT 1 FROM merchants WHERE id = :id', [':id' => $mid])) {
            throw HttpError::notFound('Merchant');
        }
        $reason = trim((string) ($ctx->body()['reason'] ?? '')) ?: 'Payment could not be verified.';
        $now = Clock::now();
        $pend = self::pendingPayment($ctx, $mid);
        if ($pend) {
            $pend['status'] = 'rejected';
            $pend['rejectedReason'] = $reason;
            $pend['confirmedBy'] = $ctx->actor['name'] ?? 'Super Admin';
            $pend['confirmedAt'] = $now;
            $pend['updatedAt'] = $now;
            $ctx->db->run('UPDATE subscription_payments SET status = :s, doc = :d, updated_at = :u WHERE id = :id',
                [':s' => 'rejected', ':d' => json_encode($pend), ':u' => $now, ':id' => $pend['id']]);
            if (!empty($pend['branchRef'])) {
                $br = $ctx->db->first('SELECT doc FROM branch_requests WHERE id = :id', [':id' => $pend['branchRef']]);
                if ($br) {
                    $brDoc = json_decode($br['doc'], true);
                    if (($brDoc['status'] ?? '') === 'pending') {
                        $brDoc['status'] = 'rejected';
                        $ctx->db->run('UPDATE branch_requests SET status = :s, doc = :d, updated_at = :u WHERE id = :id',
                            [':s' => 'rejected', ':d' => json_encode($brDoc), ':u' => $now, ':id' => $brDoc['id']]);
                    }
                }
            }
        }
        self::notifyMerchant($ctx, $mid, [
            'title' => 'Payment not verified',
            'message' => "We could not verify your payment: {$reason} Please check the details and submit again.",
            'level' => 'warning',
        ]);
        Audit::record($ctx, 'update', 'merchant', $mid, ['meta' => ['action' => 'reject', 'reason' => $reason]]);
        return Response::json(['ok' => true, 'merchantId' => $mid]);
    }

    /* -------------------------------------------------- notifications */

    private const NOTIF_TYPE_LABEL = [
        'initial' => 'initial plan purchase',
        'monthly' => 'monthly server & backup charge',
        'branch' => 'additional branch',
    ];

    /** Insert a platform-wide Super Admin notification. Called from Billing. */
    public static function notifyPlatform(Context $ctx, array $n): void
    {
        $now = Clock::now();
        $doc = [
            'id' => Uuid::v4(),
            'type' => $n['type'] ?? 'info',
            'title' => $n['title'] ?? '',
            'message' => $n['message'] ?? '',
            'level' => $n['level'] ?? 'info',
            'link' => $n['link'] ?? '#/payments',
            'meta' => $n['meta'] ?? [],
            'read' => false, 'readAt' => null,
            'at' => $now, 'createdAt' => $now, 'updatedAt' => $now,
        ];
        $ctx->db->run(
            'INSERT INTO platform_notifications (id, type, is_read, at, doc, created_at, updated_at) VALUES (:id,:ty,0,:at,:d,:c,:c)',
            [':id' => $doc['id'], ':ty' => $doc['type'], ':at' => $now, ':d' => json_encode($doc, JSON_UNESCAPED_UNICODE), ':c' => $now],
        );
    }

    /** A merchant submitted a manual payment that needs Super Admin approval. */
    public static function notifyPaymentRequest(Context $ctx, array $pay, ?string $planOrBranch): void
    {
        $bizRow = $ctx->db->first('SELECT doc FROM businesses WHERE merchant_id = :m', [':m' => $pay['merchantId']]);
        $biz = $bizRow ? (json_decode($bizRow['doc'], true)['name'] ?? 'A merchant') : 'A merchant';
        $amt = '৳' . number_format(($pay['amount'] ?? 0) / 100);
        $label = self::NOTIF_TYPE_LABEL[$pay['type']] ?? $pay['type'];
        self::notifyPlatform($ctx, [
            'type' => 'payment_request',
            'title' => 'New payment request',
            'message' => "{$biz} submitted a {$label} payment of {$amt}" . (!empty($pay['reference']) ? " · Txn {$pay['reference']}" : ''),
            'level' => 'warning',
            'link' => '#/payments?status=pending',
            'meta' => [
                'paymentId' => $pay['id'], 'merchantId' => $pay['merchantId'], 'type' => $pay['type'],
                'amount' => $pay['amount'] ?? 0, 'reference' => $pay['reference'] ?? null, 'planOrBranch' => $planOrBranch,
            ],
        ]);
    }

    private static function auditLog(Context $ctx): Response
    {
        $ctx->requirePlatformAdmin();
        $q = $ctx->request->query;
        $where = ["doc LIKE '%\"actorPlatform\":true%'"];
        $params = [];
        foreach (['action' => 'action', 'actorId' => 'actor_id'] as $k => $col) {
            if (!empty($q[$k]) && $q[$k] !== 'all') {
                $where[] = "{$col} = :{$col}";
                $params[":{$col}"] = $q[$k];
            }
        }
        if (!empty($q['merchantId'])) {
            $where[] = 'doc LIKE :mrc';
            $params[':mrc'] = '%"merchantId":"' . $q['merchantId'] . '"%';
        }
        $rows = $ctx->db->all(
            'SELECT doc FROM audit_logs WHERE ' . implode(' AND ', $where) . ' ORDER BY at DESC',
            $params,
        );
        $data = array_map(static fn ($r) => json_decode($r['doc'], true), $rows);
        // date range + text search + pagination in memory (small platform-action set)
        $from = !empty($q['from']) ? strtotime((string) $q['from']) : null;
        $to = !empty($q['to']) ? strtotime((string) $q['to']) : null;
        $search = mb_strtolower(trim((string) ($q['search'] ?? $q['q'] ?? '')));
        $data = array_values(array_filter($data, static function ($l) use ($from, $to, $search) {
            $t = strtotime((string) ($l['at'] ?? ''));
            if ($from !== null && $t < $from) {
                return false;
            }
            if ($to !== null && $t > $to) {
                return false;
            }
            if ($search !== '') {
                $hay = mb_strtolower(($l['actorName'] ?? '') . ' ' . ($l['entity'] ?? '') . ' ' . ($l['action'] ?? '') . ' ' . ($l['entityId'] ?? ''));
                if (!str_contains($hay, $search)) {
                    return false;
                }
            }
            return true;
        }));
        foreach ($data as &$l) {
            $mid = $l['merchantId'] ?? ($l['meta']['merchantId'] ?? null);
            $l['merchantName'] = $mid ? (json_decode((string) ($ctx->db->first('SELECT doc FROM merchants WHERE id = :id', [':id' => $mid])['doc'] ?? '{}'), true)['name'] ?? null) : null;
        }
        unset($l);
        $total = count($data);
        $pageSize = ($q['pageSize'] ?? null) === 'all' ? max($total, 1) : max(1, (int) ($q['pageSize'] ?? 20));
        $totalPages = max(1, (int) ceil($total / $pageSize));
        $page = min(max(1, (int) ($q['page'] ?? 1)), $totalPages);
        return Response::json([
            'data' => array_slice($data, ($page - 1) * $pageSize, $pageSize),
            'total' => $total, 'page' => $page, 'pageSize' => $pageSize, 'totalPages' => $totalPages,
        ]);
    }

    private static function notifications(Context $ctx): Response
    {
        $ctx->requirePlatformAdmin();
        $q = $ctx->request->query;
        $rows = array_map(
            static fn ($r) => json_decode($r['doc'], true),
            $ctx->db->all('SELECT doc FROM platform_notifications ORDER BY at DESC'),
        );
        $unread = count(array_filter($rows, static fn ($n) => empty($n['read'])));
        if (($q['unread'] ?? null) === 'true') {
            $rows = array_values(array_filter($rows, static fn ($n) => empty($n['read'])));
        }
        $pageSize = max(1, (int) ($q['pageSize'] ?? 30));
        return Response::json(['data' => array_slice($rows, 0, $pageSize), 'total' => count($rows), 'unreadCount' => $unread]);
    }

    private static function notificationRead(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $row = $ctx->db->first('SELECT doc FROM platform_notifications WHERE id = :id', [':id' => $p['id']]);
        if (!$row) {
            throw HttpError::notFound('Notification');
        }
        $doc = json_decode($row['doc'], true);
        $doc['read'] = true;
        $doc['readAt'] = Clock::now();
        $ctx->db->run('UPDATE platform_notifications SET is_read = 1, doc = :d, updated_at = :u WHERE id = :id',
            [':d' => json_encode($doc, JSON_UNESCAPED_UNICODE), ':u' => Clock::now(), ':id' => $p['id']]);
        return Response::json($doc);
    }

    private static function notificationsReadAll(Context $ctx): Response
    {
        $ctx->requirePlatformAdmin();
        $now = Clock::now();
        foreach ($ctx->db->all('SELECT id, doc FROM platform_notifications WHERE is_read = 0') as $row) {
            $doc = json_decode($row['doc'], true);
            $doc['read'] = true;
            $doc['readAt'] = $now;
            $ctx->db->run('UPDATE platform_notifications SET is_read = 1, doc = :d, updated_at = :u WHERE id = :id',
                [':d' => json_encode($doc, JSON_UNESCAPED_UNICODE), ':u' => $now, ':id' => $row['id']]);
        }
        return Response::json(['ok' => true]);
    }

    private static function notificationDelete(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $ctx->db->run('DELETE FROM platform_notifications WHERE id = :id', [':id' => $p['id']]);
        return Response::json(['deleted' => true]);
    }

    /* ---------------------------------------------------------- dashboard */

    private static function dashboard(Context $ctx): Response
    {
        $ctx->requirePlatformAdmin();
        $db = $ctx->db;
        $now = Clock::now();
        $monthAgo = (new \DateTimeImmutable($now))->modify('-30 days')->format('Y-m-d\TH:i:s.v\Z');

        $grace = self::graceDays($ctx);
        $subs = array_map(static fn ($x) => json_decode($x['doc'], true), $db->all('SELECT doc FROM subscriptions'));
        $active = $expired = $pastDue = $pending = $mrr = 0;
        foreach ($subs as $s) {
            $st = self::liveStatus($s, $now, $grace);
            if ($st === 'active') {
                $active++;
                $price = (int) ($s['monthlyPrice'] ?? $s['planPrice'] ?? 0);
                $mrr += ($s['billingPeriod'] ?? 'monthly') === 'yearly' ? intdiv($price, 12) : $price;
            } elseif ($st === 'expired') {
                $expired++;
            } elseif ($st === 'past_due') {
                $pastDue++;
            } else {
                $pending++;
            }
        }

        $pays = array_map(static fn ($x) => json_decode($x['doc'], true), $db->all('SELECT doc FROM subscription_payments'));
        $paid = array_values(array_filter($pays, static fn ($p) => ($p['status'] ?? 'paid') === 'paid'));
        $revenueTotal = array_sum(array_map(static fn ($p) => $p['amount'] ?? 0, $paid));
        $revenueThisMonth = array_sum(array_map(static fn ($p) => ($p['at'] ?? '') >= $monthAgo ? ($p['amount'] ?? 0) : 0, $paid));
        $byType = ['initial' => 0, 'monthly' => 0, 'branch' => 0];
        foreach ($paid as $p) {
            $t = $p['type'] ?? 'monthly';
            $byType[$t] = ($byType[$t] ?? 0) + ($p['amount'] ?? 0);
        }
        $pendingCount = count(array_filter($pays, static fn ($p) => ($p['status'] ?? 'paid') === 'pending'));

        return Response::json([
            'merchants' => [
                'total' => (int) $db->value('SELECT COUNT(*) FROM merchants'),
                'active' => (int) $db->value("SELECT COUNT(*) FROM merchants WHERE status = 'active'"),
                'inactive' => (int) $db->value("SELECT COUNT(*) FROM merchants WHERE status <> 'active'"),
                'new30d' => (int) $db->value('SELECT COUNT(*) FROM merchants WHERE created_at >= :d', [':d' => $monthAgo]),
            ],
            'subscriptions' => ['active' => $active, 'expired' => $expired, 'pastDue' => $pastDue, 'pending' => $pending, 'total' => count($subs)],
            'attention' => self::approvalCounts(self::approvalRows($ctx)),
            'revenue' => ['total' => $revenueTotal, 'thisMonth' => $revenueThisMonth, 'mrr' => $mrr, 'payments' => count($paid), 'byType' => $byType, 'pending' => $pendingCount],
            'usage' => [
                'branches' => (int) $db->value('SELECT COUNT(*) FROM branches'),
                'users' => (int) $db->value('SELECT COUNT(*) FROM users WHERE is_platform_admin = 0'),
                'products' => (int) $db->value('SELECT COUNT(*) FROM products'),
                'sales' => (int) $db->value('SELECT COUNT(*) FROM sales'),
                'grossSales' => (int) ($db->value('SELECT COALESCE(SUM(grand_total),0) FROM sales') ?? 0),
            ],
            'support' => ['open' => (int) $db->value("SELECT COUNT(*) FROM support_requests WHERE status = 'open'")],
            'chat' => ['open' => (int) $db->value("SELECT COUNT(*) FROM chat_threads WHERE status = 'open'")],
            'plans' => count(Plans::all($ctx, false)),
        ]);
    }

    public static function graceDays(Context $ctx): int
    {
        $g = Provision::platformSettings($ctx->db)['billing']['graceDays'] ?? 7;
        return is_numeric($g) ? (int) $g : 7;
    }

    /**
     * none | pending | active | past_due | expired | suspended | cancelled
     * past_due = period lapsed but still inside the grace window.
     */
    public static function liveStatus(array $sub, string $now, int $graceDays = 7): string
    {
        // a subscription may pin its own grace window (0 = hard cut-off at expiry)
        if (isset($sub['graceDays']) && is_numeric($sub['graceDays'])) {
            $graceDays = (int) $sub['graceDays'];
        }
        $s = $sub['status'] ?? 'pending';
        if ($s === 'cancelled') {
            return 'cancelled';
        }
        if ($s === 'suspended') {
            return 'suspended';
        }
        if ($s === 'expired') {
            return 'expired';
        }
        if (in_array($s, ['active', 'trialing'], true)) {
            if (empty($sub['expiresAt']) || $sub['expiresAt'] >= $now) {
                return 'active';
            }
            $graceUntil = (new \DateTimeImmutable($sub['expiresAt']))->modify("+{$graceDays} days")->format('Y-m-d\TH:i:s.v\Z');
            return $now <= $graceUntil ? 'past_due' : 'expired';
        }
        return 'pending';
    }

    public static function dueAmount(array $sub, string $status): int
    {
        if ($status === 'pending' && empty($sub['setupPaid'])) {
            return (int) ($sub['setupPrice'] ?? 0);
        }
        if (in_array($status, ['past_due', 'expired'], true)) {
            return (int) ($sub['monthlyPrice'] ?? $sub['planPrice'] ?? 0);
        }
        return 0;
    }

    /* ---------------------------------------------------------- merchants */

    private static function merchants(Context $ctx): Response
    {
        $ctx->requirePlatformAdmin();
        $q = $ctx->request->query;
        $now = Clock::now();
        $grace = self::graceDays($ctx);
        $monthAgo = (new \DateTimeImmutable($now))->modify('-30 days')->format('Y-m-d\TH:i:s.v\Z');
        $subByMerchant = [];
        foreach ($ctx->db->all('SELECT merchant_id, doc FROM subscriptions') as $s) {
            $subByMerchant[$s['merchant_id']] = json_decode($s['doc'], true);
        }

        $rows = $ctx->db->all('SELECT id, doc, created_at, status FROM merchants ORDER BY created_at DESC');
        $data = [];
        foreach ($rows as $m) {
            $d = json_decode($m['doc'], true);
            $sub = $subByMerchant[$m['id']] ?? null;
            $owner = $ctx->db->first("SELECT doc FROM users WHERE merchant_id = :m AND role_id = 'role_owner' ORDER BY created_at ASC", [':m' => $m['id']]);
            $ownerDoc = $owner ? json_decode($owner['doc'], true) : [];
            $biz = $ctx->db->first('SELECT doc FROM businesses WHERE merchant_id = :m', [':m' => $m['id']]);
            $bizDoc = $biz ? json_decode($biz['doc'], true) : [];
            $row = [
                'id' => $m['id'], 'name' => $d['name'] ?? '-', 'businessName' => $bizDoc['name'] ?? $d['name'] ?? '-',
                'status' => $m['status'] ?: 'active',
                'ownerName' => $ownerDoc['name'] ?? '-', 'email' => $ownerDoc['email'] ?? '-', 'phone' => $bizDoc['phone'] ?? ($ownerDoc['phone'] ?? '-'),
                'registeredAt' => $m['created_at'],
                'planId' => $sub['planId'] ?? null, 'planName' => $sub['planName'] ?? null,
                'subscriptionStatus' => $sub ? self::liveStatus($sub, $now, $grace) : 'none',
                'subscriptionStart' => $sub['startedAt'] ?? null, 'subscriptionExpiry' => $sub['expiresAt'] ?? null,
                'branches' => (int) $ctx->db->value('SELECT COUNT(*) FROM branches WHERE merchant_id = :m', [':m' => $m['id']]),
                'users' => (int) $ctx->db->value('SELECT COUNT(*) FROM users WHERE merchant_id = :m AND is_platform_admin = 0', [':m' => $m['id']]),
                'tags' => array_values(array_filter((array) ($d['tags'] ?? []))),
                'noteCount' => count((array) ($d['notes'] ?? [])),
            ];
            if (!empty($q['status']) && $q['status'] !== 'all' && $row['status'] !== $q['status']) {
                continue;
            }
            if (!empty($q['subscription']) && $q['subscription'] !== 'all' && $row['subscriptionStatus'] !== $q['subscription']) {
                continue;
            }
            if (($q['new'] ?? null) === 'true' && $m['created_at'] < $monthAgo) {
                continue;
            }
            if (!empty($q['planId']) && $row['planId'] !== $q['planId']) {
                continue;
            }
            if (!empty($q['tag']) && !in_array($q['tag'], $row['tags'], true)) {
                continue;
            }
            $s = mb_strtolower(trim((string) ($q['search'] ?? '')));
            if ($s !== '' && !str_contains(mb_strtolower($row['name'] . ' ' . $row['businessName'] . ' ' . $row['email'] . ' ' . implode(' ', $row['tags'])), $s)) {
                continue;
            }
            $data[] = $row;
        }

        $allTags = [];
        foreach ($data as $row) {
            foreach ($row['tags'] as $t) {
                $allTags[$t] = true;
            }
        }
        $allTags = array_keys($allTags);
        sort($allTags);

        $total = count($data);
        $pageSize = ($q['pageSize'] ?? null) === 'all' ? max($total, 1) : max(1, (int) ($q['pageSize'] ?? 20));
        $totalPages = max(1, (int) ceil($total / $pageSize));
        $page = min(max(1, (int) ($q['page'] ?? 1)), $totalPages);
        return Response::json([
            'data' => array_slice($data, ($page - 1) * $pageSize, $pageSize),
            'total' => $total, 'page' => $page, 'pageSize' => $pageSize, 'totalPages' => $totalPages, 'tags' => $allTags,
        ]);
    }

    private static function merchantDetail(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $m = $ctx->db->first('SELECT id, doc, created_at, status FROM merchants WHERE id = :id', [':id' => $p['id']]) ?? throw HttpError::notFound('Merchant');
        $mid = $m['id'];
        $now = Clock::now();
        $grace = self::graceDays($ctx);
        $sub = $ctx->db->first('SELECT doc FROM subscriptions WHERE merchant_id = :m', [':m' => $mid]);
        $subDoc = $sub ? json_decode($sub['doc'], true) : null;
        $subOut = null;
        if ($subDoc) {
            $ls = self::liveStatus($subDoc, $now, $grace);
            $subOut = array_merge($subDoc, [
                'liveStatus' => $ls,
                'dueAmount' => self::dueAmount($subDoc, $ls),
                'branchLimit' => (int) ($subDoc['includedBranches'] ?? 1) + (int) ($subDoc['extraBranchesPaid'] ?? 0),
            ]);
        }
        $biz = $ctx->db->first('SELECT doc FROM businesses WHERE merchant_id = :m', [':m' => $mid]);
        $mDoc = json_decode($m['doc'], true);
        $notes = (array) ($mDoc['notes'] ?? []);
        usort($notes, static fn ($a, $b) => strcmp((string) ($b['at'] ?? ''), (string) ($a['at'] ?? '')));
        return Response::json([
            'merchant' => array_merge($mDoc, [
                'status' => $m['status'], 'registeredAt' => $m['created_at'],
                'tags' => array_values(array_filter((array) ($mDoc['tags'] ?? []))),
                'notes' => $notes,
            ]),
            'business' => $biz ? json_decode($biz['doc'], true) : null,
            'subscription' => $subOut,
            'branchRequests' => array_map(static fn ($x) => json_decode($x['doc'], true), $ctx->db->all('SELECT doc FROM branch_requests WHERE merchant_id = :m ORDER BY at DESC', [':m' => $mid])),
            'branches' => array_map(static fn ($x) => json_decode($x['doc'], true), $ctx->db->all('SELECT doc FROM branches WHERE merchant_id = :m', [':m' => $mid])),
            'users' => array_map(static function ($x) {
                $u = json_decode($x['doc'], true);
                return ['id' => $u['id'], 'name' => $u['name'], 'email' => $u['email'], 'roleId' => $u['roleId'] ?? null, 'status' => $u['status']];
            }, $ctx->db->all('SELECT doc FROM users WHERE merchant_id = :m AND is_platform_admin = 0', [':m' => $mid])),
            'payments' => array_map(static fn ($x) => json_decode($x['doc'], true), $ctx->db->all('SELECT doc FROM subscription_payments WHERE merchant_id = :m ORDER BY at DESC', [':m' => $mid])),
            'usage' => [
                'products' => (int) $ctx->db->value('SELECT COUNT(*) FROM products WHERE merchant_id = :m', [':m' => $mid]),
                'customers' => (int) $ctx->db->value('SELECT COUNT(*) FROM customers WHERE merchant_id = :m', [':m' => $mid]),
                'sales' => (int) $ctx->db->value('SELECT COUNT(*) FROM sales WHERE merchant_id = :m', [':m' => $mid]),
                'grossSales' => (int) ($ctx->db->value('SELECT COALESCE(SUM(grand_total),0) FROM sales WHERE merchant_id = :m', [':m' => $mid]) ?? 0),
                'lastSaleAt' => $ctx->db->value('SELECT MAX(created_at) FROM sales WHERE merchant_id = :m', [':m' => $mid]),
            ],
        ]);
    }

    private static function createMerchant(Context $ctx): Response
    {
        $ctx->requirePlatformAdmin();
        $b = $ctx->body();
        $name = trim((string) ($b['name'] ?? ''));
        $email = trim((string) ($b['ownerEmail'] ?? ''));
        $password = (string) ($b['ownerPassword'] ?? '');
        if ($name === '' || $email === '' || strlen($password) < 8) {
            throw HttpError::badRequest('Business name, owner email and a password of at least 8 characters are required', [
                'name' => $name === '' ? 'Required' : null,
                'ownerEmail' => $email === '' ? 'Required' : null,
                'ownerPassword' => strlen($password) < 8 ? 'Min 8 characters' : null,
            ]);
        }
        try {
            $res = Provision::merchant($ctx->db, $name, $email, $password);
        } catch (\RuntimeException $e) {
            throw HttpError::conflict($e->getMessage());
        }
        $subStatus = $b['subscriptionStatus'] ?? 'active';
        Provision::subscribe($ctx->db, $res['merchantId'], $b['planId'] ?? null, $subStatus, null, null, ['setupPaid' => $subStatus === 'active']);
        Audit::record($ctx, 'create', 'merchant', $res['merchantId'], ['meta' => ['name' => $name]]);
        return Response::json(['merchantId' => $res['merchantId'], 'ownerEmail' => $res['ownerEmail']], 201);
    }

    private static function updateMerchant(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $row = $ctx->db->first('SELECT doc FROM merchants WHERE id = :id', [':id' => $p['id']]) ?? throw HttpError::notFound('Merchant');
        $doc = json_decode($row['doc'], true);
        $b = $ctx->body();
        if (isset($b['name'])) {
            $doc['name'] = trim((string) $b['name']);
        }
        if (isset($b['status']) && in_array($b['status'], ['active', 'suspended'], true)) {
            $doc['status'] = $b['status'];
        }
        if (is_array($b['tags'] ?? null)) {
            $tags = [];
            foreach ($b['tags'] as $t) {
                $t = mb_substr(trim((string) $t), 0, 24);
                if ($t !== '' && !in_array($t, $tags, true)) {
                    $tags[] = $t;
                }
            }
            $doc['tags'] = array_slice($tags, 0, 12);
        }
        $doc['updatedAt'] = Clock::now();
        $ctx->db->run('UPDATE merchants SET name = :n, status = :s, doc = :d, updated_at = :u WHERE id = :id',
            [':n' => $doc['name'], ':s' => $doc['status'] ?? 'active', ':d' => json_encode($doc), ':u' => $doc['updatedAt'], ':id' => $p['id']]);
        if (isset($b['status'])) {
            // mirror the suspend/reactivate onto the subscription so the access
            // gate (which reads the subscription) actually blocks / unblocks
            $subRow = $ctx->db->first('SELECT doc FROM subscriptions WHERE merchant_id = :m', [':m' => $p['id']]);
            if ($subRow) {
                $s = json_decode($subRow['doc'], true);
                if ($doc['status'] === 'suspended') {
                    Provision::subscribe($ctx->db, $p['id'], $s['planId'] ?? null, 'suspended', $s['startedAt'] ?? null, $s['expiresAt'] ?? null);
                    $ctx->db->run('UPDATE sessions SET revoked_at = :n WHERE user_id IN (SELECT id FROM users WHERE merchant_id = :m)', [':n' => Clock::now(), ':m' => $p['id']]);
                } elseif (($s['status'] ?? '') === 'suspended') {
                    Provision::subscribe($ctx->db, $p['id'], $s['planId'] ?? null, 'active', $s['startedAt'] ?? null, $s['expiresAt'] ?? null);
                }
            }
        }
        Audit::record($ctx, 'update', 'merchant', $p['id'], ['after' => $doc]);
        return Response::json($doc);
    }

    private static function loadMerchantDoc(Context $ctx, string $id): array
    {
        $row = $ctx->db->first('SELECT doc FROM merchants WHERE id = :id', [':id' => $id]) ?? throw HttpError::notFound('Merchant');
        return json_decode($row['doc'], true);
    }

    private static function saveMerchantDoc(Context $ctx, string $id, array $doc): void
    {
        $doc['updatedAt'] = Clock::now();
        $ctx->db->run('UPDATE merchants SET doc = :d, updated_at = :u WHERE id = :id',
            [':d' => json_encode($doc, JSON_UNESCAPED_UNICODE), ':u' => $doc['updatedAt'], ':id' => $id]);
    }

    private static function addMerchantNote(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $doc = self::loadMerchantDoc($ctx, $p['id']);
        $text = trim((string) ($ctx->body()['text'] ?? ''));
        if ($text === '') {
            throw HttpError::badRequest('Write a note first.');
        }
        $note = [
            'id' => Uuid::v4(), 'text' => mb_substr($text, 0, 2000),
            'authorName' => $ctx->actor['name'] ?? 'Super Admin', 'at' => Clock::now(),
        ];
        $doc['notes'] = array_merge((array) ($doc['notes'] ?? []), [$note]);
        self::saveMerchantDoc($ctx, $p['id'], $doc);
        Audit::record($ctx, 'update', 'merchant', $p['id'], ['meta' => ['action' => 'note_added']]);
        return Response::json($note, 201);
    }

    private static function deleteMerchantNote(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $doc = self::loadMerchantDoc($ctx, $p['id']);
        $doc['notes'] = array_values(array_filter((array) ($doc['notes'] ?? []), static fn ($n) => ($n['id'] ?? null) !== $p['noteId']));
        self::saveMerchantDoc($ctx, $p['id'], $doc);
        return Response::json(['deleted' => true]);
    }

    private static function resetOwner(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $mid = $p['id'];
        $ctx->db->first('SELECT id FROM merchants WHERE id = :id', [':id' => $mid]) ?? throw HttpError::notFound('Merchant');
        $staff = array_values(array_filter(
            $ctx->db->all('SELECT id, email, role_id, doc FROM users WHERE merchant_id = :m AND is_platform_admin = 0', [':m' => $mid]),
            static fn ($u) => empty(json_decode($u['doc'], true)['archivedAt']),
        ));
        if (!$staff) {
            throw HttpError::badRequest('This merchant has no staff account to reset.');
        }
        $owner = null;
        foreach ($staff as $u) {
            if (($u['role_id'] ?? '') === 'role_owner') {
                $owner = $u;
            }
        }
        $owner = $owner ?: (array_values(array_filter($staff, static fn ($u) => ($u['role_id'] ?? '') === 'role_admin'))[0] ?? $staff[0]);

        $temp = 'tx-' . bin2hex(random_bytes(3)) . random_int(10, 99);
        $ctx->db->run('UPDATE users SET password_hash = :h, updated_at = :n WHERE id = :id',
            [':h' => Password::hash($temp), ':n' => Clock::now(), ':id' => $owner['id']]);
        $ctx->db->run('UPDATE sessions SET revoked_at = :n WHERE user_id = :u AND revoked_at IS NULL',
            [':n' => Clock::now(), ':u' => $owner['id']]);
        foreach ($ctx->db->all("SELECT id, doc FROM platform_notifications WHERE type = 'password_reset' AND is_read = 0 AND doc LIKE :m", [':m' => '%"merchantId":"' . $mid . '"%']) as $n) {
            $d = json_decode($n['doc'], true);
            $d['read'] = true;
            $d['readAt'] = Clock::now();
            $ctx->db->run('UPDATE platform_notifications SET is_read = 1, doc = :d WHERE id = :id', [':d' => json_encode($d), ':id' => $n['id']]);
        }
        Audit::record($ctx, 'update', 'user', $owner['id'], ['meta' => ['action' => 'password_reset_by_platform', 'merchantId' => $mid]]);
        $ownerDoc = json_decode($owner['doc'], true);
        return Response::json(['email' => $owner['email'], 'name' => $ownerDoc['name'] ?? $owner['email'], 'tempPassword' => $temp]);
    }

    private static function messageMerchant(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $doc = self::loadMerchantDoc($ctx, $p['id']);
        $b = $ctx->body();
        $message = trim((string) ($b['message'] ?? ''));
        if ($message === '') {
            throw HttpError::badRequest('Write a message first.');
        }
        $title = trim((string) ($b['title'] ?? '')) ?: 'Message from POS TXbd';
        self::notifyMerchant($ctx, $p['id'], [
            'title' => mb_substr($title, 0, 120),
            'message' => mb_substr($message, 0, 1000),
            'level' => ($b['level'] ?? '') === 'warning' ? 'warning' : 'info',
            'link' => $b['link'] ?? '#/',
        ]);
        $doc['notes'] = array_merge((array) ($doc['notes'] ?? []), [[
            'id' => Uuid::v4(), 'text' => 'Message sent: "' . mb_substr($message, 0, 200) . '"',
            'authorName' => $ctx->actor['name'] ?? 'Super Admin', 'at' => Clock::now(), 'kind' => 'message',
        ]]);
        self::saveMerchantDoc($ctx, $p['id'], $doc);
        Audit::record($ctx, 'update', 'merchant', $p['id'], ['meta' => ['action' => 'message_sent']]);
        return Response::json(['sent' => true]);
    }

    /* ------------------------------------------------------ subscriptions */

    private static function subscriptions(Context $ctx): Response
    {
        $ctx->requirePlatformAdmin();
        $q = $ctx->request->query;
        $now = Clock::now();
        $grace = self::graceDays($ctx);
        $rows = $ctx->db->all('SELECT merchant_id, doc FROM subscriptions ORDER BY created_at DESC');
        $data = [];
        foreach ($rows as $s) {
            $d = json_decode($s['doc'], true);
            $m = $ctx->db->first('SELECT doc FROM merchants WHERE id = :id', [':id' => $s['merchant_id']]);
            $d['merchantName'] = $m ? (json_decode($m['doc'], true)['name'] ?? '-') : '-';
            $d['liveStatus'] = self::liveStatus($d, $now, $grace);
            $d['dueAmount'] = self::dueAmount($d, $d['liveStatus']);
            if (!empty($q['status']) && $q['status'] !== 'all' && $d['liveStatus'] !== $q['status']) {
                continue;
            }
            $data[] = $d;
        }
        return Response::json(['data' => $data, 'total' => count($data)]);
    }

    private static function updateSubscription(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $row = $ctx->db->first('SELECT merchant_id, doc FROM subscriptions WHERE id = :id', [':id' => $p['id']]) ?? throw HttpError::notFound('Subscription');
        $b = $ctx->body();
        $action = $b['action'] ?? 'update';
        $existing = json_decode($row['doc'], true);

        if ($action === 'renew') {
            $months = ($existing['billingPeriod'] ?? 'monthly') === 'yearly' ? 12 : 1;
            $base = max($existing['expiresAt'] ?? Clock::now(), Clock::now());
            $newExpiry = (new \DateTimeImmutable($base))->modify("+{$months} months")->format('Y-m-d\TH:i:s.v\Z');
            $doc = Provision::subscribe($ctx->db, $row['merchant_id'], $existing['planId'], 'active', $existing['startedAt'] ?? null, $newExpiry);
        } elseif ($action === 'cancel') {
            $doc = Provision::subscribe($ctx->db, $row['merchant_id'], $existing['planId'], 'cancelled', $existing['startedAt'] ?? null);
        } elseif ($action === 'change-plan') {
            $doc = Provision::subscribe($ctx->db, $row['merchant_id'], $b['planId'] ?? null, 'active');
        } else {
            $status = in_array($b['status'] ?? null, ['pending', 'active', 'trialing', 'expired', 'cancelled'], true) ? $b['status'] : ($existing['status'] ?? 'pending');
            $doc = Provision::subscribe($ctx->db, $row['merchant_id'], $b['planId'] ?? $existing['planId'], $status, $existing['startedAt'] ?? null);
        }
        Audit::record($ctx, 'update', 'subscription', $p['id'], ['meta' => ['action' => $action]]);
        return Response::json($doc);
    }

    /* ---------------------------------------------------------- payments */

    private const PAY_TYPES = ['initial', 'monthly', 'branch'];

    private static function payments(Context $ctx): Response
    {
        $ctx->requirePlatformAdmin();
        $q = $ctx->request->query;
        $rows = $ctx->db->all('SELECT merchant_id, doc FROM subscription_payments ORDER BY at DESC');
        $data = [];
        foreach ($rows as $x) {
            $d = json_decode($x['doc'], true);
            $m = $ctx->db->first('SELECT doc FROM merchants WHERE id = :id', [':id' => $x['merchant_id']]);
            $d['merchantName'] = $m ? (json_decode($m['doc'], true)['name'] ?? '-') : '-';
            $bz = $ctx->db->first('SELECT doc FROM businesses WHERE merchant_id = :m', [':m' => $x['merchant_id']]);
            $d['businessName'] = $bz ? (json_decode($bz['doc'], true)['name'] ?? $d['merchantName']) : $d['merchantName'];
            if (!empty($q['type']) && $q['type'] !== 'all' && ($d['type'] ?? 'monthly') !== $q['type']) {
                continue;
            }
            if (!empty($q['status']) && $q['status'] !== 'all' && ($d['status'] ?? 'paid') !== $q['status']) {
                continue;
            }
            if (!empty($q['merchantId']) && $d['merchantId'] !== $q['merchantId']) {
                continue;
            }
            $data[] = $d;
        }
        $sum = array_sum(array_map(static fn ($d) => ($d['status'] ?? 'paid') === 'paid' ? ($d['amount'] ?? 0) : 0, $data));
        return Response::json(['data' => $data, 'total' => count($data), 'sum' => $sum]);
    }

    private static function recordPayment(Context $ctx): Response
    {
        $ctx->requirePlatformAdmin();
        $b = $ctx->body();
        $mid = (string) ($b['merchantId'] ?? '');
        $amount = (int) ($b['amount'] ?? 0);
        if ($mid === '' || $amount <= 0) {
            throw HttpError::badRequest('merchantId and a positive amount are required');
        }
        $type = in_array($b['type'] ?? null, self::PAY_TYPES, true) ? $b['type'] : 'monthly';
        $status = in_array($b['status'] ?? null, ['pending', 'paid', 'failed'], true) ? $b['status'] : 'paid';
        $sub = $ctx->db->first('SELECT id, doc FROM subscriptions WHERE merchant_id = :m', [':m' => $mid]);
        $subDoc = $sub ? json_decode($sub['doc'], true) : [];
        $id = Uuid::v4();
        $now = Clock::now();
        $doc = [
            'id' => $id, 'merchantId' => $mid, 'subscriptionId' => $sub['id'] ?? null,
            'planId' => $b['planId'] ?? ($subDoc['planId'] ?? null),
            'type' => $type, 'status' => $status, 'amount' => $amount,
            'method' => $b['method'] ?? 'manual', 'reference' => $b['reference'] ?? null,
            'branchRef' => $b['branchRef'] ?? null, 'note' => $b['note'] ?? '',
            'periodStart' => $b['periodStart'] ?? $now,
            'periodEnd' => $b['periodEnd'] ?? ($subDoc['expiresAt'] ?? null),
            'submittedBy' => $ctx->actor['name'] ?? 'Super Admin',
            'confirmedBy' => $status === 'paid' ? ($ctx->actor['name'] ?? 'Super Admin') : null,
            'confirmedAt' => $status === 'paid' ? $now : null,
            'at' => $b['at'] ?? $now, 'createdAt' => $now, 'updatedAt' => $now,
        ];
        $ctx->db->run(
            'INSERT INTO subscription_payments (id, merchant_id, subscription_id, plan_id, type, status, amount, method, period_start, period_end, at, doc, created_at, updated_at)
             VALUES (:id,:m,:sid,:pid,:ty,:st,:amt,:mth,:ps,:pe,:at,:d,:c,:c)',
            [':id' => $id, ':m' => $mid, ':sid' => $doc['subscriptionId'], ':pid' => $doc['planId'], ':ty' => $type, ':st' => $status, ':amt' => $amount,
             ':mth' => $doc['method'], ':ps' => $doc['periodStart'], ':pe' => $doc['periodEnd'], ':at' => $doc['at'], ':d' => json_encode($doc), ':c' => $now],
        );
        if ($status === 'paid') {
            self::applyConfirmedPayment($ctx, $doc);
        }
        Audit::record($ctx, 'create', 'subscription_payment', $id, ['after' => $doc]);
        return Response::json($doc, 201);
    }

    private static function updatePayment(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $row = $ctx->db->first('SELECT doc FROM subscription_payments WHERE id = :id', [':id' => $p['id']]) ?? throw HttpError::notFound('Payment');
        $doc = json_decode($row['doc'], true);
        $b = $ctx->body();
        $status = in_array($b['status'] ?? null, ['paid', 'failed', 'refunded', 'rejected'], true) ? $b['status'] : null;
        if ($status === null) {
            throw HttpError::badRequest('status must be paid, rejected, failed or refunded');
        }
        $wasPaid = ($doc['status'] ?? 'pending') === 'paid';
        $now = Clock::now();
        $doc['status'] = $status;
        $doc['confirmedBy'] = $ctx->actor['name'] ?? 'Super Admin';
        $doc['confirmedAt'] = $now;
        if (isset($b['note'])) {
            $doc['adminNote'] = (string) $b['note'];
        }
        if ($status === 'rejected' && isset($b['reason'])) {
            $doc['rejectedReason'] = (string) $b['reason'];
        }
        $doc['updatedAt'] = $now;
        $ctx->db->run('UPDATE subscription_payments SET status = :s, doc = :d, updated_at = :u WHERE id = :id',
            [':s' => $status, ':d' => json_encode($doc), ':u' => $now, ':id' => $p['id']]);
        if ($status === 'paid' && !$wasPaid) {
            self::applyConfirmedPayment($ctx, $doc);
        }
        if ($status === 'rejected' && !empty($doc['branchRef'])) {
            $br = $ctx->db->first('SELECT doc FROM branch_requests WHERE id = :id', [':id' => $doc['branchRef']]);
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
        Audit::record($ctx, 'update', 'subscription_payment', $p['id'], ['meta' => ['status' => $status]]);
        return Response::json($doc);
    }

    /** Push a just-confirmed payment into the merchant's subscription state. */
    public static function applyConfirmedPayment(Context $ctx, array $pay): void
    {
        $mid = $pay['merchantId'];
        $sub = $ctx->db->first('SELECT doc FROM subscriptions WHERE merchant_id = :m', [':m' => $mid]);
        if (!$sub) {
            return;
        }
        $s = json_decode($sub['doc'], true);
        $now = Clock::now();
        if (($pay['type'] ?? 'monthly') === 'initial') {
            Provision::subscribe($ctx->db, $mid, $s['planId'] ?? null, 'active', $now, null, ['setupPaid' => true, 'lastPaymentAt' => $now]);
        } elseif (($pay['type'] ?? 'monthly') === 'branch') {
            $ls = self::liveStatus($s, $now, self::graceDays($ctx));
            Provision::subscribe($ctx->db, $mid, $s['planId'] ?? null, $ls === 'expired' ? 'active' : ($s['status'] ?? 'active'),
                $s['startedAt'] ?? null, $s['expiresAt'] ?? null,
                ['extraBranchesPaid' => (int) ($s['extraBranchesPaid'] ?? 0) + 1, 'lastPaymentAt' => $now]);
            if (!empty($pay['branchRef'])) {
                $reqRow = $ctx->db->first("SELECT doc FROM branch_requests WHERE id = :id AND status <> 'activated'", [':id' => $pay['branchRef']]);
                if ($reqRow) {
                    $req = json_decode($reqRow['doc'], true);
                    // create the paid-for branch so it is immediately usable
                    $code = strtoupper(preg_replace('/[^A-Z0-9]/', '', strtoupper((string) ($req['code'] ?: $req['name']))));
                    $code = substr($code, 0, 6) ?: 'BR';
                    if ($ctx->db->first('SELECT 1 FROM branches WHERE merchant_id = :m AND code = :c', [':m' => $mid, ':c' => $code])) {
                        $code .= (string) random_int(10, 99);
                    }
                    $bid = Uuid::v4();
                    $bdoc = ['id' => $bid, 'name' => $req['name'], 'code' => $code, 'address' => $req['address'] ?? '', 'phone' => '', 'email' => '', 'isDefault' => false, 'status' => 'active', 'createdAt' => $now, 'updatedAt' => $now];
                    $ctx->db->run('INSERT INTO branches (id, merchant_id, code, name, status, is_default, doc, created_at, updated_at) VALUES (:id,:m,:c,:n,:s,0,:d,:ca,:ca)',
                        [':id' => $bid, ':m' => $mid, ':c' => $code, ':n' => $req['name'], ':s' => 'active', ':d' => json_encode($bdoc), ':ca' => $now]);
                    $req['status'] = 'activated';
                    $req['paymentId'] = $pay['id'];
                    $req['branchId'] = $bid;
                    $req['updatedAt'] = $now;
                    $ctx->db->run("UPDATE branch_requests SET status = 'activated', payment_id = :pid, branch_id = :bid, doc = :d, updated_at = :u WHERE id = :id",
                        [':pid' => $pay['id'], ':bid' => $bid, ':d' => json_encode($req), ':u' => $now, ':id' => $pay['branchRef']]);
                }
            }
        } else {
            $months = ($s['billingPeriod'] ?? 'monthly') === 'yearly' ? 12 : 1;
            $base = max($s['expiresAt'] ?? $now, $now);
            $newExpiry = (new \DateTimeImmutable($base))->modify("+{$months} months")->format('Y-m-d\TH:i:s.v\Z');
            Provision::subscribe($ctx->db, $mid, $s['planId'] ?? null, 'active', $s['startedAt'] ?? null, $newExpiry, ['lastPaymentAt' => $now]);
        }
    }

    private static function revenue(Context $ctx): Response
    {
        $ctx->requirePlatformAdmin();
        $all = array_map(static fn ($x) => json_decode($x['doc'], true), $ctx->db->all('SELECT doc FROM subscription_payments'));
        $pays = array_values(array_filter($all, static fn ($p) => ($p['status'] ?? 'paid') === 'paid'));
        $monthKey = substr(Clock::now(), 0, 7);
        $dayKey = substr(Clock::now(), 0, 10);
        $byMonth = $byPlan = [];
        $byType = ['initial' => 0, 'monthly' => 0, 'branch' => 0];
        $today = $thisMonth = 0;
        foreach ($pays as $p) {
            $mk = substr((string) ($p['at'] ?? ''), 0, 7);
            $byMonth[$mk] = ($byMonth[$mk] ?? 0) + ($p['amount'] ?? 0);
            $byPlan[$p['planId'] ?? 'unknown'] = ($byPlan[$p['planId'] ?? 'unknown'] ?? 0) + ($p['amount'] ?? 0);
            $byType[$p['type'] ?? 'monthly'] = ($byType[$p['type'] ?? 'monthly'] ?? 0) + ($p['amount'] ?? 0);
            if ($mk === $monthKey) {
                $thisMonth += $p['amount'] ?? 0;
            }
            if (substr((string) ($p['at'] ?? ''), 0, 10) === $dayKey) {
                $today += $p['amount'] ?? 0;
            }
        }
        ksort($byMonth);
        $planNames = [];
        foreach (Plans::all($ctx, false) as $pl) {
            $planNames[$pl['id']] = $pl['name'];
        }
        $pending = array_values(array_filter($all, static fn ($p) => ($p['status'] ?? 'paid') === 'pending'));
        $failed = array_values(array_filter($all, static fn ($p) => ($p['status'] ?? '') === 'failed'));
        $rejected = array_values(array_filter($all, static fn ($p) => ($p['status'] ?? '') === 'rejected'));

        $grace = self::graceDays($ctx);
        $now = Clock::now();
        $soon = (new \DateTimeImmutable($now))->modify('+30 days')->format('Y-m-d\TH:i:s.v\Z');
        $upcoming = [];
        foreach ($ctx->db->all('SELECT merchant_id, doc FROM subscriptions') as $srow) {
            $s = json_decode($srow['doc'], true);
            $ls = self::liveStatus($s, $now, $grace);
            if (in_array($ls, ['active', 'past_due'], true) && !empty($s['nextBillingAt']) && $s['nextBillingAt'] <= $soon) {
                $m = $ctx->db->first('SELECT doc FROM merchants WHERE id = :id', [':id' => $srow['merchant_id']]);
                $upcoming[] = [
                    'merchantId' => $srow['merchant_id'],
                    'merchantName' => $m ? (json_decode($m['doc'], true)['name'] ?? '-') : '-',
                    'dueAt' => $s['nextBillingAt'], 'amount' => (int) ($s['monthlyPrice'] ?? $s['planPrice'] ?? 0),
                ];
            }
        }
        usort($upcoming, static fn ($a, $b) => strcmp($a['dueAt'] ?? '', $b['dueAt'] ?? ''));

        return Response::json([
            'total' => array_sum(array_map(static fn ($p) => $p['amount'] ?? 0, $pays)),
            'count' => count($pays),
            'today' => $today, 'thisMonth' => $thisMonth,
            'byType' => $byType,
            'pendingCount' => count($pending), 'pendingSum' => array_sum(array_map(static fn ($p) => $p['amount'] ?? 0, $pending)),
            'failedCount' => count($failed),
            'approvedCount' => count($pays), 'rejectedCount' => count($rejected),
            'byMonth' => array_map(static fn ($k, $v) => ['month' => $k, 'amount' => $v], array_keys($byMonth), $byMonth),
            'byPlan' => array_map(static fn ($k, $v) => ['planId' => $k, 'planName' => $planNames[$k] ?? 'Unknown', 'amount' => $v], array_keys($byPlan), $byPlan),
            'upcoming' => $upcoming,
        ]);
    }

    /* ---------------------------------------------------------- support */

    private static function support(Context $ctx): Response
    {
        $ctx->requirePlatformAdmin();
        $q = $ctx->request->query;
        $where = $q['status'] ?? null;
        $sql = 'SELECT doc FROM support_requests' . ($where && $where !== 'all' ? ' WHERE status = :s' : '') . ' ORDER BY at DESC';
        $rows = $ctx->db->all($sql, $where && $where !== 'all' ? [':s' => $where] : []);
        return Response::json([
            'data' => array_map(static fn ($x) => json_decode($x['doc'], true), $rows),
            'open' => (int) $ctx->db->value("SELECT COUNT(*) FROM support_requests WHERE status = 'open'"),
        ]);
    }

    private static function supportReply(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $row = $ctx->db->first('SELECT doc FROM support_requests WHERE id = :id', [':id' => $p['id']]) ?? throw HttpError::notFound('Support request');
        $doc = json_decode($row['doc'], true);
        $text = trim((string) ($ctx->body()['text'] ?? ''));
        if ($text === '') {
            throw HttpError::badRequest('Reply text is required');
        }
        $doc['replies'][] = ['by' => $ctx->actor['name'], 'text' => $text, 'at' => Clock::now()];
        $doc['status'] = 'answered';
        $doc['updatedAt'] = Clock::now();
        $ctx->db->run('UPDATE support_requests SET status = :s, doc = :d, updated_at = :u WHERE id = :id',
            [':s' => 'answered', ':d' => json_encode($doc), ':u' => $doc['updatedAt'], ':id' => $p['id']]);
        return Response::json($doc);
    }

    private static function supportStatus(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $row = $ctx->db->first('SELECT doc FROM support_requests WHERE id = :id', [':id' => $p['id']]) ?? throw HttpError::notFound('Support request');
        $doc = json_decode($row['doc'], true);
        $status = in_array($ctx->body()['status'] ?? null, ['open', 'answered', 'closed'], true) ? $ctx->body()['status'] : $doc['status'];
        $doc['status'] = $status;
        $doc['updatedAt'] = Clock::now();
        $ctx->db->run('UPDATE support_requests SET status = :s, doc = :d, updated_at = :u WHERE id = :id',
            [':s' => $status, ':d' => json_encode($doc), ':u' => $doc['updatedAt'], ':id' => $p['id']]);
        return Response::json($doc);
    }

    /* -------------------------------------------------- platform settings */

    private static function publicSettings(Context $ctx): Response
    {
        $s = Provision::platformSettings($ctx->db);
        $c = $s['contact'];
        return Response::json([
            'contact' => [
                'businessName' => $c['businessName'], 'whatsapp' => $c['whatsapp'],
                'supportPhone' => $c['supportPhone'], 'email' => $c['email'],
                'salesEmail' => $c['salesEmail'], 'address' => $c['address'],
                'supportHours' => $c['supportHours'], 'website' => $c['website'],
            ],
            'currency' => $s['billing']['currency'],
            'currencySymbol' => $s['billing']['currencySymbol'],
        ]);
    }

    private static function getSettings(Context $ctx): Response
    {
        $ctx->requirePlatformAdmin();
        return Response::json(Provision::platformSettings($ctx->db));
    }

    private static function updateSettings(Context $ctx): Response
    {
        $ctx->requirePlatformAdmin();
        Provision::ensurePlatformSettings($ctx->db);
        $current = Provision::platformSettings($ctx->db);
        // whitelist: a client cannot PATCH arbitrary keys into the settings doc
        $body = array_intersect_key($ctx->body(), array_flip(['contact', 'billing', 'gateway', 'paymentMethods']));
        if (array_key_exists('paymentMethods', $body)) {
            $body['paymentMethods'] = Provision::normalizePaymentMethods((array) $body['paymentMethods']);
        }
        $merged = Provision::deepMerge($current, $body);
        $merged['id'] = 'platform';
        $now = Clock::now();
        $ctx->db->run('UPDATE platform_settings SET doc = :d, updated_at = :u WHERE id = :id',
            [':d' => json_encode($merged, JSON_UNESCAPED_UNICODE), ':u' => $now, ':id' => 'platform']);
        Audit::record($ctx, 'settings', 'platform_settings', 'platform', ['after' => $merged]);
        return Response::json(Provision::platformSettings($ctx->db));
    }
}
