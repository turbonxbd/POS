<?php
declare(strict_types=1);

namespace Afia\Support;

/**
 * Effective-permission resolution + enforcement, ported from js/core/rbac.js.
 * This is the authoritative check; the frontend copy only hides controls.
 *
 * effective = role.permissions + user.permissionGrants - user.permissionRevokes
 * '*' in the role means every permission.
 */
final class Rbac
{
    public const SUPER = '*';

    /** @return array<string,bool> used as a set */
    public static function resolve(?array $user, ?array $role): array
    {
        $set = [];
        $rolePerms = $role['permissions'] ?? [];
        if (in_array(self::SUPER, $rolePerms, true)) {
            $set[self::SUPER] = true;
        } else {
            foreach ($rolePerms as $p) {
                $set[$p] = true;
            }
        }
        foreach ($user['permissionGrants'] ?? [] as $p) {
            $set[$p] = true;
        }
        foreach ($user['permissionRevokes'] ?? [] as $p) {
            unset($set[$p]);
        }
        return $set;
    }

    public static function can(array $set, string|array $permission): bool
    {
        if (isset($set[self::SUPER])) {
            return true;
        }
        foreach ((array) $permission as $p) {
            if (isset($set[$p])) {
                return true;
            }
        }
        return false;
    }
}
