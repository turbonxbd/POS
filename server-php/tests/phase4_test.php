<?php
declare(strict_types=1);

/* branches ------------------------------------------------------------------ */
test('branches: create with unique code, list decorated, archive blocked by stock', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $b2 = authed($kit, $s, 'POST', '/api/branches', ['json' => ['name' => 'Gulshan', 'code' => 'GUL']]);
    expect_eq($b2['status'], 201);
    expect_eq(authed($kit, $s, 'POST', '/api/branches', ['json' => ['name' => 'Dup', 'code' => 'GUL']])['status'], 409);

    $list = authed($kit, $s, 'GET', '/api/branches', []);
    expect_eq($list['body']['total'], 2);

    // stock at Gulshan blocks archive
    $p = mkProduct($kit, $s, 'B Stock', 'BSTK-1', '2000000002014', 100, 200, 0);
    authed($kit, $s, 'POST', '/api/inventory/adjustments', ['json' => ['branchId' => $b2['body']['id'], 'reason' => 'recount', 'lines' => [['productId' => $p['id'], 'deltaQty' => 5]]]]);
    expect_eq(authed($kit, $s, 'DELETE', '/api/branches/' . $b2['body']['id'], [])['status'], 409);
});

/* settings ---------------------------------------------------------------- */
test('settings: PUT deep-merges, GET returns merged', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    authed($kit, $s, 'PUT', '/api/settings', ['json' => ['pos' => ['requireOpenRegister' => true, 'holdSaleLimit' => 5]]]);
    authed($kit, $s, 'PUT', '/api/settings', ['json' => ['pos' => ['holdSaleLimit' => 9], 'business' => ['name' => 'X']]]);
    $g = authed($kit, $s, 'GET', '/api/settings', []);
    expect_eq($g['body']['pos']['requireOpenRegister'], true);
    expect_eq($g['body']['pos']['holdSaleLimit'], 9);
    expect_eq($g['body']['business']['name'], 'X');
});

/* notifications + audit -------------------------------------------------- */
test('notifications: a sale creates one; mark read + read-all work', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $p = mkProduct($kit, $s, 'Notif P', 'NP-1', '2000000002021', 100, 500, 5);
    authed($kit, $s, 'POST', '/api/sales', ['json' => ['branchId' => $kit->branchId, 'items' => [['productId' => $p['id'], 'qty' => 1]], 'payments' => [['method' => 'cash', 'amount' => 500]]]]);
    $n = authed($kit, $s, 'GET', '/api/notifications', ['query' => ['unread' => 'true']]);
    expect($n['body']['unreadCount'] >= 1);
    $first = $n['body']['data'][0]['id'];
    authed($kit, $s, 'POST', "/api/notifications/{$first}/read", []);
    authed($kit, $s, 'POST', '/api/notifications/read-all', []);
    expect_eq(authed($kit, $s, 'GET', '/api/notifications', ['query' => ['unread' => 'true']])['body']['unreadCount'], 0);
});

test('audit-logs + backup export carry the merchant data', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    mkProduct($kit, $s, 'Audited', 'AU-1', '2000000002038', 100, 200, 3);
    $logs = authed($kit, $s, 'GET', '/api/audit-logs', ['query' => ['entity' => 'product']]);
    expect($logs['body']['total'] >= 1);

    $exp = authed($kit, $s, 'GET', '/api/backup/export', []);
    expect_eq($exp['status'], 200);
    expect_eq(count($exp['body']['data']['collections']['products']), 1);
    expect($exp['body']['merchantId'] === $kit->merchantId);
});

/* customers -------------------------------------------------------------- */
test('customers: create, adjust balance, history', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $c = authed($kit, $s, 'POST', '/api/customers', ['json' => ['name' => 'Rita', 'phone' => '01710000001', 'openingBalance' => 5000]]);
    expect_eq($c['status'], 201);
    expect_eq($c['body']['outstandingBalance'], 5000);

    $bal = authed($kit, $s, 'POST', '/api/customers/' . $c['body']['id'] . '/balance', ['json' => ['type' => 'payment', 'amount' => 2000]]);
    expect_eq($bal['body']['outstandingBalance'], 3000);

    $h = authed($kit, $s, 'GET', '/api/customers/' . $c['body']['id'] . '/history', []);
    expect_eq(count($h['body']['ledger']), 1);
});

/* roles --------------------------------------------------------------------- */
test('roles: list has userCount; system perms locked; delete blocked with users', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $list = authed($kit, $s, 'GET', '/api/roles', []);
    $owner = null;
    foreach ($list['body']['data'] as $r) {
        if ($r['id'] === 'role_owner') {
            $owner = $r;
        }
    }
    expect_eq($owner['userCount'], 1);
    expect_eq(authed($kit, $s, 'PATCH', '/api/roles/role_owner', ['json' => ['permissions' => ['pos.operate']]])['status'], 409);
    expect_eq(authed($kit, $s, 'DELETE', '/api/roles/role_owner', [])['status'], 409);

    $custom = authed($kit, $s, 'POST', '/api/roles', ['json' => ['name' => 'Stockroom', 'permissions' => ['inventory.view']]]);
    expect_eq($custom['status'], 201);
    expect_eq(authed($kit, $s, 'DELETE', '/api/roles/' . $custom['body']['id'], [])['body']['deleted'], true);
});

/* employees ------------------------------------------------------------- */
test('employees: create (dup email 409), list, cannot demote the only owner', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $e = authed($kit, $s, 'POST', '/api/employees', ['json' => ['name' => 'Cashier Joe', 'email' => 'joe@test.shop', 'roleId' => 'role_cashier', 'password' => 'joepass12', 'branchIds' => [$kit->branchId]]]);
    expect_eq($e['status'], 201);
    expect_eq(authed($kit, $s, 'POST', '/api/employees', ['json' => ['name' => 'x', 'email' => 'joe@test.shop', 'roleId' => 'role_cashier']])['status'], 409);

    $list = authed($kit, $s, 'GET', '/api/employees', []);
    expect_eq($list['body']['total'], 2);

    // owner demoting self
    expect_eq(authed($kit, $s, 'PATCH', '/api/employees/' . $kit->ownerId, ['json' => ['roleId' => 'role_cashier']])['status'], 409);

    // Joe can log in
    expect_eq($kit->request('POST', '/api/auth/login', ['json' => ['email' => 'joe@test.shop', 'password' => 'joepass12']])['status'], 200);
});

/* finance: expenses, taxes, discounts --------------------------------- */
test('expenses: create with generated reference + category guard', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    expect_eq(authed($kit, $s, 'POST', '/api/expenses', ['json' => ['category' => 'Nonsense', 'amount' => 100, 'description' => 'x']])['status'], 422);
    $e = authed($kit, $s, 'POST', '/api/expenses', ['json' => ['category' => 'Rent', 'amount' => 850000, 'description' => 'Shop rent', 'branchId' => $kit->branchId]]);
    expect_eq($e['status'], 201);
    expect(str_starts_with($e['body']['reference'], 'EXP-'));
    expect_eq(authed($kit, $s, 'GET', '/api/expenses', [])['body']['total'], 1);
});

test('discounts: create + coupon validate', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    authed($kit, $s, 'POST', '/api/discounts', ['json' => ['name' => 'Eid', 'code' => 'eid10', 'type' => 'percent', 'value' => 10, 'minSpend' => 100000]]);
    $bad = authed($kit, $s, 'POST', '/api/discounts/validate', ['json' => ['code' => 'EID10', 'subtotal' => 50000]]);
    expect_eq($bad['body']['valid'], false);
    $good = authed($kit, $s, 'POST', '/api/discounts/validate', ['json' => ['code' => 'EID10', 'subtotal' => 200000]]);
    expect_eq($good['body']['valid'], true);
    expect_eq($good['body']['amount'], 20000);
});

/* cash register ------------------------------------------------------- */
test('cash register: open, sale attaches, movement, close reconciles', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $open = authed($kit, $s, 'POST', '/api/cash-register/open', ['json' => ['branchId' => $kit->branchId, 'openingCash' => 300000]]);
    expect_eq($open['status'], 201);
    $sid = $open['body']['id'];

    $p = mkProduct($kit, $s, 'Reg P', 'RGP-1', '2000000002045', 100, 40000, 10);
    authed($kit, $s, 'POST', '/api/sales', ['json' => ['branchId' => $kit->branchId, 'items' => [['productId' => $p['id'], 'qty' => 2]], 'payments' => [['method' => 'cash', 'amount' => 80000]]]]);

    authed($kit, $s, 'POST', "/api/cash-register/sessions/{$sid}/movements", ['json' => ['direction' => 'out', 'amount' => 10000, 'reason' => 'petty']]);

    $cur = authed($kit, $s, 'GET', '/api/cash-register/current', ['query' => ['branchId' => $kit->branchId]]);
    // opening 300000 + cash sale 80000 - cash out 10000 = 370000
    expect_eq($cur['body']['expectedCash'], 370000);

    $close = authed($kit, $s, 'POST', "/api/cash-register/sessions/{$sid}/close", ['json' => ['countedCash' => 369000]]);
    expect_eq($close['body']['difference'], -1000);
    expect_eq($close['body']['status'], 'closed');
});

/* purchasing --------------------------------------------------------- */
test('purchases: create bumps supplier balance; receive adds stock; return removes it', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $sup = authed($kit, $s, 'POST', '/api/suppliers', ['json' => ['name' => 'Acme Dist', 'openingBalance' => 0]])['body'];
    $p = mkProduct($kit, $s, 'Bought', 'BGT-1', '2000000002052', 10000, 25000, 0);

    $po = authed($kit, $s, 'POST', '/api/purchases', ['json' => [
        'branchId' => $kit->branchId, 'supplierId' => $sup['id'], 'paidTotal' => 0,
        'lines' => [['productId' => $p['id'], 'qty' => 20, 'unitCost' => 10000]],
    ]]);
    expect_eq($po['status'], 201, json_encode($po['body']));
    expect_eq($po['body']['grandTotal'], 200000);
    expect_eq(authed($kit, $s, 'GET', '/api/suppliers/' . $sup['id'], [])['body']['currentBalance'], 200000);

    $rec = authed($kit, $s, 'POST', '/api/purchases/' . $po['body']['id'] . '/receive', ['json' => []]);
    expect_eq($rec['body']['status'], 'received');
    expect_eq(stockNow($kit, $s, $p['id']), 20);

    // cancel after receive is blocked
    expect_eq(authed($kit, $s, 'POST', '/api/purchases/' . $po['body']['id'] . '/cancel', [])['status'], 409);

    $lineId = $rec['body']['lines'][0]['id'];
    $pret = authed($kit, $s, 'POST', '/api/purchases/' . $po['body']['id'] . '/returns', ['json' => [
        'reason' => 'defective', 'lines' => [['lineId' => $lineId, 'qty' => 5]],
    ]]);
    expect_eq($pret['status'], 201, json_encode($pret['body']));
    expect_eq($pret['body']['returnTotal'], 50000);
    expect_eq(stockNow($kit, $s, $p['id']), 15);
});
