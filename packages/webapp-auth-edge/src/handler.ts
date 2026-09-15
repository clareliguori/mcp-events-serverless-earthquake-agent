/**
 * CloudFront **viewer-request** Lambda@Edge auth gate for the webapp SPA.
 *
 * Without this, every object in the SPA bucket — the landing page, the JS
 * bundle, `config.json` — is anonymously fetchable, and authentication only
 * begins once the SPA has already been served. This function moves the
 * authentication boundary in front of the distribution: a request without a
 * valid Cognito session never reaches the origin at all.
 *
 * WHY VIEWER-REQUEST: an origin-request trigger is skipped on a cache hit, so a
 * cached landing page would still be served to an anonymous viewer. Only
 * viewer-request runs on every request, ahead of the cache lookup.
 *
 * FLOW
 * 1. No/invalid session cookie -> 302 to the Cognito Hosted UI, with the PKCE
 *    verifier, a CSRF nonce, and the requested path stored in a short-lived
 *    transaction cookie.
 * 2. `GET /_auth/callback?code=...&state=...` -> verify the nonce against the
 *    transaction cookie, exchange the code for an id token, store it as an
 *    HttpOnly session cookie, and 302 back to the originally requested path.
 * 3. Valid session cookie -> the request passes through to S3 untouched.
 *
 * TOKEN EXPIRY is handled by the same path as a missing cookie: verification
 * fails, so the viewer is redirected to `/oauth2/authorize` again. Cognito's own
 * session cookie is still valid at that point, so it re-issues silently — the
 * viewer sees a redirect, not a login form. That is deliberately cheaper than
 * holding a refresh token at the edge, which would mean storing a
 * long-lived credential in a browser cookie.
 *
 * RELATIONSHIP TO THE SPA: none. The SPA keeps its own in-memory PKCE flow
 * (Requirement 10.6) and obtains its own tokens for Data API calls. Because the
 * viewer already has a Cognito session by the time the SPA loads, the SPA's
 * sign-in is a silent redirect rather than a second login prompt. This function
 * never hands its id token to the page — the session cookie is HttpOnly and is
 * only ever read here.
 */

import type {
  CloudFrontHeaders,
  CloudFrontRequest,
  CloudFrontRequestHandler,
  CloudFrontRequestResult,
  CloudFrontResultResponse,
} from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { loadConfig, type EdgeAuthConfig } from "./config.js";
import {
  expireCookie,
  parseCookies,
  serializeCookie,
  SESSION_COOKIE,
  TRANSACTION_COOKIE,
} from "./cookies.js";
import {
  buildAuthorizeUrl,
  buildLogoutUrl,
  CALLBACK_PATH,
  createTransaction,
  decodeTransaction,
  encodeTransaction,
  exchangeCodeForTokens,
  LOGOUT_PATH,
  nonceMatches,
  TRANSACTION_TTL_SECONDS,
} from "./oauth.js";

/**
 * The JWKS-backed id token verifier. Cached in module scope so the JWKS is
 * fetched once per execution environment rather than once per request.
 */
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;

function getVerifier(
  config: EdgeAuthConfig,
): ReturnType<typeof CognitoJwtVerifier.create> {
  verifier ??= CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    tokenUse: "id",
    clientId: config.clientId,
  });
  return verifier;
}

/** Test seam: drop the cached verifier so a test can supply its own config. */
export function resetVerifierForTesting(): void {
  verifier = undefined;
}

function headers(
  location: string | undefined,
  cookies: string[],
): CloudFrontHeaders {
  const result: CloudFrontHeaders = {
    // Never let a browser or shared cache retain an auth redirect or an error.
    "cache-control": [{ key: "Cache-Control", value: "no-store" }],
  };
  if (location !== undefined) {
    result.location = [{ key: "Location", value: location }];
  }
  if (cookies.length > 0) {
    result["set-cookie"] = cookies.map((value) => ({
      key: "Set-Cookie",
      value,
    }));
  }
  return result;
}

function redirect(
  location: string,
  cookies: string[] = [],
): CloudFrontResultResponse {
  return {
    status: "302",
    statusDescription: "Found",
    headers: headers(location, cookies),
  };
}

function errorResponse(
  status: string,
  statusDescription: string,
  message: string,
): CloudFrontResultResponse {
  return {
    status,
    statusDescription,
    headers: {
      ...headers(undefined, []),
      "content-type": [{ key: "Content-Type", value: "text/plain" }],
    },
    body: message,
  };
}

/** The path (with query string) the viewer originally asked for. */
function requestedPath(request: CloudFrontRequest): string {
  return request.querystring.length > 0
    ? `${request.uri}?${request.querystring}`
    : request.uri;
}

/** Send the viewer to the Hosted UI, remembering where they were headed. */
function startAuthorization(
  request: CloudFrontRequest,
  config: EdgeAuthConfig,
): CloudFrontResultResponse {
  const transaction = createTransaction(requestedPath(request));
  return redirect(buildAuthorizeUrl(config, transaction), [
    serializeCookie(TRANSACTION_COOKIE, encodeTransaction(transaction), {
      maxAgeSeconds: TRANSACTION_TTL_SECONDS,
    }),
    // Clear any stale or invalid session so a bad cookie cannot loop the viewer.
    expireCookie(SESSION_COOKIE),
  ]);
}

/** Handle the Hosted UI redirect back to `/_auth/callback`. */
async function handleCallback(
  request: CloudFrontRequest,
  config: EdgeAuthConfig,
): Promise<CloudFrontResultResponse> {
  const query = new URLSearchParams(request.querystring);

  const oauthError = query.get("error");
  if (oauthError !== null) {
    console.error("Hosted UI returned an OAuth error", {
      error: oauthError,
      description: query.get("error_description"),
    });
    return errorResponse("403", "Forbidden", "Sign-in failed.");
  }

  const code = query.get("code");
  const state = query.get("state");
  const transactionCookie = parseCookies(request.headers).get(
    TRANSACTION_COOKIE,
  );
  const transaction =
    transactionCookie === undefined
      ? undefined
      : decodeTransaction(transactionCookie);

  if (
    code === null ||
    state === null ||
    transaction === undefined ||
    !nonceMatches(transaction.nonce, state)
  ) {
    // A stale, missing, or mismatched transaction is unrecoverable here, but it
    // is also the normal result of a bookmarked/replayed callback URL. Start a
    // fresh authorization rather than showing an error.
    return startAuthorization(request, config);
  }

  const tokens = await exchangeCodeForTokens(config, {
    code,
    verifier: transaction.verifier,
  });
  // Verify before trusting it, so "what counts as a session" has exactly one
  // definition in this file.
  await getVerifier(config).verify(tokens.idToken);

  return redirect(transaction.returnTo, [
    serializeCookie(SESSION_COOKIE, tokens.idToken, {
      maxAgeSeconds: tokens.expiresIn,
    }),
    expireCookie(TRANSACTION_COOKIE),
  ]);
}

/** Clear the edge session and sign out of the Hosted UI. */
function handleLogout(config: EdgeAuthConfig): CloudFrontResultResponse {
  return redirect(buildLogoutUrl(config), [
    expireCookie(SESSION_COOKIE),
    expireCookie(TRANSACTION_COOKIE),
  ]);
}

/** True when the cookie holds an id token this pool/client issued and still honours. */
async function hasValidSession(
  request: CloudFrontRequest,
  config: EdgeAuthConfig,
): Promise<boolean> {
  const session = parseCookies(request.headers).get(SESSION_COOKIE);
  if (session === undefined || session.length === 0) {
    return false;
  }
  try {
    await getVerifier(config).verify(session);
    return true;
  } catch {
    // Expired, tampered with, or issued for another client: treat all the same.
    return false;
  }
}

export const handler: CloudFrontRequestHandler = async (
  event,
): Promise<CloudFrontRequestResult> => {
  const request = event.Records[0].cf.request;

  try {
    const config = await loadConfig();

    if (request.uri === CALLBACK_PATH) {
      return await handleCallback(request, config);
    }
    if (request.uri === LOGOUT_PATH) {
      return handleLogout(config);
    }
    if (await hasValidSession(request, config)) {
      return request;
    }
    return startAuthorization(request, config);
  } catch (err) {
    // Failing closed is the whole point of this function: if we cannot decide,
    // nothing reaches the origin.
    console.error("Edge auth gate failed", err);
    return errorResponse(
      "500",
      "Internal Server Error",
      "Authentication is unavailable.",
    );
  }
};
