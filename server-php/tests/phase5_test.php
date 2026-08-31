<?php
declare(strict_types=1);

/* media ------------------------------------------------------------------- */
test('media: upload a data URL, then serve the bytes back', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    // 1x1 transparent PNG
    $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
    $dataUrl = 'data:image/png;base64,' . base64_encode($png);

    $up = authed($kit, $s, 'POST', '/api/media', ['json' => ['dataUrl' => $dataUrl]]);
    expect_eq($up['status'], 201, json_encode($up['body']));
    expect(str_starts_with($up['body']['id'], 'img_'));
    expect_eq($up['body']['url'], '/api/media/' . $up['body']['id']);

    $get = authed($kit, $s, 'GET', '/api/media/' . $up['body']['id'], []);
    expect_eq($get['status'], 200);
    expect_eq($get['raw'], $png);
    expect_eq($get['headers']['Content-Type'], 'image/png');

    // unknown id
    expect_eq(authed($kit, $s, 'GET', '/api/media/img_nope', [])['status'], 404);
    // reject non-image
    expect_eq(authed($kit, $s, 'POST', '/api/media', ['json' => ['dataUrl' => 'data:text/plain;base64,aGk=']])['status'], 422);
});

test('media: another merchant cannot fetch the image', function () {
    $kit = new TestKit();
    $sa = $kit->loginAs();
    $png = 'data:image/png;base64,' . base64_encode('x');
    // (tiny invalid png but upload only checks the header + size)
    $up = authed($kit, $sa, 'POST', '/api/media', ['json' => ['dataUrl' => $png]]);
    $id = $up['body']['id'];

    $now = \Afia\Support\Clock::now();
    $m2 = \Afia\Support\Uuid::v4();
    $u2 = \Afia\Support\Uuid::v4();
    $kit->db->run('INSERT INTO merchants (id,name,status,doc,created_at,updated_at) VALUES (:i,:n,:s,:d,:c,:c)', [':i' => $m2, ':n' => 'M2', ':s' => 'active', ':d' => json_encode(['id' => $m2]), ':c' => $now]);
    $kit->db->run("INSERT INTO users (id,merchant_id,email,password_hash,role_id,status,doc,created_at,updated_at) VALUES (:i,:m,:e,:h,'role_owner','active',:d,:c,:c)",
        [':i' => $u2, ':m' => $m2, ':e' => 'm2@x.co', ':h' => \Afia\Support\Password::hash('m2pass123'), ':d' => json_encode(['id' => $u2, 'name' => 'M2', 'email' => 'm2@x.co', 'roleId' => 'role_owner', 'status' => 'active', 'permissionGrants' => [], 'permissionRevokes' => []]), ':c' => $now]);
    $kit->db->run("INSERT INTO businesses (id,merchant_id,doc,created_at,updated_at) VALUES (:i,:m,:d,:c,:c)", [':i' => \Afia\Support\Uuid::v4(), ':m' => $m2, ':d' => '{}', ':c' => $now]);

    $sb = $kit->loginAs('m2@x.co', 'm2pass123');
    expect_eq(authed($kit, $sb, 'GET', '/api/media/' . $id, [])['status'], 404);
});

/* backup roundtrip ---------------------------------------------------------- */
test('backup: export then import into a wiped merchant restores everything', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $p = mkProduct($kit, $s, 'Backup P', 'BK-1', '2000000004018', 10000, 30000, 12);
    authed($kit, $s, 'POST', '/api/sales', ['json' => ['branchId' => $kit->branchId, 'items' => [['productId' => $p['id'], 'qty' => 3]], 'payments' => [['method' => 'cash', 'amount' => 90000]]]]);

    $exp = authed($kit, $s, 'GET', '/api/backup/export', [])['body'];
    expect_eq(count($exp['data']['collections']['sales']), 1);

    // wipe products/sales manually, then import
    $kit->db->run('DELETE FROM sales WHERE merchant_id = :m', [':m' => $kit->merchantId]);
    $kit->db->run('DELETE FROM products WHERE merchant_id = :m', [':m' => $kit->merchantId]);
    expect_eq(authed($kit, $s, 'GET', '/api/products', [])['body']['total'], 0);

    $imp = authed($kit, $s, 'POST', '/api/backup/import', ['json' => ['data' => $exp['data']]]);
    expect_eq($imp['status'], 200, json_encode($imp['body']));
    expect_eq(authed($kit, $s, 'GET', '/api/products', [])['body']['total'], 1);
    expect_eq(authed($kit, $s, 'GET', '/api/sales', [])['body']['total'], 1);
    // barcode lookup still works (product_codes rebuilt)
    expect_eq(authed($kit, $s, 'GET', '/api/products/lookup', ['query' => ['code' => '2000000004018']])['body']['match'], 'product');
});

/* platform / super admin -------------------------------------------------- */
test('platform: non-admin is forbidden; admin can list + create merchants', function () {
    $kit = new TestKit();
    $owner = $kit->loginAs();
    expect_eq(authed($kit, $owner, 'GET', '/api/platform/merchants', [])['status'], 403);

    // make a platform admin directly
    $now = \Afia\Support\Clock::now();
    $pid = \Afia\Support\Uuid::v4();
    $kit->db->run("INSERT INTO users (id,merchant_id,email,password_hash,role_id,status,is_platform_admin,doc,created_at,updated_at) VALUES (:i,:m,:e,:h,'role_super_admin','active',1,:d,:c,:c)",
        [':i' => $pid, ':m' => $kit->merchantId, ':e' => 'root@afia.io', ':h' => \Afia\Support\Password::hash('rootpass123'), ':d' => json_encode(['id' => $pid, 'name' => 'Root', 'email' => 'root@afia.io', 'roleId' => 'role_super_admin', 'status' => 'active', 'permissionGrants' => [], 'permissionRevokes' => []]), ':c' => $now]);
    // seed the system roles so listRoles/hydrate works
    \Afia\Support\Provision::ensureSystemRoles($kit->db);

    $admin = $kit->loginAs('root@afia.io', 'rootpass123');
    $list = authed($kit, $admin, 'GET', '/api/platform/merchants', []);
    expect_eq($list['status'], 200);
    expect($list['body']['total'] >= 1);

    $made = authed($kit, $admin, 'POST', '/api/platform/merchants', ['json' => ['name' => 'Beta Shop', 'ownerEmail' => 'beta@shop.co', 'ownerPassword' => 'betapass123']]);
    expect_eq($made['status'], 201, json_encode($made['body']));

    // the new owner can log in and sees an empty catalog of their own
    $betaOwner = $kit->loginAs('beta@shop.co', 'betapass123');
    expect_eq(authed($kit, $betaOwner, 'GET', '/api/products', [])['body']['total'], 0);
    // and is isolated from Beta -> cannot hit platform
    expect_eq(authed($kit, $betaOwner, 'GET', '/api/platform/merchants', [])['status'], 403);

    // suspend Beta -> its owner's session dies
    $mid = $made['body']['merchantId'];
    authed($kit, $admin, 'PATCH', '/api/platform/merchants/' . $mid, ['json' => ['status' => 'suspended']]);
    expect_eq(authed($kit, $betaOwner, 'GET', '/api/products', [])['status'], 401);
});

/* provisioning ---------------------------------------------------------- */
test('provision: merchant gets business + branch + owner + tax + settings', function () {
    $kit = new TestKit();
    $res = \Afia\Support\Provision::merchant($kit->db, 'Gamma Traders', 'gamma@x.co', 'gammapass123');
    expect(str_starts_with($res['merchantId'], '') && strlen($res['merchantId']) === 36);

    $g = $kit->loginAs('gamma@x.co', 'gammapass123');
    $login = $g['login']['body'];
    expect_eq($login['business']['name'], 'Gamma Traders');
    expect_eq(count($login['branches']), 1);
    expect_eq($login['branches'][0]['code'], 'MAIN');
    expect_eq($login['role']['name'], 'Branch Owner');
    // default VAT present
    expect_eq(authed($kit, $g, 'GET', '/api/taxes', [])['body']['data'][0]['name'], 'VAT 15%');
});
