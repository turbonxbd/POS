<?php
declare(strict_types=1);

namespace Afia\Support;

use Afia\Data\Roles;
use Afia\Database;

/** Create a new merchant: business + default branch + owner user + tax + settings. */
final class Provision
{
    /** Seed the 3 default POS TXbd plans once. Idempotent. Super Admin edits them later. */
    public static function ensureDefaultPlans(Database $db): void
    {
        if ($db->first('SELECT 1 FROM plans LIMIT 1')) {
            return;
        }
        $now = Clock::now();
        $defs = [
            ['name' => 'Starter', 'monthlyPrice' => 90000, 'setupPrice' => 1500000, 'includedBranches' => 1, 'extraBranchPrice' => 250000, 'popular' => false, 'sortOrder' => 1,
                'description' => 'For a single shop getting started with POS.',
                'features' => ['1 branch included', 'Up to 3 cashier accounts', 'Unlimited products', 'Barcode & invoice printing', 'Sales & inventory reports', 'Exchange & return'],
                'limits' => ['branches' => 1, 'users' => 3, 'products' => 0]],
            ['name' => 'Business', 'monthlyPrice' => 190000, 'setupPrice' => 2500000, 'includedBranches' => 2, 'extraBranchPrice' => 200000, 'popular' => true, 'sortOrder' => 2,
                'description' => 'For a growing business with more than one branch.',
                'features' => ['2 branches included', 'Up to 15 cashier accounts', 'Branch-wise stock & transfers', 'Full analytics dashboard', 'Customer accounts & loyalty', 'Purchasing & suppliers', 'Priority support'],
                'limits' => ['branches' => 5, 'users' => 15, 'products' => 0]],
            ['name' => 'Enterprise', 'monthlyPrice' => 390000, 'setupPrice' => 4000000, 'includedBranches' => 5, 'extraBranchPrice' => 150000, 'popular' => false, 'sortOrder' => 3,
                'description' => 'For multi-outlet retailers that need it all.',
                'features' => ['5 branches included', 'Unlimited cashier accounts', 'Every Business feature', 'Data export & backups', 'Dedicated onboarding', 'WhatsApp priority support'],
                'limits' => ['branches' => 0, 'users' => 0, 'products' => 0]],
        ];
        foreach ($defs as $d) {
            $id = Uuid::v4();
            $d['price'] = $d['monthlyPrice']; // mirror for older readers
            $doc = array_merge($d, ['id' => $id, 'billingPeriod' => 'monthly', 'currency' => 'BDT', 'currencySymbol' => '৳', 'status' => 'active', 'createdAt' => $now, 'updatedAt' => $now]);
            $db->run('INSERT INTO plans (id, merchant_id, name, price, billing_period, status, sort_order, doc, created_at, updated_at) VALUES (:id, \'\', :n, :p, \'monthly\', \'active\', :o, :d, :c, :c)',
                [':id' => $id, ':n' => $d['name'], ':p' => $d['price'], ':o' => $d['sortOrder'], ':d' => json_encode($doc), ':c' => $now]);
        }
    }

    /** Backfill setup / monthly / branch pricing onto plan rows created before those fields. Idempotent. */
    public static function migratePlanFields(Database $db): void
    {
        $rows = $db->all('SELECT id, price, doc FROM plans');
        foreach ($rows as $row) {
            $doc = json_decode($row['doc'], true) ?: [];
            $before = $doc;
            $doc['monthlyPrice'] ??= $doc['price'] ?? (int) $row['price'];
            $doc['price'] = $doc['monthlyPrice'];
            $doc['setupPrice'] ??= 0;
            $doc['includedBranches'] ??= ($doc['limits']['branches'] ?? 1) ?: 1;
            if (!array_key_exists('extraBranchPrice', $doc)) {
                $doc['extraBranchPrice'] = null;
            }
            if ($doc !== $before) {
                $db->run('UPDATE plans SET doc = :d, updated_at = :u WHERE id = :id',
                    [':d' => json_encode($doc), ':u' => Clock::now(), ':id' => $row['id']]);
            }
        }
    }

    /** Default platform settings (contact / billing / gateway). Keep in sync with the mock DEFAULT_PLATFORM_SETTINGS. */
    public static function defaultPlatformSettings(): array
    {
        return [
            'id' => 'platform',
            'contact' => [
                'businessName' => 'POS TXbd',
                'whatsapp' => '8801700000000',
                'supportPhone' => '',
                'email' => 'support@postxbd.app',
                'salesEmail' => 'sales@postxbd.app',
                'address' => '',
                'supportHours' => 'Sat–Thu, 10am–7pm (GMT+6)',
                'website' => '',
            ],
            'billing' => [
                'currency' => 'BDT',
                'currencySymbol' => '৳',
                'graceDays' => 7,
                'defaultExtraBranchPrice' => 200000,
            ],
            'gateway' => [
                'driver' => 'manual',
                'displayName' => 'Manual / bank transfer',
                'instructions' => 'Send the payment to our bKash / bank account, then enter the transaction ID below. We activate your account once we confirm it.',
            ],
            'paymentMethods' => self::defaultPaymentMethods(),
        ];
    }

    /** Seed payment methods. Keep in sync with the mock DEFAULT_PLATFORM_SETTINGS.paymentMethods. */
    public static function defaultPaymentMethods(): array
    {
        return [
            [
                'id' => 'bkash', 'name' => 'bKash', 'type' => 'mfs', 'accountType' => 'personal',
                'accountName' => 'POS TXbd', 'accountNumber' => '01700000000',
                'instructionsBn' => "বিকাশে পেমেন্ট করার নিয়ম:\nবিকাশ পার্সোনাল নম্বরে অ্যাপ থেকে সেন্ড মানি করুন\n১. bKash অ্যাপ খুলুন\n২. \"Send Money\" অপশনে ট্যাপ করুন\n৩. নিচের নম্বরটি কপি করে পেস্ট করুন\n৪. টাকার পরিমাণ লিখুন\n৫. রেফারেন্সে আপনার ব্যবসার নাম লিখুন\n৬. bKash PIN দিয়ে সেন্ড মানি সম্পন্ন করুন\n৭. সম্পন্ন হওয়ার পরে, ট্রানজেকশন আইডি কপি করে নিচের বক্সে পেস্ট করুন",
                'instructionsEn' => 'Open bKash → Send Money → paste the number below → enter the amount → confirm with your PIN → copy the Transaction ID into the form.',
                'note' => '', 'status' => 'enabled', 'sort' => 1,
            ],
            [
                'id' => 'nagad', 'name' => 'Nagad', 'type' => 'mfs', 'accountType' => 'personal',
                'accountName' => 'POS TXbd', 'accountNumber' => '01700000000',
                'instructionsBn' => "নগদে পেমেন্ট করার নিয়ম:\n১. Nagad অ্যাপ খুলুন\n২. \"Send Money\" অপশনে ট্যাপ করুন\n৩. নিচের নম্বরটি কপি করে পেস্ট করুন\n৪. টাকার পরিমাণ লিখুন\n৫. Nagad PIN দিয়ে সেন্ড মানি সম্পন্ন করুন\n৬. ট্রানজেকশন আইডি কপি করে নিচের বক্সে পেস্ট করুন",
                'instructionsEn' => 'Open Nagad → Send Money → paste the number below → enter the amount → confirm with your PIN → copy the Transaction ID into the form.',
                'note' => '', 'status' => 'enabled', 'sort' => 2,
            ],
            [
                'id' => 'rocket', 'name' => 'Rocket', 'type' => 'mfs', 'accountType' => 'personal',
                'accountName' => 'POS TXbd', 'accountNumber' => '017000000000',
                'instructionsBn' => "রকেটে পেমেন্ট করার নিয়ম:\n১. Rocket অ্যাপ / *322# খুলুন\n২. \"Send Money\" নির্বাচন করুন\n৩. নিচের নম্বরটি কপি করে দিন\n৪. টাকার পরিমাণ লিখুন\n৫. Rocket PIN দিয়ে নিশ্চিত করুন\n৬. ট্রানজেকশন আইডি কপি করে নিচের বক্সে পেস্ট করুন",
                'instructionsEn' => 'Open Rocket / *322# → Send Money → the number below → amount → confirm with PIN → copy the Transaction ID into the form.',
                'note' => '', 'status' => 'enabled', 'sort' => 3,
            ],
            [
                'id' => 'upay', 'name' => 'Upay', 'type' => 'mfs', 'accountType' => 'personal',
                'accountName' => 'POS TXbd', 'accountNumber' => '01700000000',
                'instructionsBn' => "উপায়ে পেমেন্ট করার নিয়ম:\n১. Upay অ্যাপ খুলুন\n২. \"Send Money\" নির্বাচন করুন\n৩. নিচের নম্বরটি দিন\n৪. টাকার পরিমাণ লিখুন\n৫. Upay PIN দিয়ে নিশ্চিত করুন\n৬. ট্রানজেকশন আইডি কপি করে নিচের বক্সে পেস্ট করুন",
                'instructionsEn' => 'Open Upay → Send Money → the number below → amount → confirm with PIN → copy the Transaction ID into the form.',
                'note' => '', 'status' => 'enabled', 'sort' => 4,
            ],
            [
                'id' => 'bank', 'name' => 'Bank transfer', 'type' => 'bank', 'accountType' => '',
                'accountName' => 'POS TXbd', 'accountNumber' => '',
                'instructionsBn' => "ব্যাংক ট্রান্সফারের নিয়ম:\n১. নিচের অ্যাকাউন্টে ব্যাংক ট্রান্সফার অথবা ক্যাশ ডিপোজিট করুন\n২. ট্রান্সফার সম্পন্ন হলে ট্রানজেকশন রেফারেন্স / স্লিপ নম্বর নিচের বক্সে লিখুন\n৩. প্রয়োজনে পেমেন্ট স্লিপের ছবি সংযুক্ত করুন",
                'instructionsEn' => 'Transfer or deposit to the account below, then enter the transaction reference / slip number and optionally attach the deposit slip.',
                'note' => '', 'status' => 'enabled', 'sort' => 5,
            ],
            [
                'id' => 'card', 'name' => 'Debit / Credit card', 'type' => 'card', 'accountType' => '',
                'accountName' => '', 'accountNumber' => '',
                'instructionsBn' => 'কার্ড পেমেন্ট শীঘ্রই চালু হবে। এখন বিকাশ, নগদ, রকেট, উপায় অথবা ব্যাংক ট্রান্সফার ব্যবহার করুন।',
                'instructionsEn' => 'Card payment is coming soon. Please use bKash, Nagad, Rocket, Upay or bank transfer for now.',
                'note' => '', 'status' => 'disabled', 'sort' => 6,
            ],
        ];
    }

    /** Clean a payment-methods array from a PATCH: stable ids, clamped enums. */
    public static function normalizePaymentMethods(array $list): array
    {
        $types = ['mfs', 'bank', 'card'];
        $accountTypes = ['personal', 'agent', 'merchant', ''];
        $seen = [];
        $out = [];
        foreach (array_values($list) as $i => $m) {
            if (!is_array($m)) {
                continue;
            }
            $id = strtolower((string) ($m['id'] ?? $m['name'] ?? ('method-' . ($i + 1))));
            $id = trim(preg_replace('/[^a-z0-9]+/', '-', $id), '-') ?: ('method-' . ($i + 1));
            while (in_array($id, $seen, true)) {
                $id .= '-2';
            }
            $seen[] = $id;
            $out[] = [
                'id' => $id,
                'name' => trim((string) ($m['name'] ?? $id)) ?: $id,
                'type' => in_array($m['type'] ?? null, $types, true) ? $m['type'] : 'mfs',
                'accountType' => in_array($m['accountType'] ?? null, $accountTypes, true) ? $m['accountType'] : '',
                'accountName' => trim((string) ($m['accountName'] ?? '')),
                'accountNumber' => trim((string) ($m['accountNumber'] ?? '')),
                'instructionsBn' => (string) ($m['instructionsBn'] ?? ''),
                'instructionsEn' => (string) ($m['instructionsEn'] ?? ''),
                'note' => trim((string) ($m['note'] ?? '')),
                'status' => ($m['status'] ?? 'enabled') === 'disabled' ? 'disabled' : 'enabled',
                'sort' => is_numeric($m['sort'] ?? null) ? (int) $m['sort'] : $i + 1,
            ];
        }
        usort($out, static fn ($a, $b) => $a['sort'] <=> $b['sort']);
        return $out;
    }

    /** Enabled payment methods, sorted — what a merchant sees on the payment sheet. */
    public static function enabledPaymentMethods(Database $db): array
    {
        $all = self::platformSettings($db)['paymentMethods'] ?? [];
        $on = array_values(array_filter($all, static fn ($m) => ($m['status'] ?? 'enabled') !== 'disabled'));
        usort($on, static fn ($a, $b) => ($a['sort'] ?? 0) <=> ($b['sort'] ?? 0));
        return $on;
    }

    /** Insert the single platform_settings row if absent. Idempotent. */
    public static function ensurePlatformSettings(Database $db): void
    {
        if ($db->first('SELECT 1 FROM platform_settings WHERE id = :id', [':id' => 'platform'])) {
            return;
        }
        $now = Clock::now();
        $db->run('INSERT INTO platform_settings (id, doc, created_at, updated_at) VALUES (:id, :d, :c, :c)',
            [':id' => 'platform', ':d' => json_encode(self::defaultPlatformSettings(), JSON_UNESCAPED_UNICODE), ':c' => $now]);
    }

    /** Current platform settings, merged over the defaults. */
    public static function platformSettings(Database $db): array
    {
        $row = $db->first('SELECT doc FROM platform_settings WHERE id = :id', [':id' => 'platform']);
        $stored = $row ? (json_decode($row['doc'], true) ?: []) : [];
        return self::deepMerge(self::defaultPlatformSettings(), $stored);
    }

    public static function deepMerge(array $a, array $b): array
    {
        foreach ($b as $k => $v) {
            if (is_array($v) && isset($a[$k]) && is_array($a[$k]) && !array_is_list($v)) {
                $a[$k] = self::deepMerge($a[$k], $v);
            } else {
                $a[$k] = $v;
            }
        }
        return $a;
    }

    /** Branches a merchant may run: includedBranches + extraBranchesPaid. 0 included => unlimited. */
    public static function branchLimit(?array $sub): int|float
    {
        if (!$sub) {
            return INF;
        }
        $included = (int) ($sub['includedBranches'] ?? 1);
        return $included === 0 ? INF : $included + (int) ($sub['extraBranchesPaid'] ?? 0);
    }

    /** Price of one extra branch: the plan's own price, else the platform default. */
    public static function extraBranchPrice(Database $db, ?array $sub): int
    {
        $planId = $sub['planId'] ?? null;
        if ($planId) {
            $row = $db->first('SELECT doc FROM plans WHERE id = :id', [':id' => $planId]);
            $plan = $row ? json_decode($row['doc'], true) : null;
            if ($plan && ($plan['extraBranchPrice'] ?? null) !== null) {
                return (int) $plan['extraBranchPrice'];
            }
        }
        return (int) (self::platformSettings($db)['billing']['defaultExtraBranchPrice'] ?? 0);
    }

    /** Insert the shared system roles once (merchant_id = ''). Idempotent. */
    public static function ensureSystemRoles(Database $db): void
    {
        $now = Clock::now();
        foreach (Roles::presets() as $role) {
            $exists = $db->first('SELECT 1 FROM roles WHERE id = :id', [':id' => $role['id']]);
            if ($exists) {
                continue;
            }
            $db->run(
                'INSERT INTO roles (id, merchant_id, name, is_system, doc, created_at, updated_at) VALUES (:id, \'\', :n, 1, :d, :c, :c)',
                [':id' => $role['id'], ':n' => $role['name'], ':d' => json_encode(array_merge($role, ['createdAt' => $now, 'updatedAt' => $now])), ':c' => $now],
            );
        }
    }

    /**
     * @return array{merchantId:string, ownerId:string, ownerEmail:string}
     */
    public static function merchant(Database $db, string $name, string $ownerEmail, string $ownerPassword, bool $platformAdmin = false, ?string $ownerName = null): array
    {
        $ownerEmail = strtolower(trim($ownerEmail));
        if ($db->first('SELECT 1 FROM users WHERE email = :e', [':e' => $ownerEmail])) {
            throw new \RuntimeException("A user with email {$ownerEmail} already exists.");
        }

        self::ensureSystemRoles($db);
        $now = Clock::now();
        $put = static function (string $table, string $id, array $doc, array $cols) use ($db, $now) {
            $full = array_merge(['id' => $id, 'createdAt' => $now, 'updatedAt' => $now], $doc);
            $names = array_merge(['id', 'doc', 'created_at', 'updated_at'], array_keys($cols));
            $ph = implode(',', array_map(static fn ($n) => ':' . $n, $names));
            $params = array_merge([':id' => $id, ':doc' => json_encode($full, JSON_UNESCAPED_UNICODE), ':created_at' => $now, ':updated_at' => $now],
                array_combine(array_map(static fn ($k) => ':' . $k, array_keys($cols)), array_map(static fn ($v) => is_bool($v) ? (int) $v : $v, array_values($cols))));
            $db->run("INSERT INTO {$table} (" . implode(',', $names) . ") VALUES ({$ph})", $params);
            return $full;
        };

        return $db->transaction(function () use ($db, $name, $ownerName, $ownerEmail, $ownerPassword, $platformAdmin, $now, $put) {
            $mid = Uuid::v4();
            $db->run('INSERT INTO merchants (id, name, status, doc, created_at, updated_at) VALUES (:id, :n, :s, :d, :c, :c)',
                [':id' => $mid, ':n' => $name, ':s' => 'active', ':d' => json_encode(['id' => $mid, 'name' => $name, 'status' => 'active', 'createdAt' => $now]), ':c' => $now]);

            $put('businesses', Uuid::v4(), ['merchantId' => $mid, 'name' => $name, 'legalName' => '', 'logoId' => null, 'address' => '', 'phone' => '', 'email' => '', 'website' => '', 'vatNo' => '', 'currency' => 'BDT', 'currencySymbol' => '৳'],
                ['merchant_id' => $mid]);

            $branchId = Uuid::v4();
            $put('branches', $branchId, ['merchantId' => $mid, 'name' => 'Main Store', 'code' => 'MAIN', 'address' => '', 'phone' => '', 'email' => '', 'isDefault' => true, 'status' => 'active'],
                ['merchant_id' => $mid, 'code' => 'MAIN', 'name' => 'Main Store', 'status' => 'active', 'is_default' => 1]);

            $roleId = $platformAdmin ? 'role_super_admin' : 'role_owner';
            $ownerId = Uuid::v4();
            $ownerDoc = ['id' => $ownerId, 'name' => $platformAdmin ? 'Platform Admin' : (trim((string) $ownerName) ?: 'Owner'), 'email' => $ownerEmail, 'phone' => null, 'avatar' => null,
                'roleId' => $roleId, 'status' => 'active', 'permissionGrants' => [], 'permissionRevokes' => [], 'lastLoginAt' => null, 'createdAt' => $now, 'updatedAt' => $now];
            $db->run('INSERT INTO users (id, merchant_id, email, password_hash, role_id, status, is_platform_admin, doc, created_at, updated_at) VALUES (:id,:m,:e,:h,:r,:s,:pa,:d,:c,:c)',
                [':id' => $ownerId, ':m' => $mid, ':e' => $ownerEmail, ':h' => Password::hash($ownerPassword), ':r' => $roleId, ':s' => 'active', ':pa' => $platformAdmin ? 1 : 0, ':d' => json_encode($ownerDoc), ':c' => $now]);

            $put('employees', Uuid::v4(), ['merchantId' => $mid, 'userId' => $ownerId, 'branchIds' => [$branchId], 'joinDate' => $now], ['merchant_id' => $mid, 'user_id' => $ownerId]);

            $taxId = Uuid::v4();
            $put('taxes', $taxId, ['merchantId' => $mid, 'name' => 'VAT 15%', 'rate' => 15, 'inclusive' => false, 'scope' => 'product', 'isDefault' => true, 'status' => 'active'],
                ['merchant_id' => $mid, 'name' => 'VAT 15%', 'is_default' => 1, 'status' => 'active']);

            $settings = Roles::defaultSettings($name);
            $settings['id'] = 'settings_' . $mid;
            $put('settings', 'settings_' . $mid, array_merge($settings, ['merchantId' => $mid]), ['merchant_id' => $mid]);

            $db->run('INSERT INTO meta (merchant_id, k, v) VALUES (:m, \'seededAt\', :v)', [':m' => $mid, ':v' => $now]);

            return ['merchantId' => $mid, 'ownerId' => $ownerId, 'ownerEmail' => $ownerEmail];
        });
    }

    /**
     * Attach (or replace) a merchant's subscription to a plan.
     * status: 'pending' (awaiting payment) | 'active' | 'trialing' | 'expired' | 'cancelled'
     */
    public static function subscribe(Database $db, string $merchantId, ?string $planId, string $status = 'pending', ?string $startedAt = null, ?string $expiresAt = null, array $opts = []): array
    {
        $now = Clock::now();
        $startedAt ??= $now;
        $plan = $planId ? $db->first('SELECT doc FROM plans WHERE id = :id', [':id' => $planId]) : null;
        $planDoc = $plan ? json_decode($plan['doc'], true) : null;
        $months = ($planDoc['billingPeriod'] ?? 'monthly') === 'yearly' ? 12 : 1;
        $expiresAt ??= (new \DateTimeImmutable($startedAt))->modify("+{$months} months")->format('Y-m-d\TH:i:s.v\Z');

        $existing = $db->first('SELECT id, doc FROM subscriptions WHERE merchant_id = :m', [':m' => $merchantId]);
        $prev = $existing ? json_decode($existing['doc'], true) : [];
        $id = $existing['id'] ?? Uuid::v4();

        $monthlyPrice = $planDoc['monthlyPrice'] ?? $planDoc['price'] ?? $prev['monthlyPrice'] ?? null;
        $includedBranches = $planDoc['includedBranches'] ?? $prev['includedBranches'] ?? 1;
        $extraBranchesPaid = array_key_exists('extraBranchesPaid', $opts)
            ? max(0, (int) $opts['extraBranchesPaid'])
            : (int) ($prev['extraBranchesPaid'] ?? 0);
        $setupPaid = array_key_exists('setupPaid', $opts)
            ? (bool) $opts['setupPaid']
            : (bool) ($prev['setupPaid'] ?? false);
        $lastPaymentAt = array_key_exists('lastPaymentAt', $opts) ? $opts['lastPaymentAt'] : ($prev['lastPaymentAt'] ?? null);

        $doc = [
            'id' => $id, 'merchantId' => $merchantId, 'planId' => $planId,
            'planName' => $planDoc['name'] ?? $prev['planName'] ?? null,
            'planPrice' => $monthlyPrice, 'monthlyPrice' => $monthlyPrice,
            'setupPrice' => $planDoc['setupPrice'] ?? $prev['setupPrice'] ?? 0,
            'includedBranches' => $includedBranches,
            'billingPeriod' => $planDoc['billingPeriod'] ?? $prev['billingPeriod'] ?? 'monthly',
            'status' => $status,
            'setupPaid' => $setupPaid,
            'extraBranchesPaid' => $extraBranchesPaid,
            'branchLimit' => (int) $includedBranches + $extraBranchesPaid,
            'startedAt' => $startedAt, 'expiresAt' => $expiresAt, 'nextBillingAt' => $expiresAt,
            'lastPaymentAt' => $lastPaymentAt,
            'createdAt' => $existing ? ($prev['createdAt'] ?? $now) : $now, 'updatedAt' => $now,
        ];
        if ($existing) {
            $db->run('UPDATE subscriptions SET plan_id = :p, status = :s, started_at = :st, expires_at = :e, doc = :d, updated_at = :u WHERE id = :id',
                [':p' => $planId, ':s' => $status, ':st' => $startedAt, ':e' => $expiresAt, ':d' => json_encode($doc), ':u' => $now, ':id' => $id]);
        } else {
            $db->run('INSERT INTO subscriptions (id, merchant_id, plan_id, status, started_at, expires_at, doc, created_at, updated_at) VALUES (:id,:m,:p,:s,:st,:e,:d,:c,:c)',
                [':id' => $id, ':m' => $merchantId, ':p' => $planId, ':s' => $status, ':st' => $startedAt, ':e' => $expiresAt, ':d' => json_encode($doc), ':c' => $now]);
        }
        return $doc;
    }
}
