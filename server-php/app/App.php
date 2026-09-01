<?php
declare(strict_types=1);

namespace Afia;

use Afia\Http\Request;
use Afia\Http\Response;
use Afia\Http\Router;
use Afia\Support\Clock;
use Afia\Support\HttpError;
use Afia\Support\Rbac;
use Afia\Support\Session;

final class App
{
    private Router $router;

    /** Route modules. Each exposes static register(Router, App). */
    private const MODULES = [
        \Afia\Modules\Health::class,
        \Afia\Modules\Auth::class,
        \Afia\Modules\Catalog::class,
        \Afia\Modules\Inventory::class,
        \Afia\Modules\Sales::class,
        \Afia\Modules\Purchasing::class,
        \Afia\Modules\People::class,
        \Afia\Modules\Finance::class,
        \Afia\Modules\Org::class,
        \Afia\Modules\Analytics::class,
        \Afia\Modules\Media::class,
        \Afia\Modules\Plans::class,
        \Afia\Modules\Signup::class,
        \Afia\Modules\Billing::class,
        \Afia\Modules\Chat::class,
        \Afia\Modules\Sync::class,
        \Afia\Modules\Platform::class,
    ];

    public function __construct(
        public Database $db,
        public array $config,
    ) {
        $this->router = new Router();
        foreach (self::MODULES as $module) {
            $module::register($this->router, $this);
        }
    }

    public function session(): Session
    {
        return new Session($this->db, $this->config['session']);
    }

    public function handle(Request $request): Response
    {
        $ctx = new Context($this->db, $request, $this->config);

        // strip the /api mount prefix
        $path = $request->path;
        if (str_starts_with($path, '/api/')) {
            $path = substr($path, 4);
        } elseif ($path === '/api') {
            $path = '/';
        }

        if ($request->method === 'OPTIONS') {
            return Response::noContent();
        }

        try {
            $this->resolveSession($ctx);

            if (!$request->isSafe() && $path !== '/auth/login' && $ctx->csrf !== null) {
                $this->session()->assertCsrf($request, $ctx->csrf);
            }

            $this->enforceAccessGate($ctx, $path);

            // Defence in depth: every /platform/* route is Super-Admin-only,
            // enforced here on top of each handler's own requirePlatformAdmin().
            if (str_starts_with($path, '/platform/')) {
                $ctx->requirePlatformAdmin();
            }

            [$handler, $params] = $this->router->match($request->method, $path);
            $response = $handler($ctx, $params);
            if (!$response instanceof Response) {
                $response = Response::json($response);
            }
            return $response;
        } catch (HttpError $e) {
            return Response::json($e->body(), $e->status);
        } catch (\Throwable $e) {
            error_log('[afia] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
            $debug = ($this->config['app']['env'] ?? 'production') !== 'production';
            return Response::json(
                ['message' => $debug ? $e->getMessage() : 'Internal server error'],
                500,
            );
        }
    }

    /**
     * Soft access gate: a merchant whose subscription is blocked (expired past
     * the grace window, suspended, cancelled) may still READ their data and pay,
     * but cannot make changes. Safe methods and a small allow-list are exempt.
     */
    private function enforceAccessGate(Context $ctx, string $path): void
    {
        if ($ctx->request->isSafe() || $ctx->actor === null || !empty($ctx->actor['isPlatformAdmin']) || ($ctx->merchantId ?? '') === '') {
            return;
        }
        foreach (['#^/auth/#', '#^/billing/#', '#^/public#', '#^/plans$#', '#^/signup$#', '#^/support$#'] as $re) {
            if (preg_match($re, $path)) {
                return;
            }
        }
        $row = $this->db->first('SELECT doc FROM subscriptions WHERE merchant_id = :m', [':m' => $ctx->merchantId]);
        if (!$row) {
            return;
        }
        $sub = json_decode($row['doc'], true);
        $state = \Afia\Modules\Platform::liveStatus($sub, Clock::now(), \Afia\Modules\Platform::graceDays($ctx));
        if (in_array($state, ['expired', 'suspended', 'cancelled'], true)) {
            throw new HttpError(402, 'Your subscription needs attention before you can make changes.', [
                'subscriptionBlocked' => true,
                'state' => $state,
                'dueAmount' => \Afia\Modules\Platform::dueAmount($sub, $state),
            ]);
        }
    }

    private function resolveSession(Context $ctx): void
    {
        $sess = $this->session()->read($ctx->request);
        if ($sess === null) {
            return;
        }
        $userRow = $sess['user_row'];
        $user = json_decode($userRow['doc'], true);
        $user['merchantId'] = $userRow['merchant_id'];
        $user['isPlatformAdmin'] = (int) $userRow['is_platform_admin'] === 1;

        $role = null;
        if (!empty($user['roleId'])) {
            $roleRow = $this->db->first(
                "SELECT doc FROM roles WHERE id = :id AND (merchant_id = :m OR merchant_id = '')",
                [':id' => $user['roleId'], ':m' => $user['merchantId']],
            );
            $role = $roleRow ? json_decode($roleRow['doc'], true) : null;
        }

        $ctx->actor = $user;
        $ctx->merchantId = $user['merchantId'];
        $ctx->role = $role;
        $ctx->permissions = Rbac::resolve($user, $role);
        $ctx->session = $sess['session'];
        $ctx->csrf = $sess['csrf'];
        $ctx->repo = new Repo($this->db, $user['merchantId']);
    }
}
