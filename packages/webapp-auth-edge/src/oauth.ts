/**
 * Cognito Hosted UI authorization code flow (with PKCE) as executed by the edge.
 *
 * The distribution's app client is a PUBLIC client with no secret — the same one
 * the SPA uses — so Cognito requires PKCE for the code grant. The edge is not a
 * browser and has nowhere to keep the verifier between the two requests, so the
 * verifier, a CSRF nonce, and the originally-requested path are packed into one
 * short-lived HttpOnly cookie (the "transaction"), with only the nonce echoed
 * through the OAuth `state` parameter. The callback then requires the two to
 * agree, which is what makes a forged callback useless.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { EdgeAuthConfig } from "./config.js";

/** Path on the app domain that Cognito redirects back to. */
export const CALLBACK_PATH = "/_auth/callback";

/** Path that clears the local session and signs out of the Hosted UI. */
export const LOGOUT_PATH = "/_auth/logout";

/** How long an in-flight authorization transaction stays valid. */
export const TRANSACTION_TTL_SECONDS = 600;

/** An in-flight authorization transaction, carried in a cookie. */
export interface AuthTransaction {
  /** PKCE code verifier. */
  readonly verifier: string;
  /** CSRF nonce, echoed as the OAuth `state` parameter. */
  readonly nonce: string;
  /** Absolute path (with query) to return the browser to after sign-in. */
  readonly returnTo: string;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** Create a fresh transaction for a request that needs authentication. */
export function createTransaction(returnTo: string): AuthTransaction {
  return {
    verifier: base64Url(randomBytes(32)),
    nonce: base64Url(randomBytes(16)),
    returnTo: sanitizeReturnTo(returnTo),
  };
}

/**
 * Reject anything that is not a same-origin absolute path, which prevents the
 * transaction cookie from being used as an open redirect. `//evil.example` is a
 * protocol-relative URL and must not survive.
 */
export function sanitizeReturnTo(returnTo: string): string {
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) {
    return "/";
  }
  return returnTo;
}

/** Pack a transaction into a cookie value. */
export function encodeTransaction(transaction: AuthTransaction): string {
  return base64Url(Buffer.from(JSON.stringify(transaction), "utf8"));
}

/** Unpack a transaction cookie value, or `undefined` when it is unusable. */
export function decodeTransaction(value: string): AuthTransaction | undefined {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.verifier !== "string" ||
      typeof candidate.nonce !== "string" ||
      typeof candidate.returnTo !== "string"
    ) {
      return undefined;
    }
    return {
      verifier: candidate.verifier,
      nonce: candidate.nonce,
      returnTo: sanitizeReturnTo(candidate.returnTo),
    };
  } catch {
    return undefined;
  }
}

/** Constant-time comparison of the returned `state` against the cookie nonce. */
export function nonceMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The redirect URI registered with the app client for the edge callback. */
export function callbackUri(config: EdgeAuthConfig): string {
  return `https://${config.appDomain}${CALLBACK_PATH}`;
}

/** Build the Hosted UI authorization URL for a transaction. */
export function buildAuthorizeUrl(
  config: EdgeAuthConfig,
  transaction: AuthTransaction,
): string {
  const challenge = base64Url(
    createHash("sha256").update(transaction.verifier).digest(),
  );
  const url = new URL(`https://${config.hostedUiDomain}/oauth2/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", callbackUri(config));
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", transaction.nonce);
  return url.toString();
}

/** Build the Hosted UI logout URL, which returns to the app root. */
export function buildLogoutUrl(config: EdgeAuthConfig): string {
  const url = new URL(`https://${config.hostedUiDomain}/logout`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("logout_uri", `https://${config.appDomain}/`);
  return url.toString();
}

/** The subset of the Cognito token response this gate needs. */
export interface EdgeTokenSet {
  readonly idToken: string;
  /** Lifetime of the id token in seconds. */
  readonly expiresIn: number;
}

/**
 * Exchange an authorization code for tokens at the Hosted UI token endpoint.
 * Only the id token is retained: it is the credential the gate re-verifies on
 * every subsequent request, and the SPA obtains its own tokens independently.
 */
export async function exchangeCodeForTokens(
  config: EdgeAuthConfig,
  params: { code: string; verifier: string },
  fetchFn: typeof fetch = fetch,
): Promise<EdgeTokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code: params.code,
    redirect_uri: callbackUri(config),
    code_verifier: params.verifier,
  });

  const response = await fetchFn(
    `https://${config.hostedUiDomain}/oauth2/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Cognito token endpoint failed (${String(response.status)}): ${text}`,
    );
  }

  const parsed = JSON.parse(text) as {
    id_token?: string;
    expires_in?: number;
  };
  if (!parsed.id_token) {
    throw new Error("Cognito token endpoint returned no id token");
  }
  return { idToken: parsed.id_token, expiresIn: parsed.expires_in ?? 3600 };
}
