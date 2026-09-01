<?php
declare(strict_types=1);

namespace Afia\Domain;

use Afia\Support\HttpError;
use Afia\Support\Money;

/**
 * Cart money math. Ported from js/core/mock/helpers.js computeCart() /
 * validatePayments(). All amounts are integer minor units.
 */
final class Cart
{
    /** A discount rule -> the money it takes off $base (minor units). */
    public static function discountRuleAmount(?array $rule, int $base): int
    {
        if (!$rule) {
            return 0;
        }
        if (!empty($rule['minSpend']) && $base < (int) $rule['minSpend']) {
            return 0;
        }
        $amt = ($rule['type'] ?? null) === 'percent'
            ? Money::percent($base, (float) ($rule['value'] ?? 0))
            : Money::toMinor($rule['value'] ?? 0);
        if (!empty($rule['maxDiscount'])) {
            $amt = min($amt, (int) $rule['maxDiscount']);
        }
        return max(0, (int) $amt);
    }

    /** Does a cart line fall inside a discount rule's product / category scope? */
    private static function lineMatchesRule(?array $rule, array $line): bool
    {
        $sc = $rule['scope'] ?? null;
        if (!$sc || $sc === 'cart') {
            return true;
        }
        $list = $rule['appliesTo'] ?? [];
        if (!$list) {
            return true;
        }
        if ($sc === 'product') {
            return in_array($line['productId'] ?? null, $list, true);
        }
        if ($sc === 'category') {
            return isset($line['categoryId']) && in_array($line['categoryId'], $list, true);
        }
        return true;
    }

    private static function ruleAmountOn(array $rule, int $base): int
    {
        $a = ($rule['type'] ?? null) === 'percent'
            ? Money::percent($base, (float) ($rule['value'] ?? 0))
            : Money::toMinor($rule['value'] ?? 0);
        if (!empty($rule['maxDiscount'])) {
            $a = min($a, (int) $rule['maxDiscount']);
        }
        return max(0, (int) $a);
    }

    /**
     * @param list<array{productId:string,variantId?:?string,name:string,sku?:string,
     *   unitPrice:int,qty:int,discountType?:?string,discountValue?:int|float,taxId?:?string,costPrice?:int}> $lines
     * @param array{cartDiscountType?:?string,cartDiscountValue?:int|float,taxes?:list<array>} $opts
     */
    public static function compute(array $lines, array $opts = []): array
    {
        $taxMap = [];
        foreach ($opts['taxes'] ?? [] as $t) {
            $taxMap[$t['id']] = $t;
        }

        // pass 1
        $rows = [];
        foreach ($lines as $line) {
            $qty = (int) ($line['qty'] ?? 0);
            $gross = Money::mul((int) $line['unitPrice'], $qty);
            $lineDiscount = 0;
            if (($line['discountType'] ?? null) === 'percent') {
                $lineDiscount = Money::percent($gross, (float) ($line['discountValue'] ?? 0));
            } elseif (($line['discountType'] ?? null) === 'fixed') {
                $lineDiscount = Money::mul((int) ($line['discountValue'] ?? 0), $qty);
            }
            $lineDiscount = min($lineDiscount, $gross);
            $rows[] = ['line' => $line, 'qty' => $qty, 'gross' => $gross, 'lineDiscount' => $lineDiscount,
                       'net' => $gross - $lineDiscount];
        }

        // pass 2: cart-level discounts. Order: manual -> best automatic -> coupon,
        // each clamped to what is left. A scoped (product / category) discount only
        // draws from the lines it covers; "minimum spend" is against the whole cart.
        $netByLine = array_column($rows, 'net');
        $netSum = array_sum($netByLine);

        $manualCartDiscount = 0;
        if (($opts['cartDiscountType'] ?? null) === 'percent') {
            $manualCartDiscount = Money::percent($netSum, (float) ($opts['cartDiscountValue'] ?? 0));
        } elseif (($opts['cartDiscountType'] ?? null) === 'fixed') {
            $manualCartDiscount = Money::toMinor($opts['cartDiscountValue'] ?? 0);
        }
        $manualCartDiscount = min(max(0, $manualCartDiscount), $netSum);

        $perLine = Money::distribute($manualCartDiscount, $netByLine);
        $remainingByLine = [];
        foreach ($netByLine as $i => $n) {
            $remainingByLine[$i] = $n - ($perLine[$i] ?? 0);
        }
        $applyScoped = static function (array $idx, int $amount) use (&$perLine, &$remainingByLine) {
            $weights = array_map(static fn ($i) => $remainingByLine[$i], $idx);
            $shares = Money::distribute($amount, $weights);
            foreach ($idx as $k => $li) {
                $perLine[$li] = ($perLine[$li] ?? 0) + $shares[$k];
                $remainingByLine[$li] -= $shares[$k];
            }
        };
        $scopedIdx = static function (?array $rule) use ($rows) {
            $out = [];
            foreach ($rows as $i => $r) {
                if (self::lineMatchesRule($rule, $r['line'])) {
                    $out[] = $i;
                }
            }
            return $out;
        };

        // percentage base = the scoped lines' net BEFORE the manual cart discount
        // (a cart-scope rule still measures against the full cart); clamp = remainder.
        $poolOf = static fn (array $idx, array $src) => array_sum(array_map(static fn ($i) => $src[$i], $idx));

        $autoDiscount = 0;
        $autoDiscountName = null;
        $autoIdx = null;
        foreach ($opts['autoDiscounts'] ?? [] as $rule) {
            if (!empty($rule['minSpend']) && $netSum < (int) $rule['minSpend']) {
                continue;
            }
            $idx = $scopedIdx($rule);
            $pool = $poolOf($idx, $remainingByLine);
            if ($pool <= 0) {
                continue;
            }
            $amt = min(self::ruleAmountOn($rule, $poolOf($idx, $netByLine)), $pool);
            if ($amt > $autoDiscount) {
                $autoDiscount = $amt;
                $autoDiscountName = $rule['name'] ?? 'Automatic discount';
                $autoIdx = $idx;
            }
        }
        if ($autoIdx !== null) {
            $applyScoped($autoIdx, $autoDiscount);
        }

        $couponDiscount = 0;
        $couponCode = null;
        $coupon = $opts['coupon'] ?? null;
        if ($coupon && !(!empty($coupon['minSpend']) && $netSum < (int) $coupon['minSpend'])) {
            $idx = $scopedIdx($coupon);
            $pool = $poolOf($idx, $remainingByLine);
            if ($idx && $pool > 0) {
                $amt = min(self::ruleAmountOn($coupon, $poolOf($idx, $netByLine)), $pool);
                if ($amt > 0) {
                    $couponDiscount = $amt;
                    $couponCode = $coupon['code'] ?? null;
                    $applyScoped($idx, $amt);
                }
            }
        }

        $cartDiscount = $manualCartDiscount + $autoDiscount + $couponDiscount;
        $shares = $perLine;

        // pass 3: tax per line
        $subtotal = 0;
        $itemDiscountTotal = 0;
        $taxTotal = 0;
        $taxBreakdown = [];
        $items = [];

        foreach ($rows as $i => $r) {
            $cartShare = $shares[$i] ?? 0;
            $taxable = max(0, $r['net'] - $cartShare);
            $tax = $taxMap[$r['line']['taxId'] ?? ''] ?? null;
            $taxAmount = 0;
            $taxRate = 0;
            $inclusive = false;
            if ($tax && ($tax['rate'] ?? 0)) {
                $taxRate = $tax['rate'];
                $inclusive = (bool) ($tax['inclusive'] ?? false);
                $taxAmount = $inclusive
                    ? $taxable - (int) round($taxable * 100 / (100 + $tax['rate']))
                    : Money::percent($taxable, $tax['rate']);
            }
            $subtotal += $r['gross'];
            $itemDiscountTotal += $r['lineDiscount'];
            $taxTotal += $taxAmount;
            if ($tax) {
                $acc = $taxBreakdown[$tax['id']] ?? ['taxId' => $tax['id'], 'name' => $tax['name'] ?? '', 'rate' => $tax['rate'], 'amount' => 0, 'base' => 0];
                $acc['amount'] += $taxAmount;
                $acc['base'] += $taxable;
                $taxBreakdown[$tax['id']] = $acc;
            }
            $lineTotal = $inclusive ? $taxable : $taxable + $taxAmount;
            $items[] = [
                'productId' => $r['line']['productId'], 'variantId' => $r['line']['variantId'] ?? null,
                'name' => $r['line']['name'] ?? '', 'sku' => $r['line']['sku'] ?? '',
                'unitPrice' => (int) $r['line']['unitPrice'], 'costPrice' => (int) ($r['line']['costPrice'] ?? 0),
                'qty' => $r['qty'], 'grossAmount' => $r['gross'], 'lineDiscount' => $r['lineDiscount'],
                'cartDiscountShare' => $cartShare, 'discountTotal' => $r['lineDiscount'] + $cartShare,
                'taxId' => $r['line']['taxId'] ?? null, 'taxRate' => $taxRate, 'taxInclusive' => $inclusive,
                'taxAmount' => $taxAmount, 'taxableAmount' => $taxable, 'lineTotal' => $lineTotal,
            ];
        }

        $grand = array_sum(array_column($items, 'lineTotal'));

        // Fixed-amount VAT / fees: applied once to the whole sale, never per line
        // and never refunded on a return.
        $totalQty = array_sum(array_column($items, 'qty'));
        if ($totalQty > 0) {
            foreach ($opts['taxes'] ?? [] as $t) {
                if (($t['type'] ?? 'percent') !== 'fixed' || !empty($t['archivedAt'])) {
                    continue;
                }
                $amt = max(0, (int) ($t['amount'] ?? 0));
                if (!$amt) {
                    continue;
                }
                $taxTotal += $amt;
                $grand += $amt;
                $acc = $taxBreakdown[$t['id']] ?? ['taxId' => $t['id'], 'name' => $t['name'] ?? '', 'rate' => 0, 'fixed' => true, 'amount' => 0, 'base' => $grand];
                $acc['amount'] += $amt;
                $acc['fixed'] = true;
                $taxBreakdown[$t['id']] = $acc;
            }
        }

        $totalCost = 0;
        foreach ($items as $it) {
            $totalCost += Money::mul($it['costPrice'], $it['qty']);
        }

        return [
            'items' => $items,
            'totalQty' => array_sum(array_column($items, 'qty')),
            'subtotal' => $subtotal,
            'itemDiscountTotal' => $itemDiscountTotal,
            'cartDiscount' => $cartDiscount,
            'manualCartDiscount' => $manualCartDiscount,
            'autoDiscount' => $autoDiscount,
            'autoDiscountName' => $autoDiscountName,
            'couponDiscount' => $couponDiscount,
            'couponCode' => $couponCode,
            'cartDiscountType' => $opts['cartDiscountType'] ?? null,
            'cartDiscountValue' => $opts['cartDiscountValue'] ?? 0,
            'discountTotal' => $itemDiscountTotal + $cartDiscount,
            'taxTotal' => $taxTotal,
            'taxLines' => array_values($taxBreakdown),
            'grandTotal' => $grand,
            'totalCost' => $totalCost,
            'estimatedProfit' => $grand - $taxTotal - $totalCost,
        ];
    }

    /** @return array{paid:int,change:int,cashPaid:int,nonCashPaid:int,list:list<array>} */
    public static function validatePayments(?array $payments, int $grandTotal): array
    {
        $list = array_values(array_filter($payments ?? [], static fn ($p) => is_array($p) && (int) ($p['amount'] ?? 0) > 0));
        if (!$list) {
            throw HttpError::conflict('Payment is required to complete the sale.');
        }
        $paid = 0;
        $cashPaid = 0;
        foreach ($list as $p) {
            $amt = (int) $p['amount'];
            $paid += $amt;
            if (($p['method'] ?? null) === 'cash') {
                $cashPaid += $amt;
            }
        }
        $nonCashPaid = $paid - $cashPaid;
        if ($nonCashPaid > $grandTotal) {
            throw HttpError::conflict('Non-cash payment exceeds the invoice total.');
        }
        if ($paid < $grandTotal) {
            throw HttpError::conflict('Payment amount is incomplete. Short by ' . Money::format($grandTotal - $paid) . '.');
        }
        $change = $paid - $grandTotal;
        if ($change > $cashPaid) {
            throw HttpError::conflict('Change due exceeds the cash tendered.');
        }
        return ['paid' => $paid, 'change' => $change, 'cashPaid' => $cashPaid, 'nonCashPaid' => $nonCashPaid, 'list' => $list];
    }
}
