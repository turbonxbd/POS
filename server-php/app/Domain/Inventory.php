<?php
declare(strict_types=1);

namespace Afia\Domain;

use Afia\Context;
use Afia\Support\Clock;
use Afia\Support\HttpError;
use Afia\Support\Money;
use Afia\Support\Notify;
use Afia\Support\Uuid;

/**
 * The inventory ledger. Every quantity change goes through post() so the
 * immutable `inventory_transactions` row and the cached `stock` balance can
 * never diverge. Ported from js/core/mock/helpers.js postInventory().
 *
 * MUST be called inside $ctx->db->transaction().
 */
final class Inventory
{
    public static function stockId(string $branchId, string $productId, ?string $variantId): string
    {
        return 'stk_' . $branchId . '_' . $productId . '_' . ($variantId ?: 'base');
    }

    public static function qty(Context $ctx, string $branchId, string $productId, ?string $variantId = null): int
    {
        $row = $ctx->repo()->doc('stock', self::stockId($branchId, $productId, $variantId));
        return (int) ($row['quantity'] ?? 0);
    }

    public static function avgCost(Context $ctx, string $branchId, string $productId, ?string $variantId = null): int
    {
        $row = $ctx->repo()->doc('stock', self::stockId($branchId, $productId, $variantId));
        return (int) ($row['avgCost'] ?? 0);
    }

    /**
     * @param array{branchId:string,productId:string,variantId?:?string,type:string,
     *   qtyDelta:int,unitCost?:int,refType?:?string,refId?:?string,note?:string,allowNegative?:bool} $m
     * @return array{ledger:array,balanceAfter:int}
     */
    public static function post(Context $ctx, array $m): array
    {
        $repo = $ctx->repo();
        $branchId = $m['branchId'];
        $productId = $m['productId'];
        $variantId = $m['variantId'] ?? null;
        $delta = (int) $m['qtyDelta'];
        if ($delta === 0) {
            throw new HttpError(500, 'postInventory: qtyDelta must be non-zero');
        }
        $unitCost = (int) ($m['unitCost'] ?? 0);
        $allowNegative = (bool) ($m['allowNegative'] ?? false);

        $sid = self::stockId($branchId, $productId, $variantId);
        $row = $repo->doc('stock', $sid);
        $prevQty = (int) ($row['quantity'] ?? 0);
        $nextQty = $prevQty + $delta;

        if ($nextQty < 0 && !$allowNegative) {
            throw HttpError::conflict("Insufficient stock. Available {$prevQty}, requested " . abs($delta) . '.');
        }

        $avgCost = (int) ($row['avgCost'] ?? 0);
        if ($delta > 0 && $unitCost > 0) {
            $totalValue = Money::mul($avgCost, $prevQty) + Money::mul($unitCost, $delta);
            $avgCost = $nextQty > 0 ? (int) round($totalValue / $nextQty) : $unitCost;
        }

        $now = Clock::now();
        $stamp = self::actorStamp($ctx);
        $ledgerId = Uuid::v4();
        $ledger = [
            'id' => $ledgerId, 'branchId' => $branchId, 'productId' => $productId, 'variantId' => $variantId,
            'type' => $m['type'], 'qtyDelta' => $delta, 'balanceAfter' => $nextQty, 'unitCost' => $unitCost,
            'refType' => $m['refType'] ?? null, 'refId' => $m['refId'] ?? null, 'note' => $m['note'] ?? '',
            'userId' => $stamp['userId'], 'userName' => $stamp['userName'], 'at' => $now,
        ];
        $repo->insert('inventory_transactions', $ledgerId, $ledger, [
            'branch_id' => $branchId, 'product_id' => $productId, 'variant_id' => $variantId,
            'type' => $m['type'], 'ref_type' => $ledger['refType'], 'ref_id' => $ledger['refId'], 'at' => $now,
        ]);

        if ($row) {
            $repo->update('stock', $sid, ['quantity' => $nextQty, 'avgCost' => $avgCost, 'lastMovementAt' => $now],
                ['quantity' => $nextQty, 'avg_cost' => $avgCost]);
        } else {
            $repo->insert('stock', $sid, [
                'id' => $sid, 'branchId' => $branchId, 'productId' => $productId, 'variantId' => $variantId,
                'quantity' => $nextQty, 'reserved' => 0, 'avgCost' => $avgCost, 'lastMovementAt' => $now,
            ], [
                'branch_id' => $branchId, 'product_id' => $productId, 'variant_id' => $variantId,
                'quantity' => $nextQty, 'avg_cost' => $avgCost,
            ]);
        }

        self::checkThresholds($ctx, $branchId, $productId, $variantId, $nextQty);
        return ['ledger' => $ledger, 'balanceAfter' => $nextQty];
    }

    private static function checkThresholds(Context $ctx, string $branchId, string $productId, ?string $variantId, int $qty): void
    {
        $repo = $ctx->repo();
        $product = $repo->doc('products', $productId);
        if (!$product) {
            return;
        }
        $min = (int) ($product['minStock'] ?? 0);
        $vlabel = '';
        if ($variantId) {
            foreach ($product['variants'] ?? [] as $v) {
                if ($v['id'] === $variantId) {
                    $min = (int) ($v['minStock'] ?? $min);
                    $vlabel = ' (' . ($v['name'] ?: $v['sku']) . ')';
                }
            }
        }
        $branch = $repo->doc('branches', $branchId);
        $bn = $branch ? ' @ ' . $branch['name'] : '';
        $label = $product['name'] . $vlabel;
        $dupeKey = 'thr_' . self::stockId($branchId, $productId, $variantId);

        if ($qty <= 0) {
            if (!Notify::recent($ctx, 'out_of_stock', $dupeKey)) {
                Notify::push($ctx, 'out_of_stock', 'Out of stock', "{$label}{$bn} is now out of stock.", [
                    'level' => 'danger', 'link' => "#/inventory?product={$productId}",
                    'meta' => ['dupeKey' => $dupeKey, 'productId' => $productId, 'branchId' => $branchId],
                ]);
            }
        } elseif ($min > 0 && $qty <= $min) {
            if (!Notify::recent($ctx, 'low_stock', $dupeKey)) {
                Notify::push($ctx, 'low_stock', 'Low stock warning', "{$label}{$bn} dropped to {$qty} (min {$min}).", [
                    'level' => 'warning', 'link' => "#/inventory?product={$productId}",
                    'meta' => ['dupeKey' => $dupeKey, 'productId' => $productId, 'branchId' => $branchId],
                ]);
            }
        }
    }

    public static function actorStamp(Context $ctx): array
    {
        $a = $ctx->actor;
        return $a ? ['userId' => $a['id'], 'userName' => $a['name']] : ['userId' => null, 'userName' => 'system'];
    }
}
