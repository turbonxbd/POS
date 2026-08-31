<?php
declare(strict_types=1);

/**
 * End-to-end data-integrity chains (spec section 10):
 *   Sales -> inventory deduction
 *   Returns -> inventory restoration
 *   Exchanges -> return + replacement adjustment
 *   Branch stock -> total stock
 *   Products -> branch inventory
 *   Invoices -> sales ; Payments -> transactions
 *   Dashboard -> actual stored transactions
 */
test('integrity: one flow through product -> stock -> sale -> return -> exchange -> dashboard', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();

    // second branch
    $now = \Afia\Support\Clock::now();
    $b2 = \Afia\Support\Uuid::v4();
    $kit->db->run("INSERT INTO branches (id,merchant_id,code,name,status,is_default,doc,created_at,updated_at) VALUES (:i,:m,'B2','Branch 2','active',0,:d,:c,:c)",
        [':i' => $b2, ':m' => $kit->merchantId, ':d' => json_encode(['id' => $b2, 'name' => 'Branch 2', 'code' => 'B2', 'status' => 'active']), ':c' => $now]);

    // Products -> branch inventory : opening stock at BOTH branches
    $p = authed($kit, $s, 'POST', '/api/products', ['json' => [
        'name' => 'Integrity Serum', 'sku' => 'INT-1', 'barcode' => '2000000009017', 'costPrice' => 20000, 'sellingPrice' => 50000,
        'branchStock' => [['branchId' => $kit->branchId, 'qty' => 30], ['branchId' => $b2, 'qty' => 10]],
    ]])['body'];

    // Branch stock -> total stock
    $detail = authed($kit, $s, 'GET', '/api/products/' . $p['id'], ['query' => ['allBranches' => 'true']]);
    expect_eq($detail['body']['totalStockAllBranches'], 40);
    expect_eq($detail['body']['branchStock'][0]['qty'] + $detail['body']['branchStock'][1]['qty'], 40);

    // register + Sale -> inventory deduction, Invoices -> sales, Payments -> transactions
    $reg = authed($kit, $s, 'POST', '/api/cash-register/open', ['json' => ['branchId' => $kit->branchId, 'openingCash' => 500000]])['body'];
    $sale = authed($kit, $s, 'POST', '/api/sales', ['json' => [
        'branchId' => $kit->branchId, 'items' => [['productId' => $p['id'], 'qty' => 4]],
        'payments' => [['method' => 'cash', 'amount' => 200000]],
    ]])['body'];
    expect_eq($sale['grandTotal'], 200000);
    expect_eq(stockNow($kit, $s, $p['id']), 26);                       // 30 - 4
    expect_eq($sale['registerSessionId'], $reg['id']);                 // sale linked to the open register

    $lookup = authed($kit, $s, 'GET', '/api/sales/lookup', ['query' => ['invoice' => $sale['invoiceNo']]]);
    expect_eq($lookup['body']['id'], $sale['id']);                     // invoice -> sale
    $full = authed($kit, $s, 'GET', '/api/sales/' . $sale['id'], []);
    expect_eq(count($full['body']['payments']), 1);                    // payment transaction recorded

    // Dashboard -> actual stored transactions
    $d1 = authed($kit, $s, 'GET', '/api/dashboard', ['query' => ['preset' => 'today', 'branchId' => $kit->branchId]])['body'];
    expect_eq($d1['kpis']['totalSales'], 200000);
    expect_eq($d1['kpis']['invoiceCount'], 1);
    expect_eq($d1['kpis']['unitsSold'], 4);

    // register expected cash = opening 500000 + cash sale 200000
    $cur = authed($kit, $s, 'GET', '/api/cash-register/current', ['query' => ['branchId' => $kit->branchId]]);
    expect_eq($cur['body']['expectedCash'], 700000);

    // Returns -> inventory restoration
    $ret = authed($kit, $s, 'POST', '/api/sales/' . $sale['id'] . '/returns', ['json' => [
        'reason' => 'customer_request', 'lines' => [['saleItemId' => $sale['items'][0]['id'], 'qty' => 1]],
    ]])['body'];
    expect_eq($ret['refundTotal'], 50000);
    expect_eq(stockNow($kit, $s, $p['id']), 27);                       // 26 + 1 restocked

    // Exchanges -> return of 1 more + replacement (a dearer product), same branch
    $rep = authed($kit, $s, 'POST', '/api/products', ['json' => ['name' => 'Repl', 'sku' => 'INT-R', 'barcode' => '2000000009024', 'costPrice' => 30000, 'sellingPrice' => 90000, 'branchStock' => [['branchId' => $kit->branchId, 'qty' => 5]]]])['body'];
    $ex = authed($kit, $s, 'POST', '/api/sales/' . $sale['id'] . '/returns', ['json' => [
        'type' => 'exchange', 'reason' => 'wrong_item',
        'lines' => [['saleItemId' => $sale['items'][0]['id'], 'qty' => 1]],
        'replacementItems' => [['productId' => $rep['id'], 'qty' => 1]],
    ]])['body'];
    expect_eq($ex['returnRefund'], 50000);
    expect_eq($ex['replacementTotal'], 90000);
    expect_eq($ex['additionalPayment'], 40000);                       // customer pays the difference
    expect_eq(stockNow($kit, $s, $p['id']), 28);                      // returned item restocked
    expect_eq(stockNow($kit, $s, $rep['id']), 4);                     // replacement deducted

    // Dashboard now reflects the returns
    $d2 = authed($kit, $s, 'GET', '/api/dashboard', ['query' => ['preset' => 'today', 'branchId' => $kit->branchId]])['body'];
    expect_eq($d2['kpis']['returnsCount'], 2);
    expect_eq($d2['kpis']['exchangesCount'], 1);

    // sale status downgraded, never destroyed
    expect(in_array(authed($kit, $s, 'GET', '/api/sales/' . $sale['id'], [])['body']['status'], ['partially_refunded', 'refunded'], true));

    // Branch 2 stock never moved through any of this
    expect_eq(authed($kit, $s, 'GET', '/api/inventory', ['query' => ['branchId' => $b2, 'product' => $p['id']]])['body']['data'][0]['quantity'], 10);
});
