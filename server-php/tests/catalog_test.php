<?php
declare(strict_types=1);

test('product: create simple with opening stock -> listed with stock + ledger row', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();

    $res = authed($kit, $s, 'POST', '/api/products', ['json' => [
        'name' => 'Vitamin C Serum 30ml', 'sku' => 'VITC-30', 'barcode' => '2000000000017',
        'costPrice' => 52000, 'sellingPrice' => 78000, 'unit' => 'ml',
        'branchStock' => [['branchId' => $kit->branchId, 'qty' => 25]],
    ]]);
    expect_eq($res['status'], 201, json_encode($res['body']));
    $pid = $res['body']['id'];
    expect_eq($res['body']['totalStockAllBranches'], 25);

    $list = authed($kit, $s, 'GET', '/api/products', ['query' => ['branchId' => $kit->branchId]]);
    expect_eq($list['status'], 200);
    expect_eq($list['body']['total'], 1);
    expect_eq($list['body']['data'][0]['stock'], 25);
    expect_eq($list['body']['data'][0]['computedStatus'], 'active');

    $mv = authed($kit, $s, 'GET', '/api/inventory/movements', ['query' => ['branchId' => $kit->branchId]]);
    expect_eq($mv['body']['total'], 1);
    expect_eq($mv['body']['data'][0]['type'], 'opening');
    expect_eq($mv['body']['data'][0]['qtyDelta'], 25);
});

test('product: duplicate SKU is rejected (422)', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $mk = fn ($sku, $bc) => authed($kit, $s, 'POST', '/api/products', ['json' => [
        'name' => 'P ' . $sku, 'sku' => $sku, 'barcode' => $bc, 'costPrice' => 100, 'sellingPrice' => 200,
    ]]);
    expect_eq($mk('DUP-1', '2000000000109')['status'], 201);
    $clash = $mk('DUP-1', '2000000000116');
    expect_eq($clash['status'], 422);
    expect(isset($clash['body']['errors']['sku']));
});

test('product: auto-generated barcodes never collide within a merchant', function () {
    $kit = new TestKit();
    $a = $kit->loginAs();
    $codes = [];
    for ($i = 0; $i < 8; $i++) {
        $r = authed($kit, $a, 'POST', '/api/products', ['json' => ['name' => 'AutoBC ' . $i, 'costPrice' => 100, 'sellingPrice' => 200]]);
        expect_eq($r['status'], 201);       // no spurious "barcode already used"
        $codes[] = $r['body']['barcode'];
    }
    expect_eq(count(array_unique($codes)), 8);
    foreach ($codes as $c) {
        expect(preg_match('/^\d{13}$/', $c) === 1);
    }
    // re-using one explicitly is still rejected for this merchant
    $dup = authed($kit, $a, 'POST', '/api/products', ['json' => ['name' => 'Dup', 'barcode' => $codes[0], 'costPrice' => 1, 'sellingPrice' => 2]]);
    expect_eq($dup['status'], 422);
    // /barcode/generate also returns distinct codes
    $gen = authed($kit, $a, 'POST', '/api/barcode/generate', ['json' => ['count' => 12]]);
    expect_eq(count(array_unique($gen['body']['codes'])), 12);
});

test('product: barcode lookup returns the product / variant', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    authed($kit, $s, 'POST', '/api/products', ['json' => [
        'name' => 'Lookup Lipstick', 'sku' => 'LOOK-1', 'barcode' => '2000000000123',
        'costPrice' => 100, 'sellingPrice' => 300,
        'variants' => [['name' => 'Red', 'options' => ['Shade' => 'Red'], 'sku' => 'LOOK-1-RED', 'barcode' => '2000000000130']],
    ]]);
    $hit = authed($kit, $s, 'GET', '/api/products/lookup', ['query' => ['code' => '2000000000123']]);
    expect_eq($hit['body']['match'], 'product');
    expect_eq($hit['body']['product']['name'], 'Lookup Lipstick');

    $vhit = authed($kit, $s, 'GET', '/api/products/lookup', ['query' => ['code' => '2000000000130']]);
    expect_eq($vhit['body']['match'], 'variant');
    expect($vhit['body']['variantId'] !== null);

    $miss = authed($kit, $s, 'GET', '/api/products/lookup', ['query' => ['code' => '9999999999999']]);
    expect_eq($miss['body']['match'], null);
});

test('categories: CRUD via the generic resource + productCount', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $cat = authed($kit, $s, 'POST', '/api/categories', ['json' => ['name' => 'Skincare', 'order' => 1]]);
    expect_eq($cat['status'], 201);
    $cid = $cat['body']['id'];

    authed($kit, $s, 'POST', '/api/products', ['json' => ['name' => 'Toner', 'sku' => 'TON-1', 'barcode' => '2000000000147', 'costPrice' => 100, 'sellingPrice' => 200, 'categoryId' => $cid]]);
    $list = authed($kit, $s, 'GET', '/api/categories', []);
    expect_eq($list['body']['data'][0]['productCount'], 1);

    $upd = authed($kit, $s, 'PATCH', '/api/categories/' . $cid, ['json' => ['name' => 'Skin Care']]);
    expect_eq($upd['body']['name'], 'Skin Care');
    $del = authed($kit, $s, 'DELETE', '/api/categories/' . $cid, []);
    expect_eq($del['body']['archived'], true);
});

test('inventory: adjustment decreases stock; below-zero is blocked (409)', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $p = authed($kit, $s, 'POST', '/api/products', ['json' => [
        'name' => 'Adjust Me', 'sku' => 'ADJ-1', 'barcode' => '2000000000154', 'costPrice' => 500, 'sellingPrice' => 900,
        'branchStock' => [['branchId' => $kit->branchId, 'qty' => 10]],
    ]])['body'];

    $ok = authed($kit, $s, 'POST', '/api/inventory/adjustments', ['json' => [
        'branchId' => $kit->branchId, 'reason' => 'damage',
        'lines' => [['productId' => $p['id'], 'deltaQty' => -3]],
    ]]);
    expect_eq($ok['status'], 201);
    expect_eq($ok['body']['netUnits'], -3);

    $over = authed($kit, $s, 'POST', '/api/inventory/adjustments', ['json' => [
        'branchId' => $kit->branchId, 'reason' => 'lost',
        'lines' => [['productId' => $p['id'], 'deltaQty' => -50]],
    ]]);
    expect_eq($over['status'], 409);

    $inv = authed($kit, $s, 'GET', '/api/inventory', ['query' => ['branchId' => $kit->branchId]]);
    $row = $inv['body']['data'][0];
    expect_eq($row['quantity'], 7);
});

test('inventory: reorder report lists low products and a partial minStock PATCH lifts them off', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $p = authed($kit, $s, 'POST', '/api/products', ['json' => [
        'name' => 'Reorder Me', 'sku' => 'REO-1', 'barcode' => '2000000000178', 'costPrice' => 300, 'sellingPrice' => 500,
        'minStock' => 10, 'branchStock' => [['branchId' => $kit->branchId, 'qty' => 4]],
    ]])['body'];

    $list = authed($kit, $s, 'GET', '/api/inventory/reorder', ['query' => ['pageSize' => 'all']])['body'];
    $row = null;
    foreach ($list['data'] as $r) {
        if ($r['productId'] === $p['id']) {
            $row = $r;
        }
    }
    expect($row !== null, 'low product on the reorder report');
    expect_eq($row['onHand'], 4);
    expect($row['suggestedQty'] > 0, 'suggests an order qty');
    expect($list['summary']['itemsToReorder'] >= 1, 'summary counts the item');
    expect(is_array($list['summary']['suppliers']), 'summary groups by supplier');

    $patch = authed($kit, $s, 'PATCH', '/api/products/' . $p['id'], ['json' => ['minStock' => 2]]);
    expect_eq($patch['status'], 200, json_encode($patch['body']));
    $after = authed($kit, $s, 'GET', '/api/inventory/reorder', ['query' => ['pageSize' => 'all']])['body'];
    foreach ($after['data'] as $r) {
        expect($r['productId'] !== $p['id'], 'raised reorder level removes it from the report');
    }
    expect_eq(authed($kit, $s, 'GET', '/api/products/' . $p['id'])['body']['name'], 'Reorder Me');
});

test('inventory: transfer moves stock between two branches', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    // second branch
    $now = \Afia\Support\Clock::now();
    $b2 = \Afia\Support\Uuid::v4();
    $kit->db->run("INSERT INTO branches (id, merchant_id, code, name, status, is_default, doc, created_at, updated_at) VALUES (:id,:m,'B2','Branch 2','active',0,:d,:c,:c)",
        [':id' => $b2, ':m' => $kit->merchantId, ':d' => json_encode(['id' => $b2, 'name' => 'Branch 2', 'code' => 'B2', 'status' => 'active']), ':c' => $now]);

    $p = authed($kit, $s, 'POST', '/api/products', ['json' => [
        'name' => 'Transfer Me', 'sku' => 'TRF-1', 'barcode' => '2000000000161', 'costPrice' => 400, 'sellingPrice' => 700,
        'branchStock' => [['branchId' => $kit->branchId, 'qty' => 20]],
    ]])['body'];

    $tr = authed($kit, $s, 'POST', '/api/inventory/transfers', ['json' => [
        'fromBranchId' => $kit->branchId, 'toBranchId' => $b2,
        'lines' => [['productId' => $p['id'], 'qty' => 8]],
    ]]);
    expect_eq($tr['status'], 201, json_encode($tr['body']));

    expect_eq(authed($kit, $s, 'GET', '/api/inventory', ['query' => ['branchId' => $kit->branchId]])['body']['data'][0]['quantity'], 12);
    expect_eq(authed($kit, $s, 'GET', '/api/inventory', ['query' => ['branchId' => $b2]])['body']['data'][0]['quantity'], 8);
});

test('tenant isolation: merchant B cannot see merchant A products', function () {
    $kit = new TestKit();
    $sa = $kit->loginAs();
    authed($kit, $sa, 'POST', '/api/products', ['json' => ['name' => 'Secret A', 'sku' => 'SEC-A', 'barcode' => '2000000000178', 'costPrice' => 1, 'sellingPrice' => 2]]);

    // spin up a second merchant + owner in the same DB
    $now = \Afia\Support\Clock::now();
    $m2 = \Afia\Support\Uuid::v4();
    $u2 = \Afia\Support\Uuid::v4();
    $kit->db->run('INSERT INTO merchants (id,name,status,doc,created_at,updated_at) VALUES (:id,:n,:s,:d,:c,:c)',
        [':id' => $m2, ':n' => 'Shop B', ':s' => 'active', ':d' => json_encode(['id' => $m2, 'name' => 'Shop B']), ':c' => $now]);
    $kit->db->run("INSERT INTO businesses (id,merchant_id,doc,created_at,updated_at) VALUES (:id,:m,:d,:c,:c)",
        [':id' => \Afia\Support\Uuid::v4(), ':m' => $m2, ':d' => json_encode(['id' => 'b', 'name' => 'Shop B']), ':c' => $now]);
    $kit->db->run("INSERT INTO branches (id,merchant_id,code,name,status,is_default,doc,created_at,updated_at) VALUES (:id,:m,'MB','Main B','active',1,:d,:c,:c)",
        [':id' => \Afia\Support\Uuid::v4(), ':m' => $m2, ':d' => json_encode(['id' => 'x', 'name' => 'Main B']), ':c' => $now]);
    $kit->db->run("INSERT INTO users (id,merchant_id,email,password_hash,role_id,status,doc,created_at,updated_at) VALUES (:id,:m,:e,:h,'role_owner','active',:d,:c,:c)",
        [':id' => $u2, ':m' => $m2, ':e' => 'b@shop.b', ':h' => \Afia\Support\Password::hash('passwordB1'), ':d' => json_encode(['id' => $u2, 'name' => 'B Owner', 'email' => 'b@shop.b', 'roleId' => 'role_owner', 'status' => 'active', 'permissionGrants' => [], 'permissionRevokes' => []]), ':c' => $now]);

    $sb = $kit->loginAs('b@shop.b', 'passwordB1');
    $listB = authed($kit, $sb, 'GET', '/api/products', []);
    expect_eq($listB['body']['total'], 0);
});
