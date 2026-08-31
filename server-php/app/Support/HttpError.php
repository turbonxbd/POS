<?php
declare(strict_types=1);

namespace Afia\Support;

/**
 * Thrown by handlers, caught by App, rendered as the JSON body the frontend
 * expects: { message, ...(errors ? { errors } : {}) }
 * (js/core/http.js restRequest + js/core/mock/router.js).
 */
final class HttpError extends \RuntimeException
{
    public function __construct(
        public int $status,
        string $message,
        public ?array $extra = null,
    ) {
        parent::__construct($message);
    }

    public function body(): array
    {
        return ['message' => $this->getMessage()] + ($this->extra ?? []);
    }

    public static function badRequest(string $message = 'Validation failed', ?array $errors = null): self
    {
        return new self(422, $message, $errors !== null ? ['errors' => $errors] : null);
    }
    public static function unauthorized(string $message = 'Not authenticated'): self
    {
        return new self(401, $message);
    }
    public static function forbidden(string $message = 'You do not have permission to do this'): self
    {
        return new self(403, $message);
    }
    public static function notFound(string $what = 'Resource'): self
    {
        return new self(404, "$what not found");
    }
    public static function conflict(string $message): self
    {
        return new self(409, $message);
    }
    public static function tooMany(string $message = 'Too many attempts. Try again later.'): self
    {
        return new self(429, $message);
    }
}
