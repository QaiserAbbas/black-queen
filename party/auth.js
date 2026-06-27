/* =============================================================================
 * Black Queen — AUTH PRIMITIVES (Web Crypto, no dependencies)
 * -----------------------------------------------------------------------------
 * Password hashing (PBKDF2-SHA256), random session tokens, and cookie helpers.
 * Runs in the Workers runtime — crypto.subtle / crypto.getRandomValues / btoa /
 * atob are all available.
 * ===========================================================================*/

const COOKIE = "bq_session";
export const SESSION_TTL_SEC = 30 * 24 * 3600;   // 30 days
const PBKDF2_ITERATIONS = 100000;

/* ---- base64 (over raw bytes) ------------------------------------------- */
function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(str) {
  const s = atob(str);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return new Uint8Array(bits);
}

// Constant-time comparison so a wrong password can't be timed byte-by-byte.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return { hash: b64(hash), salt: b64(salt), iterations: PBKDF2_ITERATIONS };
}

export async function verifyPassword(password, saltB64, hashB64, iterations) {
  try {
    const hash = await pbkdf2(password, unb64(saltB64), iterations);
    return timingSafeEqual(hash, unb64(hashB64));
  } catch (_) { return false; }
}

export function randomToken(nBytes = 32) {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/* ---- cookies ------------------------------------------------------------ */
export function getSessionToken(request) {
  const c = request.headers.get("Cookie") || "";
  const m = c.match(/(?:^|;\s*)bq_session=([^;]+)/);
  return m ? m[1] : null;
}

// Secure is set only over https so cookies still work on http://localhost in dev.
export function sessionCookie(token, secure) {
  return `${COOKIE}=${token}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}`;
}
export function clearSessionCookie(secure) {
  return `${COOKIE}=; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=0`;
}
