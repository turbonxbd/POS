<?php
declare(strict_types=1);

test('checkout: walk-in cash sale deducts stock, records payment + change', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $p = mkProduct($kit, $s, 'Face Wash', 'FW-1', '2000000001017', 20000, 35000, 10);

    $res = authed($kit, $s, 'POST', '/api/sales', ['json' => [
        'branchId' => $kit->branchId,
        'items' => [['productId' => $p['id'], 'qty' => 2]],
        'payments' => [['method' => 'cash', 'amount' => 100000]],
    ]]);
    expect_eq($res['status'], 201, json_encode($res['body']));
    expect_eq($res['body']['grandTotal'], 70000);
    expect_eq($res['body']['changeTotal'], 30000);
    expect_eq($res['body']['status'], 'completed');
    expect(str_contains($res['body']['invoiceNo'], 'MAIN'));
    expect_eq(count($res['body']['items']), 1);
    expect_eq(count($res['body']['payments']), 1);
    expect_eq(stockNow($kit, $s, $p['id']), 8);
});

test('checkout: empty cart 422, insufficient stock 409, short payment 409', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $p = mkProduct($kit, $s, 'Serum', 'SR-1', '2000000001024', 10000, 20000, 3);

    expect_eq(authed($kit, $s, 'POST', '/api/sales', ['json' => ['branchId' => $kit->branchId, 'items' => []]])['status'], 422);

    expect_eq(authed($kit, $s, 'POST', '/api/sales', ['json' => [
        'branchId' => $kit->branchId, 'items' => [['productId' => $p['id'], 'qty' => 99]],
        'payments' => [['method' => 'cash', 'amount' => 9999999]],
    ]])['status'], 409);

    expect_eq(authed($kit, $s, 'POST', '/api/sales', ['json' => [
        'branchId' => $kit->branchId, 'items' => [['productId' => $p['id'], 'qty' => 1]],
        'payments' => [['method' => 'cash', 'amount' => 5000]],
    ]])['status'], 409);
});

test('checkout: idempotency key replays the original sale', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $p = mkProduct($kit, $s, 'Cream', 'CR-1', '2000000001031', 10000, 25000, 10);
    $payload = [
        'branchId' => $kit->branchId, 'idempotencyKey' => 'fixed-key-123',
        'items' => [['productId' => $p['id'], 'qty' => 1]],
        'payments' => [['method' => 'cash', 'amount' => 25000]],
    ];
    $a = authed($kit, $s, 'POST', '/api/sales', ['json' => $payload]);
    $b = authed($kit, $s, 'POST', '/api/sales', ['json' => $payload]);
    expect_eq($a['body']['id'], $b['body']['id']);
    expect_eq($b['body']['_idempotentReplay'] ?? null, true);
    expect_eq(stockNow($kit, $s, $p['id']), 9); // deducted once, not twice
});

test('checkout: invoice numbers are unique + sequential per branch (multi-terminal safe)', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $p = mkProduct($kit, $s, 'Lotion', 'LT-1', '2000000001048', 5000, 12000, 50);
    $nums = [];
    for ($i = 0; $i < 5; $i++) {
        $r = authed($kit, $s, 'POST', '/api/sales', ['json' => [
            'branchId' => $kit->branchId, 'items' => [['productId' => $p['id'], 'qty' => 1]],
            'payments' => [['method' => 'cash', 'amount' => 12000]],
        ]]);
        $nums[] = $r['body']['invoiceNo'];
    }
    expect_eq(count(array_unique($nums)), 5);
    expect(str_ends_with($nums[0], '00001') && str_ends_with($nums[4], '00005'), implode(',', $nums));
});

test('checkout: tax-inclusive of nothing - exclusive VAT adds on top', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $p = mkProduct($kit, $s, 'Taxed', 'TX-1', '2000000001055', 40000, 100000, 5, 15);
    $r = authed($kit, $s, 'POST', '/api/sales', ['json' => [
        'branchId' => $kit->branchId, 'items' => [['productId' => $p['id'], 'qty' => 1]],
        'payments' => [['method' => 'card', 'amount' => 115000]],
    ]]);
    expect_eq($r['status'], 201, json_encode($r['body']));
    expect_eq($r['body']['taxTotal'], 15000);
    expect_eq($r['body']['grandTotal'], 115000);
});

test('return: full return restocks and marks the sale refunded + refund payment', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $p = mkProduct($kit, $s, 'Returnable', 'RT-1', '2000000001062', 10000, 30000, 10);
    $sale = authed($kit, $s, 'POST', '/api/sales', ['json' => [
        'branchId' => $kit->branchId, 'items' => [['productId' => $p['id'], 'qty' => 2]],
        'payments' => [['method' => 'cash', 'amount' => 60000]],
    ]])['body'];
    expect_eq(stockNow($kit, $s, $p['id']), 8);

    $ret = authed($kit, $s, 'POST', '/api/sales/' . $sale['id'] . '/returns', ['json' => [
        'reason' => 'customer_request',
        'lines' => [['saleItemId' => $sale['items'][0]['id'], 'qty' => 2, 'restock' => true]],
    ]]);
    expect_eq($ret['status'], 201, json_encode($ret['body']));
    expect_eq($ret['body']['refundTotal'], 60000);
    expect_eq(stockNow($kit, $s, $p['id']), 10);

    $detail = authed($kit, $s, 'GET', '/api/sales/' . $sale['id'], []);
    expect_eq($detail['body']['status'], 'refunded');
    // one 'in' payment + one 'out' refund
    expect_eq(count($detail['body']['payments']), 2);

    // list-endpoint stat-strip summary covers the whole filtered set
    $list = authed($kit, $s, 'GET', '/api/sale-returns', ['query' => ['pageSize' => 1]]);
    expect_eq($list['body']['summary']['returns'], 1);
    expect_eq($list['body']['summary']['exchanges'], 0);
    expect_eq($list['body']['summary']['totalRefunded'], 60000);
});

test('exchange: return one item, replace with a dearer one, customer pays the difference', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $cheap = mkProduct($kit, $s, 'Cheap', 'EX-C', '2000000001079', 5000, 20000, 10);
    $dear = mkProduct($kit, $s, 'Dear', 'EX-D', '2000000001086', 10000, 50000, 10);
    $sale = authed($kit, $s, 'POST', '/api/sales', ['json' => [
        'branchId' => $kit->branchId, 'items' => [['productId' => $cheap['id'], 'qty' => 1]],
        'payments' => [['method' => 'cash', 'amount' => 20000]],
    ]])['body'];

    $ex = authed($kit, $s, 'POST', '/api/sales/' . $sale['id'] . '/returns', ['json' => [
        'type' => 'exchange', 'reason' => 'wrong_item',
        'lines' => [['saleItemId' => $sale['items'][0]['id'], 'qty' => 1]],
        'replacementItems' => [['productId' => $dear['id'], 'qty' => 1]],
        'refundMethod' => 'cash',
    ]]);
    expect_eq($ex['status'], 201, json_encode($ex['body']));
    expect_eq($ex['body']['type'], 'exchange');
    expect_eq($ex['body']['returnRefund'], 20000);
    expect_eq($ex['body']['replacementTotal'], 50000);
    expect_eq($ex['body']['difference'], 30000);
    expect_eq($ex['body']['additionalPayment'], 30000);
    expect_eq(stockNow($kit, $s, $cheap['id']), 10); // restocked
    expect_eq(stockNow($kit, $s, $dear['id']), 9);  // one out
});

test('checkout: coupon code + automatic discount apply to the total', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $p = mkProduct($kit, $s, 'Coupon Item', 'CI-1', '2000000009017', 4000, 10000, 50);

    // fixed-amount coupon
    $d = authed($kit, $s, 'POST', '/api/discounts', ['json' => [
        'name' => 'Ten off', 'code' => 'save10', 'type' => 'fixed', 'value' => 10, 'scope' => 'cart', 'status' => 'active',
    ]]);
    expect_eq($d['status'], 201, json_encode($d['body']));

    $val = authed($kit, $s, 'POST', '/api/discounts/validate', ['json' => ['code' => 'SAVE10', 'subtotal' => 30000]]);
    expect_eq($val['body']['valid'], true);
    expect_eq($val['body']['amount'], 1000);

    $s1 = authed($kit, $s, 'POST', '/api/sales', ['json' => [
        'branchId' => $kit->branchId,
        'items' => [['productId' => $p['id'], 'qty' => 3]],
        'couponCode' => 'SAVE10',
        'payments' => [['method' => 'cash', 'amount' => 29000]],
    ]]);
    expect_eq($s1['status'], 201, json_encode($s1['body']));
    expect_eq($s1['body']['grandTotal'], 29000);
    expect_eq($s1['body']['couponCode'], 'SAVE10');
    expect_eq($s1['body']['couponDiscount'], 1000);

    $dList = authed($kit, $s, 'GET', '/api/discounts', ['query' => ['pageSize' => 'all']]);
    $saved = null;
    foreach ($dList['body']['data'] as $row) {
        if (($row['code'] ?? null) === 'SAVE10') {
            $saved = $row;
        }
    }
    expect_eq($saved['usageCount'], 1);

    // unknown coupon is rejected at checkout
    $bad = authed($kit, $s, 'POST', '/api/sales', ['json' => [
        'branchId' => $kit->branchId,
        'items' => [['productId' => $p['id'], 'qty' => 1]],
        'couponCode' => 'NOPE',
        'payments' => [['method' => 'cash', 'amount' => 10000]],
    ]]);
    expect_eq($bad['status'], 422);

    // automatic (no-code) percent discount applies itself
    authed($kit, $s, 'POST', '/api/discounts', ['json' => [
        'name' => 'Auto 10%', 'type' => 'percent', 'value' => 10, 'scope' => 'cart', 'status' => 'active',
    ]]);
    $s2 = authed($kit, $s, 'POST', '/api/sales', ['json' => [
        'branchId' => $kit->branchId,
        'items' => [['productId' => $p['id'], 'qty' => 2]],
        'payments' => [['method' => 'cash', 'amount' => 18000]],
    ]]);
    expect_eq($s2['status'], 201, json_encode($s2['body']));
    expect_eq($s2['body']['grandTotal'], 18000);
    expect_eq($s2['body']['autoDiscount'], 2000);
});

test('checkout: a product-scoped discount only touches the products it names', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $a = mkProduct($kit, $s, 'Scoped A', 'SCA-1', '2000000009093', 4000, 10000, 30);
    $b = mkProduct($kit, $s, 'Scoped B', 'SCB-1', '2000000009109', 4000, 10000, 30);

    authed($kit, $s, 'POST', '/api/discounts', ['json' => [
        'name' => 'A only 20%', 'type' => 'percent', 'value' => 20, 'scope' => 'product', 'appliesTo' => [$a['id']], 'status' => 'active',
    ]]);
    $sale = authed($kit, $s, 'POST', '/api/sales', ['json' => [
        'branchId' => $kit->branchId,
        'items' => [['productId' => $a['id'], 'qty' => 1], ['productId' => $b['id'], 'qty' => 1]],
        'payments' => [['method' => 'cash', 'amount' => 18000]],
    ]]);
    // A 10000 -20% = 8000 ; B untouched 10000 -> grand 18000 ; auto discount 2000
    expect_eq($sale['status'], 201, json_encode($sale['body']));
    expect_eq($sale['body']['grandTotal'], 18000);
    expect_eq($sale['body']['autoDiscount'], 2000);

    // a product-scoped coupon is rejected when none of its products are in the cart
    authed($kit, $s, 'POST', '/api/discounts', ['json' => [
        'name' => 'A coupon', 'code' => 'aonly', 'type' => 'percent', 'value' => 15, 'scope' => 'product', 'appliesTo' => [$a['id']], 'status' => 'active',
    ]]);
    $rej = authed($kit, $s, 'POST', '/api/sales', ['json' => [
        'branchId' => $kit->branchId,
        'items' => [['productId' => $b['id'], 'qty' => 1]],
        'couponCode' => 'AONLY',
        'payments' => [['method' => 'cash', 'amount' => 10000]],
    ]]);
    expect_eq($rej['status'], 422);
});

test('checkout: fixed-amount VAT adds a flat fee to every sale', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $p = mkProduct($kit, $s, 'VAT Item', 'VI-1', '2000000009024', 4000, 10000, 20);

    $bad = authed($kit, $s, 'POST', '/api/taxes', ['json' => ['name' => 'Bad', 'type' => 'fixed', 'amount' => 0]]);
    expect_eq($bad['status'], 422);

    $fee = authed($kit, $s, 'POST', '/api/taxes', ['json' => ['name' => 'Service charge', 'type' => 'fixed', 'amount' => 500]]);
    expect_eq($fee['status'], 201, json_encode($fee['body']));
    expect_eq($fee['body']['type'], 'fixed');
    expect_eq($fee['body']['amount'], 500);

    $sale = authed($kit, $s, 'POST', '/api/sales', ['json' => [
        'branchId' => $kit->branchId,
        'items' => [['productId' => $p['id'], 'qty' => 2]],
        'payments' => [['method' => 'cash', 'amount' => 20500]],
    ]]);
    expect_eq($sale['status'], 201, json_encode($sale['body']));
    expect_eq($sale['body']['grandTotal'], 20500);
    expect_eq($sale['body']['taxTotal'], 500);

    authed($kit, $s, 'DELETE', '/api/taxes/' . $fee['body']['id'], []);
    $sale2 = authed($kit, $s, 'POST', '/api/sales', ['json' => [
        'branchId' => $kit->branchId,
        'items' => [['productId' => $p['id'], 'qty' => 1]],
        'payments' => [['method' => 'cash', 'amount' => 10000]],
    ]]);
    expect_eq($sale2['body']['grandTotal'], 10000);
});

test('checkout: due (credit) sale + record a later payment', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $p = mkProduct($kit, $s, 'Due Item', 'DUE-1', '2000000009031', 4000, 10000, 20);
    $cust = authed($kit, $s, 'POST', '/api/customers', ['json' => ['name' => 'Credit Buyer', 'phone' => '01799990001']])['body'];

    $sale = authed($kit, $s, 'POST', '/api/sales', ['json' => [
        'branchId' => $kit->branchId, 'customerId' => $cust['id'], 'onAccount' => true,
        'items' => [['productId' => $p['id'], 'qty' => 3]],
        'payments' => [['method' => 'cash', 'amount' => 10000]],
    ]]);
    expect_eq($sale['status'], 201, json_encode($sale['body']));
    expect_eq($sale['body']['dueTotal'], 20000);
    expect_eq($sale['body']['status'], 'due');
    expect_eq(authed($kit, $s, 'GET', '/api/customers/' . $cust['id'], [])['body']['outstandingBalance'], 20000);

    $pay1 = authed($kit, $s, 'POST', '/api/sales/' . $sale['body']['id'] . '/payment', ['json' => ['amount' => 12000, 'method' => 'cash']]);
    expect_eq($pay1['status'], 200, json_encode($pay1['body']));
    expect_eq($pay1['body']['dueTotal'], 8000);
    expect_eq(authed($kit, $s, 'GET', '/api/customers/' . $cust['id'], [])['body']['outstandingBalance'], 8000);

    // over-payment rejected
    expect_eq(authed($kit, $s, 'POST', '/api/sales/' . $sale['body']['id'] . '/payment', ['json' => ['amount' => 99999]])['status'], 422);

    $pay2 = authed($kit, $s, 'POST', '/api/sales/' . $sale['body']['id'] . '/payment', ['json' => ['amount' => 8000, 'method' => 'bkash', 'reference' => 'BK-1']]);
    expect_eq($pay2['body']['dueTotal'], 0);
    expect_eq($pay2['body']['status'], 'completed');

    $hist = authed($kit, $s, 'GET', '/api/customers/' . $cust['id'] . '/history', [])['body'];
    expect(count($hist['ledger']) >= 2); // sale_due + payments
});

test('held sales: hold then discard', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $h = authed($kit, $s, 'POST', '/api/held-sales', ['json' => ['branchId' => $kit->branchId, 'label' => 'Table 4', 'items' => [['productId' => 'x', 'qty' => 1]]]]);
    expect_eq($h['status'], 201);
    $list = authed($kit, $s, 'GET', '/api/held-sales', ['query' => ['branchId' => $kit->branchId]]);
    expect_eq($list['body']['total'], 1);
    authed($kit, $s, 'DELETE', '/api/held-sales/' . $h['body']['id'], []);
    expect_eq(authed($kit, $s, 'GET', '/api/held-sales', ['query' => ['branchId' => $kit->branchId]])['body']['total'], 0);
});
