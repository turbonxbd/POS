<?php
declare(strict_types=1);

/* Live-site support chat -------------------------------------------- */
test('chat: visitor thread + Super Admin reply + polling; merchant is 403', function () {
    $kit = new TestKit();

    // visitor - no auth
    $m1 = $kit->request('POST', '/api/chat', ['json' => ['name' => 'Jamal', 'email' => 'jamal@shop.bd', 'text' => 'How much is Business?']]);
    expect_eq($m1['status'], 201);
    $threadId = $m1['body']['threadId'];
    $visitorId = $m1['body']['visitorId'];
    expect($threadId !== '' && $visitorId !== '');
    expect_eq(count($m1['body']['messages']), 1);

    // append to the same thread
    usleep(3000);
    $kit->request('POST', '/api/chat', ['json' => ['threadId' => $threadId, 'visitorId' => $visitorId, 'text' => 'And the setup fee?']]);
    $poll = $kit->request('GET', "/api/chat/{$threadId}", ['query' => ['visitorId' => $visitorId]]);
    expect_eq(count($poll['body']['messages']), 2);
    $before = $poll['body']['messages'][1]['at']; // the 2nd visitor message's timestamp

    // a different visitor id cannot read it
    expect_eq($kit->request('GET', "/api/chat/{$threadId}", ['query' => ['visitorId' => 'nope']])['status'], 404);

    // Super Admin lists + replies
    $admin = $kit->loginPlatform();
    $list = authed($kit, $admin, 'GET', '/api/platform/chat', [])['body'];
    $found = false;
    foreach ($list['data'] as $t) {
        if ($t['id'] === $threadId) {
            $found = true;
        }
    }
    expect($found);
    expect($list['open'] >= 1);

    usleep(3000);
    authed($kit, $admin, 'POST', "/api/platform/chat/{$threadId}/reply", ['json' => ['text' => 'Business 190000/mo, setup 25000.']]);
    $full = authed($kit, $admin, 'GET', "/api/platform/chat/{$threadId}", [])['body'];
    expect_eq($full['status'], 'answered');
    expect_eq($full['messages'][count($full['messages']) - 1]['from'], 'admin');

    // visitor polls since -> just the reply
    $poll2 = $kit->request('GET', "/api/chat/{$threadId}", ['query' => ['visitorId' => $visitorId, 'since' => $before]]);
    expect_eq(count($poll2['body']['messages']), 1);
    expect_eq($poll2['body']['messages'][0]['from'], 'admin');

    // close it
    authed($kit, $admin, 'PATCH', "/api/platform/chat/{$threadId}", ['json' => ['status' => 'closed']]);
    expect_eq(authed($kit, $admin, 'GET', "/api/platform/chat/{$threadId}", [])['body']['status'], 'closed');

    // a merchant owner cannot reach the admin chat endpoints
    $owner = $kit->loginAs();
    expect_eq(authed($kit, $owner, 'GET', '/api/platform/chat', [])['status'], 403);
});
