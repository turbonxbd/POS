<?php
declare(strict_types=1);

/* merchant self-service billing ------------------------------------- */
test('billing: merchant pays setup + monthly through the gateway; isolation holds', function () {
    $kit = new TestKit();
    $admin = $kit->loginPlatform();

    // a merchant with a PENDING subscription (setup not paid)
    $planId = $kit->planId('Starter');
    $made = authed($kit, $admin, 'POST', '/api/platform/merchants', ['json' => [
        'name' => 'Meena Mart', 'ownerEmail' => 'meena@mart.bd', 'ownerPassword' => 'meenapass1',
        'planId' => $planId, 'subscriptionStatus' => 'pending',
    ]]);
    expect_eq($made['status'], 201);

    $owner = $kit->loginAs('meena@mart.bd', 'meenapass1');
    $sum = authed($kit, $owner, 'GET', '/api/billing/summary', [])['body'];
    expect_eq($sum['subscription']['status'], 'pending');
    expect($sum['subscription']['setupPaid'] === false);
    expect_eq($sum['subscription']['dueAmount'], $sum['subscription']['setupPrice']);
    expect($sum['subscription']['setupPrice'] > 0);
    expect_eq($sum['gateway']['driver'], 'manual');
    expect(is_array($sum['paymentMethods']) && count($sum['paymentMethods']) >= 1);

    // manual pay needs the transaction id + payer account number, and a known method
    $noAcct = authed($kit, $owner, 'POST', '/api/billing/pay', ['json' => ['type' => 'initial', 'methodId' => 'bkash', 'reference' => 'BK-1']]);
    expect_eq($noAcct['status'], 422);
    $badMethod = authed($kit, $owner, 'POST', '/api/billing/pay', ['json' => ['type' => 'initial', 'methodId' => 'nope', 'reference' => 'X', 'accountNumber' => '017']]);
    expect_eq($badMethod['status'], 422);

    // pay the setup fee - manual gateway -> pending, nothing activates
    $pay = authed($kit, $owner, 'POST', '/api/billing/pay', ['json' => ['type' => 'initial', 'methodId' => 'bkash', 'reference' => 'BK-1', 'accountNumber' => '01710000000', 'note' => 'paid at 9pm']]);
    expect_eq($pay['status'], 201);
    expect_eq($pay['body']['payment']['status'], 'pending');
    expect_eq($pay['body']['payment']['methodId'], 'bkash');
    expect_eq($pay['body']['payment']['accountNumber'], '01710000000');
    expect(is_string($pay['body']['whatsapp']) && str_starts_with($pay['body']['whatsapp'], 'https://wa.me/'));
    expect(str_contains(rawurldecode($pay['body']['whatsapp']), 'Meena Mart'));
    $sum = authed($kit, $owner, 'GET', '/api/billing/summary', [])['body'];
    expect_eq($sum['subscription']['status'], 'pending');

    // the merchant can cancel their own pending request
    $toCancel = authed($kit, $owner, 'POST', '/api/billing/pay', ['json' => ['type' => 'initial', 'methodId' => 'bkash', 'reference' => 'BK-CANCEL', 'accountNumber' => '01710000000']]);
    $cx = authed($kit, $owner, 'POST', '/api/billing/payments/' . $toCancel['body']['payment']['id'] . '/cancel', []);
    expect_eq($cx['status'], 200);
    expect_eq($cx['body']['payment']['status'], 'cancelled');
    expect_eq(authed($kit, $owner, 'POST', '/api/billing/payments/' . $toCancel['body']['payment']['id'] . '/cancel', [])['status'], 422);

    // Super Admin is notified of the pending request
    $notifs = authed($kit, $admin, 'GET', '/api/platform/notifications', [])['body'];
    expect($notifs['unreadCount'] >= 1);
    $hit = null;
    foreach ($notifs['data'] as $n) {
        if (($n['type'] ?? '') === 'payment_request' && ($n['meta']['paymentId'] ?? '') === $pay['body']['payment']['id']) {
            $hit = $n;
        }
    }
    expect($hit !== null);
    authed($kit, $admin, 'POST', '/api/platform/notifications/' . $hit['id'] . '/read', []);
    authed($kit, $admin, 'POST', '/api/platform/notifications/read-all', []);
    expect_eq(authed($kit, $admin, 'GET', '/api/platform/notifications', ['query' => ['unread' => 'true']])['body']['unreadCount'], 0);

    // Super Admin confirms -> active + setup paid
    $ledger = authed($kit, $admin, 'GET', '/api/platform/subscription-payments', ['query' => ['status' => 'pending']])['body'];
    $mine = null;
    foreach ($ledger['data'] as $p) {
        if (($p['reference'] ?? null) === 'BK-1') {
            $mine = $p;
        }
    }
    expect($mine !== null);
    authed($kit, $admin, 'PATCH', '/api/platform/subscription-payments/' . $mine['id'], ['json' => ['status' => 'paid']]);
    $sum = authed($kit, $owner, 'GET', '/api/billing/summary', [])['body'];
    expect_eq($sum['subscription']['status'], 'active');
    expect($sum['subscription']['setupPaid'] === true);
    expect_eq($sum['subscription']['dueAmount'], 0);

    // switch to the instant mock gateway, pay a monthly charge -> settles + extends
    authed($kit, $admin, 'PATCH', '/api/platform/settings', ['json' => ['gateway' => ['driver' => 'mock']]]);
    $before = authed($kit, $owner, 'GET', '/api/billing/summary', [])['body']['subscription']['expiresAt'];
    $pay2 = authed($kit, $owner, 'POST', '/api/billing/pay', ['json' => ['type' => 'monthly', 'method' => 'card']]);
    expect_eq($pay2['body']['payment']['status'], 'paid');
    expect($pay2['body']['summary']['subscription']['expiresAt'] > $before);

    // additional branch: Starter includes 1, so a 2nd is blocked -> purchase -> activated
    $blocked = authed($kit, $owner, 'POST', '/api/branches', ['json' => ['name' => 'Second Shop']]);
    expect_eq($blocked['status'], 402);
    expect($blocked['body']['requiresPurchase'] === true);
    expect($blocked['body']['price'] > 0);

    $br = authed($kit, $owner, 'POST', '/api/billing/branch-request', ['json' => ['name' => 'Second Shop', 'code' => 'SHOP2', 'method' => 'card']]);
    expect_eq($br['status'], 201);
    expect_eq($br['body']['request']['status'], 'activated');
    expect($br['body']['request']['branchId'] !== null);

    $branches = authed($kit, $owner, 'GET', '/api/branches', [])['body']['data'];
    $names = array_map(static fn ($b) => $b['name'], $branches);
    expect(in_array('Second Shop', $names, true));
    $sum2 = authed($kit, $owner, 'GET', '/api/billing/summary', [])['body'];
    expect_eq($sum2['branches']['limit'], 2);
    expect_eq($sum2['branches']['extraPaid'], 1);

    expect_eq(authed($kit, $owner, 'POST', '/api/branches', ['json' => ['name' => 'Third Shop']])['status'], 402);

    // soft access gate: an expired subscription blocks writes but not reads / billing
    $sub = authed($kit, $admin, 'GET', '/api/platform/subscriptions', [])['body']['data'][0];
    authed($kit, $admin, 'PATCH', '/api/platform/subscriptions/' . $sub['id'], ['json' => ['action' => 'update', 'status' => 'expired']]);
    $owner = $kit->loginAs('meena@mart.bd', 'meenapass1');
    $me = authed($kit, $owner, 'GET', '/api/auth/me', [])['body'];
    expect_eq($me['access']['state'], 'expired');
    expect($me['access']['blocked'] === true);
    expect_eq(authed($kit, $owner, 'GET', '/api/customers', [])['status'], 200);
    $write = authed($kit, $owner, 'POST', '/api/customers', ['json' => ['name' => 'Walk-in Test']]);
    expect_eq($write['status'], 402);
    expect($write['body']['subscriptionBlocked'] === true);
    expect_eq(authed($kit, $owner, 'GET', '/api/billing/summary', [])['status'], 200);
    authed($kit, $owner, 'POST', '/api/billing/pay', ['json' => ['type' => 'monthly', 'method' => 'card']]);
    $owner = $kit->loginAs('meena@mart.bd', 'meenapass1');
    expect_eq(authed($kit, $owner, 'POST', '/api/customers', ['json' => ['name' => 'Walk-in OK']])['status'], 201);

    // isolation: a different merchant only ever sees its own subscription
    $other = $kit->loginAs(); // owner@test.shop - no subscription was provisioned for it
    $res = authed($kit, $other, 'GET', '/api/billing/summary', []);
    expect_eq($res['status'], 200);
    expect($res['body']['subscription'] === null);
    // and none of Meena's payments leak in
    foreach ($res['body']['payments'] as $p) {
        expect(($p['reference'] ?? null) !== 'BK-1');
    }
});
