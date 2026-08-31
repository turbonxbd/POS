<?php
declare(strict_types=1);

namespace Afia\Http;

use Afia\Support\HttpError;

/**
 * Minimal method+path router. Patterns use `:name` params, matching the style of
 * js/core/mock/router.js so route strings port across 1:1.
 */
final class Router
{
    /** @var list<array{method:string,regex:string,keys:list<string>,handler:callable}> */
    private array $routes = [];

    public function add(string $method, string $pattern, callable $handler): void
    {
        $keys = [];
        $regex = preg_replace_callback('/:(\w+)/', function ($m) use (&$keys) {
            $keys[] = $m[1];
            return '([^/]+)';
        }, rtrim($pattern, '/'));
        $this->routes[] = [
            'method'  => strtoupper($method),
            'regex'   => '#^' . $regex . '/?$#',
            'keys'    => $keys,
            'handler' => $handler,
        ];
    }

    public function get(string $p, callable $h): void { $this->add('GET', $p, $h); }
    public function post(string $p, callable $h): void { $this->add('POST', $p, $h); }
    public function put(string $p, callable $h): void { $this->add('PUT', $p, $h); }
    public function patch(string $p, callable $h): void { $this->add('PATCH', $p, $h); }
    public function delete(string $p, callable $h): void { $this->add('DELETE', $p, $h); }

    /** @return array{callable, array<string,string>} */
    public function match(string $method, string $path): array
    {
        $clean = '/' . trim($path, '/');
        $methodMismatch = false;
        foreach ($this->routes as $route) {
            if (!preg_match($route['regex'], $clean, $m)) {
                continue;
            }
            if ($route['method'] !== strtoupper($method)) {
                $methodMismatch = true;
                continue;
            }
            $params = [];
            foreach ($route['keys'] as $i => $key) {
                $params[$key] = rawurldecode($m[$i + 1]);
            }
            return [$route['handler'], $params];
        }
        throw new HttpError($methodMismatch ? 405 : 404, "Endpoint {$method} {$clean} is not available");
    }
}
