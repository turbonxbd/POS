<?php
declare(strict_types=1);

/* Cross-device real-time change feed ------------------------------------- */
test('sync: GET /sync/changes reports the merchant tables that changed, scoped + cursored', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();

    // a cursor in the future -> nothing changed
    $future = (new DateTimeImmutable('+1 hour'))->format('Y-m-d\TH:i:s.v\Z');
    $none = authed($kit, $s, 'GET', '/api/sync/changes', ['query' => ['since' => $future]]);
    expect_eq($none['status'], 200);
    expect_eq($none['body']['changed'], []);
    expect(is_string($none['body']['cursor']));

    // add a product -> products (+ its stock) show as changed, cursor advances
    $cursor = (new DateTimeImmutable('-1 second'))->format('Y-m-d\TH:i:s.v\Z');
    usleep(5000);
    mkProduct($kit, $s, 'Sync Item', 'SYNC-1', '2000000009130', 500, 1000, 4);
    $after = authed($kit, $s, 'GET', '/api/sync/changes', ['query' => ['since' => $cursor]])['body'];
    expect(in_array('products', $after['changed'], true));
    expect($after['cursor'] > $cursor);

    // re-poll from the fresh cursor -> quiet
    $quiet = authed($kit, $s, 'GET', '/api/sync/changes', ['query' => ['since' => $after['cursor']]])['body'];
    expect_eq($quiet['changed'], []);

    // a second merchant's change is never reported to the first.
    // Poll from the first merchant's OWN latest cursor, then insert a foreign
    // product with a NEWER timestamp: the only thing that could newly appear is
    // that foreign row, and it must be scoped out.
    $isoSince = $quiet['cursor'];        // == the first merchant's most recent write
    usleep(5000);
    $other = \Afia\Support\Uuid::v4();
    $c = \Afia\Support\Clock::now();
    $kit->db->run(
        "INSERT INTO products (id, merchant_id, sku, barcode, name, doc, created_at, updated_at) VALUES (:id,:m,'X-1','2000000009147','Foreign',:d,:c,:c)",
        [':id' => $other, ':m' => 'some-other-merchant', ':d' => json_encode(['id' => $other, 'name' => 'Foreign']), ':c' => $c],
    );
    $iso = authed($kit, $s, 'GET', '/api/sync/changes', ['query' => ['since' => $isoSince]])['body'];
    expect_eq($iso['changed'], [], 'another merchant\'s product must not surface here');

    // unauthenticated -> 401
    expect_eq($kit->request('GET', '/api/sync/changes', [])['status'], 401);
});
