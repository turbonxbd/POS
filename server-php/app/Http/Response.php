<?php
declare(strict_types=1);

namespace Afia\Http;

final class Response
{
    /** @var list<string> */
    public array $cookies = [];

    /** Raw body bytes - when set, sent verbatim instead of JSON-encoding $data. */
    public ?string $raw = null;

    public function __construct(
        public int $status = 200,
        public mixed $data = null,
        public array $headers = [],
    ) {}

    public static function json(mixed $data, int $status = 200): self
    {
        return new self($status, $data, ['Content-Type' => 'application/json']);
    }

    public static function noContent(): self
    {
        return new self(204, null);
    }

    public function withCookie(string $cookie): self
    {
        $this->cookies[] = $cookie;
        return $this;
    }

    public function send(): void
    {
        http_response_code($this->status);
        foreach ($this->headers as $k => $v) {
            header("$k: $v");
        }
        foreach ($this->cookies as $c) {
            header('Set-Cookie: ' . $c, false);
        }
        if ($this->raw !== null) {
            echo $this->raw;
            return;
        }
        if ($this->status === 204 || $this->data === null) {
            return;
        }
        echo json_encode($this->data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    /** For tests. */
    public function bodyArray(): mixed
    {
        return $this->data;
    }
}
