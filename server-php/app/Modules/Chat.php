<?php
declare(strict_types=1);

namespace Afia\Modules;

use Afia\App;
use Afia\Context;
use Afia\Http\Response;
use Afia\Http\Router;
use Afia\Support\Clock;
use Afia\Support\HttpError;
use Afia\Support\Uuid;

/**
 * The Live/Public site's support chat. Real storage + real delivery by short
 * polling (no websockets - runs on plain PHP hosting).
 *   POST  /chat                     PUBLIC  start a thread / append a message
 *   GET   /chat/:threadId?since=     PUBLIC  poll for new messages
 *   GET   /platform/chat             Super Admin  list threads
 *   GET   /platform/chat/:id         Super Admin  one thread + messages
 *   POST  /platform/chat/:id/reply   Super Admin
 *   PATCH /platform/chat/:id         Super Admin  { status }
 */
final class Chat
{
    public static function register(Router $r, App $app): void
    {
        $r->post('/chat', fn (Context $c) => self::post($c));
        $r->get('/chat/:threadId', fn (Context $c, $p) => self::poll($c, $p));
        $r->get('/platform/chat', fn (Context $c) => self::list($c));
        $r->get('/platform/chat/:id', fn (Context $c, $p) => self::thread($c, $p));
        $r->post('/platform/chat/:id/reply', fn (Context $c, $p) => self::reply($c, $p));
        $r->patch('/platform/chat/:id', fn (Context $c, $p) => self::setStatus($c, $p));
    }

    private static function isEmail(string $s): bool
    {
        return (bool) preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $s);
    }

    private static function messages(Context $ctx, string $threadId, ?string $since = null): array
    {
        $sql = 'SELECT doc FROM chat_messages WHERE thread_id = :t' . ($since ? ' AND at > :s' : '') . ' ORDER BY at ASC';
        $args = [':t' => $threadId] + ($since ? [':s' => $since] : []);
        return array_map(static fn ($x) => json_decode($x['doc'], true), $ctx->db->all($sql, $args));
    }

    private static function post(Context $ctx): Response
    {
        $b = $ctx->body();
        $text = trim((string) ($b['text'] ?? ''));
        if ($text === '') {
            throw HttpError::badRequest('Message text is required', ['text' => 'Required']);
        }
        $visitorId = trim((string) ($b['visitorId'] ?? '')) ?: Uuid::v4();
        $now = Clock::now();

        $thread = null;
        if (!empty($b['threadId'])) {
            $row = $ctx->db->first('SELECT doc FROM chat_threads WHERE id = :id', [':id' => $b['threadId']]);
            $t = $row ? json_decode($row['doc'], true) : null;
            if ($t && ($t['visitorId'] ?? null) === $visitorId) {
                $thread = $t;
            }
        }
        if ($thread === null) {
            $tid = Uuid::v4();
            $thread = [
                'id' => $tid, 'visitorId' => $visitorId,
                'name' => trim((string) ($b['name'] ?? '')) ?: 'Visitor',
                'email' => self::isEmail((string) ($b['email'] ?? '')) ? strtolower(trim((string) $b['email'])) : '',
                'subject' => trim((string) ($b['subject'] ?? 'Website chat')),
                'status' => 'open', 'lastMessageAt' => $now, 'unreadForAdmin' => 1,
                'at' => $now, 'createdAt' => $now, 'updatedAt' => $now,
            ];
            $ctx->db->run('INSERT INTO chat_threads (id, visitor_id, status, email, last_message_at, at, doc, created_at, updated_at) VALUES (:id,:v,:s,:e,:lm,:at,:d,:c,:c)',
                [':id' => $tid, ':v' => $visitorId, ':s' => 'open', ':e' => $thread['email'], ':lm' => $now, ':at' => $now, ':d' => json_encode($thread), ':c' => $now]);
        } else {
            if (empty($thread['email']) && self::isEmail((string) ($b['email'] ?? ''))) {
                $thread['email'] = strtolower(trim((string) $b['email']));
            }
            if ((empty($thread['name']) || $thread['name'] === 'Visitor') && !empty($b['name'])) {
                $thread['name'] = trim((string) $b['name']);
            }
            $thread['status'] = $thread['status'] === 'closed' ? 'open' : $thread['status'];
            $thread['lastMessageAt'] = $now;
            $thread['unreadForAdmin'] = (int) ($thread['unreadForAdmin'] ?? 0) + 1;
            $thread['updatedAt'] = $now;
            $ctx->db->run('UPDATE chat_threads SET status = :s, email = :e, last_message_at = :lm, doc = :d, updated_at = :u WHERE id = :id',
                [':s' => $thread['status'], ':e' => $thread['email'], ':lm' => $now, ':d' => json_encode($thread), ':u' => $now, ':id' => $thread['id']]);
        }

        $mid = Uuid::v4();
        $msg = ['id' => $mid, 'threadId' => $thread['id'], 'from' => 'visitor', 'by' => $thread['name'], 'text' => $text, 'at' => $now];
        $ctx->db->run('INSERT INTO chat_messages (id, thread_id, sender, at, doc, created_at, updated_at) VALUES (:id,:t,:snd,:at,:d,:c,:c)',
            [':id' => $mid, ':t' => $thread['id'], ':snd' => 'visitor', ':at' => $now, ':d' => json_encode($msg), ':c' => $now]);

        return Response::json([
            'threadId' => $thread['id'], 'visitorId' => $visitorId, 'message' => $msg,
            'messages' => self::messages($ctx, $thread['id']),
        ], 201);
    }

    private static function poll(Context $ctx, array $p): Response
    {
        $row = $ctx->db->first('SELECT doc FROM chat_threads WHERE id = :id', [':id' => $p['threadId']]) ?? throw HttpError::notFound('Conversation');
        $t = json_decode($row['doc'], true);
        $vid = $ctx->query('visitorId');
        if ($vid && ($t['visitorId'] ?? null) !== $vid) {
            throw HttpError::notFound('Conversation');
        }
        return Response::json([
            'threadId' => $t['id'], 'status' => $t['status'],
            'messages' => self::messages($ctx, $t['id'], $ctx->query('since')),
        ]);
    }

    private static function list(Context $ctx): Response
    {
        $ctx->requirePlatformAdmin();
        $status = $ctx->query('status');
        $sql = 'SELECT doc FROM chat_threads' . ($status && $status !== 'all' ? ' WHERE status = :s' : '') . ' ORDER BY last_message_at DESC';
        $rows = $ctx->db->all($sql, $status && $status !== 'all' ? [':s' => $status] : []);
        $data = array_map(function ($x) use ($ctx) {
            $t = json_decode($x['doc'], true);
            $t['messageCount'] = (int) $ctx->db->value('SELECT COUNT(*) FROM chat_messages WHERE thread_id = :t', [':t' => $t['id']]);
            return $t;
        }, $rows);
        return Response::json([
            'data' => $data,
            'open' => (int) $ctx->db->value("SELECT COUNT(*) FROM chat_threads WHERE status = 'open'"),
        ]);
    }

    private static function thread(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $row = $ctx->db->first('SELECT doc FROM chat_threads WHERE id = :id', [':id' => $p['id']]) ?? throw HttpError::notFound('Conversation');
        $t = json_decode($row['doc'], true);
        if (($t['unreadForAdmin'] ?? 0) !== 0) {
            $t['unreadForAdmin'] = 0;
            $ctx->db->run('UPDATE chat_threads SET doc = :d, updated_at = :u WHERE id = :id', [':d' => json_encode($t), ':u' => Clock::now(), ':id' => $t['id']]);
        }
        $t['messages'] = self::messages($ctx, $t['id']);
        return Response::json($t);
    }

    private static function reply(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $row = $ctx->db->first('SELECT doc FROM chat_threads WHERE id = :id', [':id' => $p['id']]) ?? throw HttpError::notFound('Conversation');
        $t = json_decode($row['doc'], true);
        $text = trim((string) ($ctx->body()['text'] ?? ''));
        if ($text === '') {
            throw HttpError::badRequest('Reply text is required');
        }
        $now = Clock::now();
        $mid = Uuid::v4();
        $msg = ['id' => $mid, 'threadId' => $t['id'], 'from' => 'admin', 'by' => $ctx->actor['name'] ?? 'POS TXbd', 'text' => $text, 'at' => $now];
        $ctx->db->run('INSERT INTO chat_messages (id, thread_id, sender, at, doc, created_at, updated_at) VALUES (:id,:t,:snd,:at,:d,:c,:c)',
            [':id' => $mid, ':t' => $t['id'], ':snd' => 'admin', ':at' => $now, ':d' => json_encode($msg), ':c' => $now]);
        $t['status'] = 'answered';
        $t['lastMessageAt'] = $now;
        $t['unreadForAdmin'] = 0;
        $t['updatedAt'] = $now;
        $ctx->db->run('UPDATE chat_threads SET status = :s, last_message_at = :lm, doc = :d, updated_at = :u WHERE id = :id',
            [':s' => 'answered', ':lm' => $now, ':d' => json_encode($t), ':u' => $now, ':id' => $t['id']]);
        $t['messages'] = self::messages($ctx, $t['id']);
        return Response::json(['message' => $msg, 'thread' => $t], 201);
    }

    private static function setStatus(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $row = $ctx->db->first('SELECT doc FROM chat_threads WHERE id = :id', [':id' => $p['id']]) ?? throw HttpError::notFound('Conversation');
        $t = json_decode($row['doc'], true);
        $status = in_array($ctx->body()['status'] ?? null, ['open', 'answered', 'closed'], true) ? $ctx->body()['status'] : $t['status'];
        $t['status'] = $status;
        $t['updatedAt'] = Clock::now();
        $ctx->db->run('UPDATE chat_threads SET status = :s, doc = :d, updated_at = :u WHERE id = :id',
            [':s' => $status, ':d' => json_encode($t), ':u' => $t['updatedAt'], ':id' => $t['id']]);
        return Response::json($t);
    }
}
