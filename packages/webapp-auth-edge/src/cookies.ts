/**
 * Cookie helpers for the CloudFront viewer-request auth gate.
 *
 * CloudFront represents headers as a map of lowercase name -> array of
 * `{ key, value }` entries, and a viewer can send the cookie jar split across
 * more than one `Cookie` header, so parsing has to walk every entry rather than
 * reading `headers.cookie[0]`.
 */

import type { CloudFrontHeaders } from "aws-lambda";

/** The cookie holding the verified Cognito id token (the session). */
export const SESSION_COOKIE = "eqaAuthSession";

/**
 * The cookie holding the in-flight authorization transaction (PKCE verifier,
 * CSRF nonce, and the path to return to). Short-lived and single use.
 */
export const TRANSACTION_COOKIE = "eqaAuthTx";

/** Parse all `Cookie` headers on a CloudFront request into a name -> value map. */
export function parseCookies(headers: CloudFrontHeaders): Map<string, string> {
  const jar = new Map<string, string>();
  for (const header of headers.cookie ?? []) {
    for (const pair of header.value.split(";")) {
      const separator = pair.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (name.length > 0 && !jar.has(name)) {
        jar.set(name, value);
      }
    }
  }
  return jar;
}

/** Options for {@link serializeCookie}. Secure/HttpOnly/Path are always set. */
export interface CookieOptions {
  /** Lifetime in seconds. Use 0 to expire the cookie immediately. */
  readonly maxAgeSeconds: number;
}

/**
 * Serialize a `Set-Cookie` value.
 *
 * `SameSite=Lax` (not `Strict`) is required: the browser must send these cookies
 * on the top-level redirect back from the Cognito Hosted UI, which is a
 * cross-site navigation that `Strict` would suppress — breaking the callback.
 */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions,
): string {
  return [
    `${name}=${value}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${String(options.maxAgeSeconds)}`,
  ].join("; ");
}

/** Build a `Set-Cookie` value that deletes a cookie. */
export function expireCookie(name: string): string {
  return serializeCookie(name, "", { maxAgeSeconds: 0 });
}

/** Wrap `Set-Cookie` values into the CloudFront response header shape. */
export function setCookieHeaders(values: string[]): CloudFrontHeaders {
  return {
    "set-cookie": values.map((value) => ({ key: "Set-Cookie", value })),
  };
}
