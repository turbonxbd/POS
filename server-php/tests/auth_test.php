<?php
declare(strict_types=1);

test('health: reports ok + merchant count', function () {
    $kit = new TestKit();
    $res = $kit->request('GET', '/api/health');
    expect_eq($res['status'], 200);
    expect_eq($res['body']['status'], 'ok');
    expect_eq($res['body']['merchants'], 1);
});

test('login: missing credentials -> 422', function () {
    $kit = new TestKit();
    $res = $kit->request('POST', '/api/auth/login', ['json' => []]);
    expect_eq($res['status'], 422);
    expect(str_contains($res['body']['message'], 'required'));
});

test('login: wrong password -> 401, correct -> 200 with cookies + org', function () {
    $kit = new TestKit();
    expect_eq($kit->request('POST', '/api/auth/login', ['json' => ['email' => 'owner@test.shop', 'password' => 'nope']])['status'], 401);

    $res = $kit->request('POST', '/api/auth/login', ['json' => ['email' => 'owner@test.shop', 'password' => 'sup3rsecret']]);
    expect_eq($res['status'], 200);
    expect_eq($res['body']['user']['email'], 'owner@test.shop');
    expect_eq($res['body']['role']['name'], 'Branch Owner');
    expect_eq($res['body']['user']['merchantId'], $kit->merchantId);
    expect($res['body']['business'] !== null);
    expect_eq(count($res['body']['branches']), 1);
    $names = array_map(fn ($c) => explode('=', $c)[0], $res['cookies']);
    expect(in_array('afia_sid', $names, true) && in_array('csrf_token', $names, true));
});

test('me: requires the session cookie', function () {
    $kit = new TestKit();
    expect_eq($kit->request('GET', '/api/auth/me')['status'], 401);

    $s = $kit->loginAs();
    $res = $kit->request('GET', '/api/auth/me', ['cookies' => $s['jar']]);
    expect_eq($res['status'], 200);
    expect_eq($res['body']['user']['email'], 'owner@test.shop');
});

test('change-password: CSRF required, then old password stops working', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();

    $noCsrf = $kit->request('POST', '/api/auth/change-password', [
        'cookies' => $s['jar'],
        'json' => ['currentPassword' => 'sup3rsecret', 'newPassword' => 'brandnew123'],
    ]);
    expect_eq($noCsrf['status'], 403);

    $ok = $kit->request('POST', '/api/auth/change-password', [
        'cookies' => $s['jar'],
        'headers' => ['x-csrf-token' => $s['csrf']],
        'json' => ['currentPassword' => 'sup3rsecret', 'newPassword' => 'brandnew123'],
    ]);
    expect_eq($ok['status'], 200);

    expect_eq($kit->request('POST', '/api/auth/login', ['json' => ['email' => 'owner@test.shop', 'password' => 'sup3rsecret']])['status'], 401);
    expect_eq($kit->request('POST', '/api/auth/login', ['json' => ['email' => 'owner@test.shop', 'password' => 'brandnew123']])['status'], 200);
});

test('login throttle: 8 failures then locked (429)', function () {
    $kit = new TestKit();
    for ($i = 0; $i < 8; $i++) {
        $kit->request('POST', '/api/auth/login', ['json' => ['email' => 'owner@test.shop', 'password' => 'wrong']]);
    }
    expect_eq($kit->request('POST', '/api/auth/login', ['json' => ['email' => 'owner@test.shop', 'password' => 'sup3rsecret']])['status'], 429);
});

test('logout: clears the session', function () {
    $kit = new TestKit();
    $s = $kit->loginAs();
    $out = $kit->request('POST', '/api/auth/logout', ['cookies' => $s['jar'], 'headers' => ['x-csrf-token' => $s['csrf']]]);
    expect_eq($out['status'], 200);
    expect_eq($kit->request('GET', '/api/auth/me', ['cookies' => $s['jar']])['status'], 401);
});

test('unknown endpoint -> 404 with mock-style body', function () {
    $kit = new TestKit();
    $res = $kit->request('GET', '/api/does-not-exist');
    expect_eq($res['status'], 404);
    expect(str_contains($res['body']['message'], 'not available'));
});
