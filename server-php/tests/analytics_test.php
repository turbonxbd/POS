<?php
declare(strict_types=1);

function twoSales(TestKit $kit, array $s): array
{
    $a = mkProduct($kit, $s, 'Anlyt A', 'AN-A', '2000000003011', 10000, 40000, 20);
    $b = mkProduct($kit, $s, 'Anlyt B', 'AN-B', '2000000003028', 20000, 60000, 20);
    authed($kit, $s, 'POST', '/api/sales', ['json' => ['branchId' => $kit->branchId, 'items' => [['productId' => $a['id'], 'qty' => 2], ['productId' => $b['id'], 'qty' => 1]], 'payments' => [['method' => 'cash', 'amount' => 140000]]]]);
    authed($kit, $s, 'POST', '/api/sales', ['json' => ['branchId' => $kit->branchId, 'items' => [['productId' => $b['id'], 'qty' => 2]], 'payments' => [['method' => 'card', 'amount' => 120000]]]]);
    return [$a, $b];
}

test('dashboard: kpis, series, breakdowns line up with the sales made', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    twoSales($kit, $s);

    $d = authed($kit, $s, 'GET', '/api/dashboard', ['query' => ['preset' => 'today']]);
    expect_eq($d['status'], 200, json_encode($d['body']));
    expect_eq($d['body']['kpis']['totalSales'], 260000);   // 140000 + 120000
    expect_eq($d['body']['kpis']['invoiceCount'], 2);
    expect_eq($d['body']['kpis']['cashPayments'], 140000);
    expect_eq($d['body']['kpis']['ePayments'], 120000);
    expect_eq($d['body']['kpis']['unitsSold'], 5);
    expect_eq($d['body']['kpis']['totalProducts'], 2);
    expect(count($d['body']['topProducts']) === 2);
    expect(count($d['body']['salesSeries']) >= 1);
});

test('reports/sales: rows + totals match the dashboard total', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    twoSales($kit, $s);
    $r = authed($kit, $s, 'GET', '/api/reports/sales', ['query' => ['preset' => 'today']]);
    expect_eq($r['status'], 200);
    expect_eq(count($r['body']['rows']), 2);
    expect_eq($r['body']['totals']['total'], 260000);
    expect_eq($r['body']['totals']['items'], 5);
});

test('reports/products-sold: aggregates per product, sortable', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    twoSales($kit, $s);
    $r = authed($kit, $s, 'GET', '/api/reports/products-sold', ['query' => ['preset' => 'today', 'sort' => 'qtySold']]);
    expect_eq(count($r['body']['rows']), 2);
    // B sold 3 total, A sold 2 -> B first when sorted by qty
    expect_eq($r['body']['rows'][0]['qtySold'], 3);
    expect_eq($r['body']['totals']['qtySold'], 5);
});

test('reports/inventory-valuation: values remaining stock', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    twoSales($kit, $s);
    $r = authed($kit, $s, 'GET', '/api/reports/inventory-valuation', []);
    // A: 18 left @ cost 10000 = 180000 ; B: 17 left @ 20000 = 340000
    expect_eq($r['body']['totals']['stockValue'], 520000);
    expect_eq($r['body']['totals']['quantity'], 35);
});

test('reports/profit + daily-closing produce day rows', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    twoSales($kit, $s);
    $pr = authed($kit, $s, 'GET', '/api/reports/profit', ['query' => ['preset' => 'today']]);
    expect_eq(count($pr['body']['rows']), 1);
    expect($pr['body']['totals']['profit'] > 0);

    $dc = authed($kit, $s, 'GET', '/api/reports/daily-closing', ['query' => ['preset' => 'today']]);
    expect_eq($dc['body']['rows'][0]['orders'], 2);
    expect_eq($dc['body']['rows'][0]['cash'], 140000);
    expect_eq($dc['body']['rows'][0]['epayment'], 120000);
});

test('reports: unknown type -> 422', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    expect_eq(authed($kit, $s, 'GET', '/api/reports/nonsense', [])['status'], 422);
});
