<?php
declare(strict_types=1);

/* plans ---------------------------------------------------------------- */
test('plans: public list shows active plans; admin can CRUD; Live reads the same records', function () {
    $kit = new TestKit();

    // PUBLIC - no auth
    $pub = $kit->request('GET', '/api/plans');
    expect_eq($pub['status'], 200);
    expect_eq(count($pub['body']['data']), 3);
    $business = null;
    foreach ($pub['body']['data'] as $pl) {
        if ($pl['name'] === 'Business') {
            $business = $pl;
        }
    }
    expect_eq($business['price'], 190000);
    expect($business['popular'] === true);
    expect_eq($business['monthlyPrice'], 190000);
    expect($business['setupPrice'] > 0);
    expect($business['includedBranches'] >= 1);
    expect(array_key_exists('extraBranchPrice', $business));

    // merchant owner cannot manage plans
    $owner = $kit->loginAs();
    expect_eq(authed($kit, $owner, 'GET', '/api/platform/plans', [])['status'], 403);

    // super admin edits the price -> public list reflects it (single source of truth)
    $admin = $kit->loginPlatform();
    $upd = authed($kit, $admin, 'PATCH', '/api/platform/plans/' . $business['id'], ['json' => ['monthlyPrice' => 210000, 'setupPrice' => 3000000]]);
    expect_eq($upd['status'], 200);
    $pub2 = $kit->request('GET', '/api/plans');
    foreach ($pub2['body']['data'] as $pl) {
        if ($pl['id'] === $business['id']) {
            expect_eq($pl['price'], 210000);
            expect_eq($pl['monthlyPrice'], 210000);
            expect_eq($pl['setupPrice'], 3000000);
        }
    }

    // create + archive
    $made = authed($kit, $admin, 'POST', '/api/platform/plans', ['json' => ['name' => 'Trial', 'price' => 0, 'billingPeriod' => 'monthly', 'features' => ['14 days free']]]);
    expect_eq($made['status'], 201);
    authed($kit, $admin, 'DELETE', '/api/platform/plans/' . $made['body']['id'], []);
    // archived plan gone from public list, still in admin list
    expect_eq(count($kit->request('GET', '/api/plans')['body']['data']), 3);
    expect_eq(count(authed($kit, $admin, 'GET', '/api/platform/plans', [])['body']['data']), 4);
});

/* platform settings ------------------------------------------------- */
test('platform settings: public contact feed + Super Admin edit; WhatsApp is one source of truth', function () {
    $kit = new TestKit();

    // public - no auth, safe subset only
    $pub = $kit->request('GET', '/api/public-settings');
    expect_eq($pub['status'], 200);
    expect(is_string($pub['body']['contact']['whatsapp']));
    expect(!array_key_exists('gateway', $pub['body']));

    // merchant owner cannot read the full record
    $owner = $kit->loginAs();
    expect_eq(authed($kit, $owner, 'GET', '/api/platform/settings', [])['status'], 403);

    // super admin edits the WhatsApp number -> public feed reflects it
    $admin = $kit->loginPlatform();
    $full = authed($kit, $admin, 'GET', '/api/platform/settings', []);
    expect(isset($full['body']['contact'], $full['body']['billing'], $full['body']['gateway']));
    authed($kit, $admin, 'PATCH', '/api/platform/settings', ['json' => ['contact' => ['whatsapp' => '8801999888777'], 'billing' => ['graceDays' => 10]]]);
    $pub2 = $kit->request('GET', '/api/public-settings');
    expect_eq($pub2['body']['contact']['whatsapp'], '8801999888777');
    $full2 = authed($kit, $admin, 'GET', '/api/platform/settings', []);
    expect_eq($full2['body']['billing']['graceDays'], 10);
    expect_eq($full2['body']['gateway']['driver'], 'manual'); // untouched by the partial patch

    // payment methods: seeded, editable, normalised; only enabled ones reach the merchant
    $pm = $full2['body']['paymentMethods'];
    expect(is_array($pm) && count($pm) >= 4);
    expect(in_array('bkash', array_column($pm, 'id'), true));
    expect(!array_key_exists('paymentMethods', $pub2['body'])); // never public
    $next = array_map(static fn ($m) => $m['id'] === 'bkash' ? ['accountNumber' => '01711999888', 'instructionsBn' => "নতুন\nধাপ ২"] + $m : $m, $pm);
    $next[] = ['name' => 'Rocket', 'type' => 'mfs', 'accountNumber' => '017-0', 'status' => 'enabled'];
    $next = array_map(static fn ($m) => $m['id'] === 'card' ? ['status' => 'disabled'] + $m : $m, $next);
    authed($kit, $admin, 'PATCH', '/api/platform/settings', ['json' => ['paymentMethods' => array_values($next)]]);
    $pm2 = authed($kit, $admin, 'GET', '/api/platform/settings', [])['body']['paymentMethods'];
    $bk = null;
    foreach ($pm2 as $m) {
        if ($m['id'] === 'bkash') { $bk = $m; }
    }
    expect_eq($bk['accountNumber'], '01711999888');
    expect(in_array('rocket', array_column($pm2, 'id'), true));

    $owner2 = $kit->loginAs();
    $sum = authed($kit, $owner2, 'GET', '/api/billing/summary', [])['body'];
    expect(is_array($sum['paymentMethods']));
    foreach ($sum['paymentMethods'] as $m) {
        expect($m['status'] !== 'disabled');
        expect($m['id'] !== 'card');
    }
});

/* signup -> Portal ---------------------------------------------------- */
test('signup: creates an isolated merchant + pending subscription + signs in', function () {
    $kit = new TestKit();
    $planId = $kit->planId('Starter');

    $res = $kit->request('POST', '/api/signup', ['json' => [
        'businessName' => 'Nadia Cosmetics', 'ownerName' => 'Nadia', 'email' => 'nadia@shop.bd',
        'password' => 'nadiapass1', 'planId' => $planId,
    ]]);
    expect_eq($res['status'], 200, json_encode($res['body']));
    expect_eq($res['body']['user']['email'], 'nadia@shop.bd');
    expect_eq($res['body']['business']['name'], 'Nadia Cosmetics');
    expect_eq($res['body']['subscription']['status'], 'pending');
    expect_eq($res['body']['subscription']['planId'], $planId);
    // session cookie set -> they can go straight to the Portal
    expect(in_array('afia_sid', array_map(fn ($c) => explode('=', $c)[0], $res['cookies']), true));

    // isolation: the new owner sees only their own (empty) catalog
    $s = $kit->loginAs('nadia@shop.bd', 'nadiapass1');
    expect_eq(authed($kit, $s, 'GET', '/api/products', [])['body']['total'], 0);

    // plan purchase: right after signup the owner pays the setup fee -> pending, Super Admin notified
    $setup = authed($kit, $s, 'POST', '/api/billing/pay', ['json' => [
        'type' => 'initial', 'methodId' => 'bkash', 'reference' => 'SIGNUP-PAY', 'accountNumber' => '01700001111',
    ]]);
    expect_eq($setup['status'], 201);
    expect_eq($setup['body']['payment']['status'], 'pending');
    expect(str_starts_with($setup['body']['whatsapp'], 'https://wa.me/'));
    $adm = $kit->loginPlatform();
    $note = authed($kit, $adm, 'GET', '/api/platform/notifications', [])['body'];
    expect($note['unreadCount'] >= 1);
    expect(in_array('payment_request', array_column($note['data'], 'type'), true));

    // approvals inbox: the pending merchant with a submitted payment is queued
    $mid = $setup['body']['payment']['merchantId'];
    $appr = authed($kit, $adm, 'GET', '/api/platform/approvals', [])['body'];
    $row = null;
    foreach ($appr['data'] as $r) {
        if ($r['merchantId'] === $mid) { $row = $r; }
    }
    expect($row !== null && $row['pendingPayment']['reference'] === 'SIGNUP-PAY');
    expect($appr['counts']['payments'] >= 1);
    expect_eq(authed($kit, $adm, 'GET', '/api/platform/dashboard', [])['body']['attention']['payments'], $appr['counts']['payments']);
    // approve -> subscription active, payment paid, merchant notified
    authed($kit, $adm, 'POST', '/api/platform/approvals/' . $mid . '/approve', []);
    expect_eq(authed($kit, $adm, 'GET', '/api/platform/merchants/' . $mid, [])['body']['subscription']['liveStatus'], 'active');
    $s2 = $kit->loginAs('nadia@shop.bd', 'nadiapass1');
    $mn = authed($kit, $s2, 'GET', '/api/notifications', [])['body'];
    expect(count(array_filter($mn['data'], static fn ($n) => stripos(($n['title'] ?? '') . ($n['message'] ?? ''), 'approved') !== false)) >= 1);
    $adm = $kit->loginPlatform();
    $appr2 = authed($kit, $adm, 'GET', '/api/platform/approvals', [])['body'];
    expect(!in_array($mid, array_column($appr2['data'], 'merchantId'), true));

    // duplicate email rejected
    expect_eq($kit->request('POST', '/api/signup', ['json' => ['businessName' => 'X', 'email' => 'nadia@shop.bd', 'password' => 'whatever1']])['status'], 409);
    // bad input
    expect_eq($kit->request('POST', '/api/signup', ['json' => ['businessName' => '', 'email' => 'nope', 'password' => 'x']])['status'], 422);
});

/* support ------------------------------------------------------------ */
test('support: public can submit; super admin lists + replies', function () {
    $kit = new TestKit();
    $sub = $kit->request('POST', '/api/support', ['json' => ['name' => 'Visitor', 'email' => 'v@x.com', 'message' => 'How much for 3 branches?', 'planId' => $kit->planId('Business')]]);
    expect_eq($sub['status'], 201);

    $admin = $kit->loginPlatform();
    $list = authed($kit, $admin, 'GET', '/api/platform/support', []);
    expect_eq($list['body']['open'], 1);
    $id = $list['body']['data'][0]['id'];
    $rep = authed($kit, $admin, 'POST', "/api/platform/support/{$id}/reply", ['json' => ['text' => 'Business plan is 190000/mo.']]);
    expect_eq($rep['body']['status'], 'answered');
    expect_eq(count($rep['body']['replies']), 1);
});

/* platform dashboard + merchant management -------------------------- */
test('platform: dashboard + merchants + subscription lifecycle + revenue', function () {
    $kit = new TestKit();
    $admin = $kit->loginPlatform();

    // create a merchant with an active Business subscription
    $planId = $kit->planId('Business');
    $made = authed($kit, $admin, 'POST', '/api/platform/merchants', ['json' => [
        'name' => 'Rahman Store', 'ownerEmail' => 'rahman@store.bd', 'ownerPassword' => 'rahmanpw1', 'planId' => $planId, 'subscriptionStatus' => 'active',
    ]]);
    expect_eq($made['status'], 201);
    $mid = $made['body']['merchantId'];

    $dash = authed($kit, $admin, 'GET', '/api/platform/dashboard', [])['body'];
    expect($dash['merchants']['total'] >= 2);           // the test-kit merchant + Rahman
    expect_eq($dash['subscriptions']['active'], 1);
    expect_eq($dash['revenue']['mrr'], 190000);

    $mlist = authed($kit, $admin, 'GET', '/api/platform/merchants', ['query' => ['subscription' => 'active']]);
    expect_eq($mlist['body']['total'], 1);
    expect_eq($mlist['body']['data'][0]['id'], $mid);
    expect_eq($mlist['body']['data'][0]['planName'], 'Business');

    $detail = authed($kit, $admin, 'GET', '/api/platform/merchants/' . $mid, []);
    expect_eq($detail['body']['subscription']['liveStatus'], 'active');
    expect_eq(count($detail['body']['branches']), 1);
    expect_eq(count($detail['body']['users']), 1);

    // the merchant renames itself in Settings -> propagates to Super Admin + /auth/me
    $rman = $kit->loginAs('rahman@store.bd', 'rahmanpw1');
    authed($kit, $rman, 'PUT', '/api/settings', ['json' => ['business' => ['name' => 'Rahman Superstore', 'email' => 'hi@rahman.store']]]);
    $d2 = authed($kit, $admin, 'GET', '/api/platform/merchants/' . $mid, [])['body'];
    expect_eq($d2['merchant']['name'], 'Rahman Superstore');
    expect_eq($d2['business']['name'], 'Rahman Superstore');
    expect_eq($d2['business']['email'], 'hi@rahman.store');
    $ml = authed($kit, $admin, 'GET', '/api/platform/merchants', [])['body']['data'];
    $found2 = array_values(array_filter($ml, static fn ($m) => $m['id'] === $mid))[0];
    expect_eq($found2['businessName'], 'Rahman Superstore');
    $rman2 = $kit->loginAs('rahman@store.bd', 'rahmanpw1');
    expect_eq(authed($kit, $rman2, 'GET', '/api/auth/me', [])['body']['business']['name'], 'Rahman Superstore');
    // restore for the assertions below
    authed($kit, $rman2, 'PUT', '/api/settings', ['json' => ['business' => ['name' => 'Rahman Store']]]);

    // record a payment -> shows in revenue + payment list
    $subs = authed($kit, $admin, 'GET', '/api/platform/subscriptions', [])['body'];
    expect($subs['total'] >= 1);
    expect(array_key_exists('nextBillingAt', $subs['data'][0]));
    $pay = authed($kit, $admin, 'POST', '/api/platform/subscription-payments', ['json' => ['merchantId' => $mid, 'type' => 'monthly', 'amount' => 190000, 'method' => 'bkash']]);
    expect_eq($pay['status'], 201);
    expect_eq($pay['body']['status'], 'paid');
    expect_eq($pay['body']['type'], 'monthly');
    $rev = authed($kit, $admin, 'GET', '/api/platform/revenue', [])['body'];
    expect_eq($rev['total'], 190000);
    expect_eq($rev['byType']['monthly'], 190000);
    expect_eq($rev['byPlan'][0]['planName'], 'Business');

    // a PENDING payment does not touch the subscription until confirmed
    $expBefore = authed($kit, $admin, 'GET', '/api/platform/merchants/' . $mid, [])['body']['subscription']['expiresAt'];
    $pend = authed($kit, $admin, 'POST', '/api/platform/subscription-payments', ['json' => ['merchantId' => $mid, 'type' => 'monthly', 'amount' => 190000, 'method' => 'bank_transfer', 'reference' => 'TXN9', 'status' => 'pending']]);
    expect_eq($pend['body']['status'], 'pending');
    $expStill = authed($kit, $admin, 'GET', '/api/platform/merchants/' . $mid, [])['body']['subscription']['expiresAt'];
    expect_eq($expStill, $expBefore);
    authed($kit, $admin, 'PATCH', '/api/platform/subscription-payments/' . $pend['body']['id'], ['json' => ['status' => 'paid']]);
    $expAfter = authed($kit, $admin, 'GET', '/api/platform/merchants/' . $mid, [])['body']['subscription']['expiresAt'];
    expect($expAfter > $expBefore);
    expect_eq(authed($kit, $admin, 'GET', '/api/platform/revenue', [])['body']['total'], 380000);
    expect_eq(authed($kit, $admin, 'GET', '/api/platform/revenue', [])['body']['pendingCount'], 0);

    // a rejected payment keeps its reason, counts toward rejectedCount, activates nothing
    $rej = authed($kit, $admin, 'POST', '/api/platform/subscription-payments', ['json' => ['merchantId' => $mid, 'type' => 'monthly', 'amount' => 5000, 'method' => 'bkash', 'reference' => 'TXN-BAD', 'status' => 'pending']]);
    $expPreRej = authed($kit, $admin, 'GET', '/api/platform/merchants/' . $mid, [])['body']['subscription']['expiresAt'];
    authed($kit, $admin, 'PATCH', '/api/platform/subscription-payments/' . $rej['body']['id'], ['json' => ['status' => 'rejected', 'reason' => 'Transaction ID not found']]);
    $rejRow = null;
    foreach (authed($kit, $admin, 'GET', '/api/platform/subscription-payments', ['query' => ['status' => 'rejected']])['body']['data'] as $r) {
        if (($r['reference'] ?? '') === 'TXN-BAD') { $rejRow = $r; }
    }
    expect($rejRow !== null && $rejRow['rejectedReason'] === 'Transaction ID not found');
    expect(is_string($rejRow['businessName']));
    expect_eq(authed($kit, $admin, 'GET', '/api/platform/merchants/' . $mid, [])['body']['subscription']['expiresAt'], $expPreRej);
    expect_eq(authed($kit, $admin, 'GET', '/api/platform/revenue', [])['body']['rejectedCount'], 1);

    // suspend the merchant -> its owner's session dies + the access gate blocks
    $rs = $kit->loginAs('rahman@store.bd', 'rahmanpw1');
    authed($kit, $admin, 'PATCH', '/api/platform/merchants/' . $mid, ['json' => ['status' => 'suspended']]);
    expect_eq(authed($kit, $rs, 'GET', '/api/products', [])['status'], 401);
    // the suspend is mirrored onto the subscription
    expect_eq(authed($kit, $admin, 'GET', '/api/platform/merchants/' . $mid, [])['body']['subscription']['liveStatus'], 'suspended');
    // even a fresh login is write-blocked with 402 until reactivated
    $rs2 = $kit->loginAs('rahman@store.bd', 'rahmanpw1');
    expect_eq(authed($kit, $rs2, 'GET', '/api/auth/me', [])['body']['access']['state'], 'suspended');
    expect_eq(authed($kit, $rs2, 'POST', '/api/customers', ['json' => ['name' => 'x']])['status'], 402);
    authed($kit, $admin, 'PATCH', '/api/platform/merchants/' . $mid, ['json' => ['status' => 'active']]);
    $rs3 = $kit->loginAs('rahman@store.bd', 'rahmanpw1');
    expect_eq(authed($kit, $rs3, 'POST', '/api/customers', ['json' => ['name' => 'ok']])['status'], 201);

    // non-admin blocked everywhere on /platform
    $owner = $kit->loginAs();
    expect_eq(authed($kit, $owner, 'GET', '/api/platform/dashboard', [])['status'], 403);
    expect_eq(authed($kit, $owner, 'GET', '/api/platform/revenue', [])['status'], 403);
    expect_eq(authed($kit, $owner, 'GET', '/api/platform/merchants', [])['status'], 403);
    expect_eq(authed($kit, $owner, 'POST', '/api/platform/subscription-payments', ['json' => ['merchantId' => $mid, 'type' => 'monthly', 'amount' => 1]])['status'], 403);
    // and an unauthenticated caller is rejected by the router-level guard
    expect_eq($kit->request('GET', '/api/platform/dashboard', [])['status'], 401);
});
