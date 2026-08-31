<?php
declare(strict_types=1);

namespace Afia\Modules;

use Afia\App;
use Afia\Context;
use Afia\Http\Response;
use Afia\Http\Router;
use Afia\Support\Clock;
use Afia\Support\HttpError;
use Afia\Support\Provision;
use Afia\Support\Uuid;

/**
 * Public onboarding + contact, driven from the Live/Public panel.
 *
 *   POST /signup   { businessName, ownerName?, email, password, planId? }
 *                  -> provisions an isolated merchant, a pending subscription,
 *                     signs the owner in, returns the same payload as /auth/login.
 *   POST /support  { name, email, message, subject?, planId?, merchantId? }
 *                  -> queued for the Super Admin; also fine for logged-in merchants.
 */
final class Signup
{
    public static function register(Router $r, App $app): void
    {
        $r->post('/signup', fn (Context $c) => self::signup($c, $app));
        $r->post('/support', fn (Context $c) => self::support($c));
    }

    private static function signup(Context $ctx, App $app): Response
    {
        $b = $ctx->body();
        $business = trim((string) ($b['businessName'] ?? ''));
        $email = strtolower(trim((string) ($b['email'] ?? '')));
        $password = (string) ($b['password'] ?? '');
        $errors = array_filter([
            'businessName' => $business === '' ? 'Required' : null,
            'email' => !filter_var($email, FILTER_VALIDATE_EMAIL) ? 'Enter a valid email' : null,
            'password' => strlen($password) < 8 ? 'Use at least 8 characters' : null,
        ]);
        if ($errors) {
            throw HttpError::badRequest('Please fix the highlighted fields', $errors);
        }

        $planId = $b['planId'] ?? null;
        if ($planId && !$ctx->db->first("SELECT 1 FROM plans WHERE id = :id AND status = 'active'", [':id' => $planId])) {
            $planId = null; // ignore an unknown/inactive plan rather than fail signup
        }

        try {
            $res = Provision::merchant($ctx->db, $business, $email, $password, false, trim((string) ($b['ownerName'] ?? '')));
        } catch (\RuntimeException $e) {
            throw HttpError::conflict($e->getMessage());
        }
        Provision::subscribe($ctx->db, $res['merchantId'], $planId, 'pending');

        // auto sign-in: reuse the login handler's session + payload shape
        $ctx->request->rawBody = json_encode(['email' => $email, 'password' => $password]);
        return Auth::loginProgrammatic($ctx, $app);
    }

    private static function support(Context $ctx): Response
    {
        $b = $ctx->body();
        $email = strtolower(trim((string) ($b['email'] ?? '')));
        $message = trim((string) ($b['message'] ?? ''));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || $message === '') {
            throw HttpError::badRequest('A valid email and a message are required', [
                'email' => !filter_var($email, FILTER_VALIDATE_EMAIL) ? 'Enter a valid email' : null,
                'message' => $message === '' ? 'Required' : null,
            ]);
        }
        $id = Uuid::v4();
        $now = Clock::now();
        $merchantId = $ctx->actor['merchantId'] ?? ($b['merchantId'] ?? '');
        $doc = [
            'id' => $id, 'name' => trim((string) ($b['name'] ?? '')), 'email' => $email,
            'subject' => trim((string) ($b['subject'] ?? 'General enquiry')), 'message' => $message,
            'planId' => $b['planId'] ?? null, 'merchantId' => $merchantId ?: null,
            'source' => $ctx->actor ? 'merchant' : 'public', 'status' => 'open',
            'replies' => [], 'at' => $now, 'createdAt' => $now, 'updatedAt' => $now,
        ];
        $ctx->db->run(
            'INSERT INTO support_requests (id, merchant_id, status, subject, email, at, doc, created_at, updated_at)
             VALUES (:id, :m, :s, :subj, :e, :at, :d, :at, :at)',
            [':id' => $id, ':m' => $merchantId ?: '', ':s' => 'open', ':subj' => $doc['subject'], ':e' => $email, ':at' => $now, ':d' => json_encode($doc)],
        );
        return Response::json(['ok' => true, 'id' => $id], 201);
    }
}
