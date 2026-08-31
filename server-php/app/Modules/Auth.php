<?php
declare(strict_types=1);

namespace Afia\Modules;

use Afia\App;
use Afia\Context;
use Afia\Repo;
use Afia\Http\Response;
use Afia\Http\Router;
use Afia\Support\Audit;
use Afia\Support\Clock;
use Afia\Support\HttpError;
use Afia\Support\Password;
use Afia\Support\Uuid;

/**
 * Real authentication. Same paths + response shapes as js/core/mock/auth.routes.js.
 *   POST /auth/login            -> { token, expiresAt, user, role, business, branches, subscription }
 *   GET  /auth/me               -> { user, role, business, branches, subscription }
 *   POST /auth/logout           -> { ok: true }
 *   POST /auth/change-password  -> { ok: true }
 */
final class Auth
{
    private const WINDOW_SECONDS = 900;   // 15 min
    private const MAX_ATTEMPTS = 8;

    public static function register(Router $r, App $app): void
    {
        $r->post('/auth/login', fn (Context $c) => self::login($c, $app));
        $r->get('/auth/me', fn (Context $c) => self::me($c));
        $r->post('/auth/logout', fn (Context $c) => self::logout($c, $app));
        $r->post('/auth/change-password', fn (Context $c) => self::changePassword($c, $app));
    }

    /** Sign in with credentials already in the request body. Used by /signup. */
    public static function loginProgrammatic(Context $ctx, App $app): Response
    {
        return self::login($ctx, $app);
    }

    private static function login(Context $ctx, App $app): Response
    {
        $body = $ctx->body();
        $email = strtolower(trim((string) ($body['email'] ?? '')));
        $password = (string) ($body['password'] ?? '');

        if ($email === '' || $password === '') {
            throw HttpError::badRequest('Email and password are required', array_filter([
                'email' => $email === '' ? 'Required' : null,
                'password' => $password === '' ? 'Required' : null,
            ]));
        }

        if (self::recentFailures($ctx, $email) >= self::MAX_ATTEMPTS) {
            throw HttpError::tooMany('Too many failed sign-in attempts. Wait 15 minutes and try again.');
        }

        $row = $ctx->db->first('SELECT * FROM users WHERE email = :e', [':e' => $email]);
        if (!$row) {
            Password::hash($password);               // equalise timing
            self::recordAttempt($ctx, $email, false);
            throw HttpError::unauthorized('Incorrect email or password');
        }

        $user = json_decode($row['doc'], true);
        $user['merchantId'] = $row['merchant_id'];
        $user['isPlatformAdmin'] = (int) $row['is_platform_admin'] === 1;

        if ($row['status'] !== 'active') {
            throw HttpError::forbidden('This account is deactivated. Contact an administrator.');
        }
        if (!Password::verify($password, $row['password_hash'])) {
            self::recordAttempt($ctx, $email, false);
            Audit::record($ctx, 'login_failed', 'user', $user['id'], ['meta' => ['email' => $email], 'actor' => $user]);
            throw HttpError::unauthorized('Incorrect email or password');
        }

        self::recordAttempt($ctx, $email, true);
        if (Password::needsRehash($row['password_hash'])) {
            $ctx->db->run('UPDATE users SET password_hash = :h WHERE id = :id', [':h' => Password::hash($password), ':id' => $user['id']]);
        }
        $ctx->db->run('UPDATE users SET updated_at = :n WHERE id = :id', [':n' => Clock::now(), ':id' => $user['id']]);
        $ctx->db->run(
            'UPDATE users SET doc = :d WHERE id = :id',
            [':d' => json_encode(array_merge(json_decode($row['doc'], true), ['lastLoginAt' => Clock::now()]), JSON_UNESCAPED_UNICODE), ':id' => $user['id']],
        );

        $repo = new Repo($ctx->db, $user['merchantId']);
        $hydrated = self::hydrateUser($repo, $user);
        $org = self::orgContext($ctx, $repo);

        $cookies = $app->session()->start($hydrated['user'] + ['merchantId' => $user['merchantId']], $ctx->request);
        Audit::record($ctx, 'login', 'user', $user['id'], ['meta' => ['email' => $email], 'actor' => $hydrated['user']]);

        $res = Response::json(array_merge([
            'token' => Uuid::v4(), // opaque marker only; the real session is the httpOnly cookie
            'expiresAt' => Clock::addMinutes(Clock::now(), (int) $ctx->config['session']['idle_minutes']),
        ], $hydrated, $org));
        foreach ($cookies as $ck) {
            $res->withCookie($ck);
        }
        return $res;
    }

    private static function me(Context $ctx): Response
    {
        $actor = $ctx->actor;
        if ($actor === null) {
            throw HttpError::unauthorized('Not authenticated');
        }
        $repo = $ctx->repo();
        $userDoc = $repo->doc('users', $actor['id']) ?? throw HttpError::unauthorized('Session user no longer exists');
        $userDoc['merchantId'] = $actor['merchantId'];
        $userDoc['isPlatformAdmin'] = $actor['isPlatformAdmin'] ?? false;
        return Response::json(array_merge(self::hydrateUser($repo, $userDoc), self::orgContext($ctx, $repo)));
    }

    private static function logout(Context $ctx, App $app): Response
    {
        if ($ctx->actor !== null) {
            Audit::record($ctx, 'logout', 'user', $ctx->actor['id']);
        }
        $res = Response::json(['ok' => true]);
        foreach ($app->session()->destroy($ctx->request) as $ck) {
            $res->withCookie($ck);
        }
        return $res;
    }

    private static function changePassword(Context $ctx, App $app): Response
    {
        $actor = $ctx->requireActor();
        $body = $ctx->body();
        $current = (string) ($body['currentPassword'] ?? '');
        $next = (string) ($body['newPassword'] ?? '');

        if (strlen($next) < 8) {
            throw HttpError::badRequest('Password too short', ['newPassword' => 'Use at least 8 characters']);
        }
        $row = $ctx->db->first('SELECT password_hash FROM users WHERE id = :id', [':id' => $actor['id']]);
        if (!$row) {
            throw HttpError::notFound('User');
        }
        if (!Password::verify($current, $row['password_hash'])) {
            throw HttpError::badRequest('Current password is incorrect', ['currentPassword' => 'Incorrect']);
        }
        $ctx->db->run('UPDATE users SET password_hash = :h, updated_at = :n WHERE id = :id',
            [':h' => Password::hash($next), ':n' => Clock::now(), ':id' => $actor['id']]);
        $app->session()->revokeOtherSessions($actor['id'], $ctx->session['id']);
        Audit::record($ctx, 'update', 'user', $actor['id'], ['meta' => ['field' => 'password']]);
        return Response::json(['ok' => true]);
    }

    /* ---------------------------------------------------------------- helpers */

    private static function recordAttempt(Context $ctx, string $email, bool $ok): void
    {
        $ctx->db->run('INSERT INTO login_attempts (id, email, ip, ok, at) VALUES (:id, :e, :ip, :ok, :at)',
            [':id' => Uuid::v4(), ':e' => $email, ':ip' => $ctx->request->ip, ':ok' => $ok ? 1 : 0, ':at' => Clock::now()]);
    }

    private static function recentFailures(Context $ctx, string $email): int
    {
        $since = Clock::addMinutes(Clock::now(), -15);
        return (int) $ctx->db->value(
            'SELECT COUNT(*) FROM login_attempts WHERE email = :e AND ok = 0 AND at >= :s',
            [':e' => $email, ':s' => $since],
        );
    }

    private static function hydrateUser(Repo $repo, array $user): array
    {
        $role = !empty($user['roleId'])
            ? ($repo->db()->first("SELECT doc FROM roles WHERE id = :id AND (merchant_id = :m OR merchant_id = '')", [':id' => $user['roleId'], ':m' => $repo->merchantId()]))
            : null;
        $role = $role ? json_decode($role['doc'], true) : null;

        $employee = $repo->findDoc('employees', 'user_id = :u', [':u' => $user['id']]);
        $allBranchIds = array_column($repo->allDocs('branches', 'archived_at IS NULL'), 'id');
        $branchIds = !empty($employee['branchIds']) ? $employee['branchIds'] : $allBranchIds;

        return [
            'user' => [
                'id' => $user['id'], 'name' => $user['name'], 'email' => $user['email'],
                'phone' => $user['phone'] ?? null, 'avatar' => $user['avatar'] ?? null,
                'roleId' => $user['roleId'] ?? null, 'roleName' => $role['name'] ?? 'User',
                'status' => $user['status'], 'merchantId' => $repo->merchantId(),
                'isPlatformAdmin' => $user['isPlatformAdmin'] ?? false,
                'permissionGrants' => $user['permissionGrants'] ?? [],
                'permissionRevokes' => $user['permissionRevokes'] ?? [],
                'discountLimitPct' => $role['discountLimitPct'] ?? 0,
                'branchIds' => $branchIds, 'lastLoginAt' => $user['lastLoginAt'] ?? null,
            ],
            'role' => $role,
        ];
    }

    private static function orgContext(Context $ctx, Repo $repo): array
    {
        $business = $repo->allDocs('businesses', '1=1')[0] ?? null;
        $branches = $repo->allDocs('branches', 'archived_at IS NULL', [], 'is_default DESC, created_at ASC');
        $subscription = $repo->allDocs('subscriptions', '1=1')[0] ?? null;
        return [
            'business' => $business,
            'branches' => $branches,
            'subscription' => $subscription,
            'access' => self::accessFor($ctx, $subscription),
        ];
    }

    /** Access state derived from the subscription - drives the merchant panels' banner + lock-out. */
    public static function accessFor(Context $ctx, ?array $sub): array
    {
        if (!$sub) {
            return ['state' => 'none', 'blocked' => false, 'dueAmount' => 0, 'nextBillingAt' => null, 'graceUntil' => null, 'reason' => null];
        }
        $now = Clock::now();
        $grace = \Afia\Modules\Platform::graceDays($ctx);
        $state = \Afia\Modules\Platform::liveStatus($sub, $now, $grace);
        $blocked = in_array($state, ['expired', 'suspended', 'cancelled'], true);
        $graceUntil = !empty($sub['expiresAt'])
            ? (new \DateTimeImmutable($sub['expiresAt']))->modify("+{$grace} days")->format('Y-m-d\TH:i:s.v\Z')
            : null;
        $reason = match (true) {
            $state === 'suspended' => 'Your account has been suspended by POS TXbd.',
            $state === 'expired' => 'Your subscription has lapsed. Pay the outstanding server charge to restore access.',
            $state === 'cancelled' => 'Your subscription was cancelled.',
            $state === 'past_due' => 'Your monthly server & backup charge is overdue.',
            $state === 'pending' && empty($sub['setupPaid']) => 'Pay the one-time setup fee to activate your account.',
            default => null,
        };
        return [
            'state' => $state,
            'blocked' => $blocked,
            'dueAmount' => \Afia\Modules\Platform::dueAmount($sub, $state),
            'nextBillingAt' => $sub['nextBillingAt'] ?? ($sub['expiresAt'] ?? null),
            'graceUntil' => $graceUntil,
            'reason' => $reason,
        ];
    }
}
