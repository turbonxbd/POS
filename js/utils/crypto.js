/**
 * crypto.js - client-side hashing for the MOCK auth backend only.
 *
 * IMPORTANT: real password handling MUST happen on a server with a slow KDF
 * (bcrypt / argon2) over TLS. This SHA-256 helper exists purely so the local
 * demo does not store plaintext passwords in localStorage. It is not, and must
 * not be treated as, production password security.
 */

const STATIC_SALT = 'afia-pos-demo-salt::do-not-use-in-production';

export async function hashPassword(password) {
  const enc = new TextEncoder().encode(`${STATIC_SALT}:${password}`);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyPassword(password, hash) {
  return (await hashPassword(password)) === hash;
}

/** Opaque demo session token. A real backend issues a signed JWT / session id. */
export function issueToken(userId) {
  const rand = [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `demo.${btoa(userId).replace(/=/g, '')}.${rand}`;
}
