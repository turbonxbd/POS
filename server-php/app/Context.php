<?php
declare(strict_types=1);

namespace Afia;

use Afia\Http\Request;
use Afia\Support\HttpError;
use Afia\Support\Rbac;

/**
 * Request-scoped state handed to every route handler.
 * Once a session is resolved, $repo is bound to the caller's merchant so a
 * handler cannot reach another tenant's data.
 */
final class Context
{
    public ?array $actor = null;        // user doc (+ merchantId, isPlatformAdmin)
    public ?string $merchantId = null;
    public ?array $role = null;
    /** @var array<string,bool> */
    public array $permissions = [];
    public ?array $session = null;
    public ?string $csrf = null;
    public ?Repo $repo = null;

    public function __construct(
        public Database $db,
        public Request $request,
        public array $config,
    ) {}

    public function repo(): Repo
    {
        if ($this->repo === null) {
            throw HttpError::unauthorized();
        }
        return $this->repo;
    }

    public function requireActor(): array
    {
        if ($this->actor === null) {
            throw HttpError::unauthorized();
        }
        return $this->actor;
    }

    public function requirePlatformAdmin(): array
    {
        $actor = $this->requireActor();
        if (empty($actor['isPlatformAdmin'])) {
            throw HttpError::forbidden('Super Admin access required');
        }
        return $actor;
    }

    public function can(string|array $permission): bool
    {
        return Rbac::can($this->permissions, $permission);
    }

    public function requirePermission(string|array $permission): void
    {
        $this->requireActor();
        if (!$this->can($permission)) {
            $p = is_array($permission) ? implode('|', $permission) : $permission;
            throw HttpError::forbidden("You do not have permission for this action ({$p})");
        }
    }

    public function body(): array
    {
        return $this->request->json();
    }

    public function query(string $key, mixed $default = null): mixed
    {
        return $this->request->query[$key] ?? $default;
    }
}
