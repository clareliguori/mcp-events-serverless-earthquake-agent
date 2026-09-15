/**
 * Tests for the security-relevant pure logic of the edge auth gate: the
 * open-redirect guard on `returnTo`, the CSRF nonce comparison, the transaction
 * cookie round trip, and cookie parsing. The network paths (token exchange, JWKS
 * verification) are covered by the deployed integration behaviour rather than
 * mocked here.
 */

import { describe, expect, it } from "vitest";
import type { CloudFrontHeaders } from "aws-lambda";
import { parseCookies, serializeCookie, expireCookie } from "./cookies.js";
import {
  buildAuthorizeUrl,
  createTransaction,
  decodeTransaction,
  encodeTransaction,
  nonceMatches,
  sanitizeReturnTo,
} from "./oauth.js";
import type { EdgeAuthConfig } from "./config.js";

const config: EdgeAuthConfig = {
  userPoolId: "us-west-2_example",
  clientId: "exampleclientid",
  hostedUiDomain: "auth.example.test",
  appDomain: "app.example.test",
};

describe("sanitizeReturnTo (open redirect guard)", () => {
  it("keeps same-origin absolute paths, with query strings", () => {
    expect(sanitizeReturnTo("/reports")).toBe("/reports");
    expect(sanitizeReturnTo("/config?tab=filters")).toBe("/config?tab=filters");
  });

  it("rejects protocol-relative URLs, which would leave the site", () => {
    expect(sanitizeReturnTo("//evil.test/steal")).toBe("/");
  });

  it("rejects absolute URLs and anything not rooted at /", () => {
    expect(sanitizeReturnTo("https://evil.test")).toBe("/");
    expect(sanitizeReturnTo("reports")).toBe("/");
    expect(sanitizeReturnTo("")).toBe("/");
  });
});

describe("transaction cookie", () => {
  it("round trips", () => {
    const transaction = createTransaction("/reports");
    expect(decodeTransaction(encodeTransaction(transaction))).toEqual(
      transaction,
    );
  });

  it("generates a distinct verifier and nonce each time", () => {
    const a = createTransaction("/");
    const b = createTransaction("/");
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.nonce).not.toBe(b.nonce);
    // A PKCE verifier must be long enough to be unguessable (43+ chars for
    // base64url of 32 bytes).
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("re-sanitizes returnTo on decode, so a tampered cookie cannot redirect off site", () => {
    const forged = Buffer.from(
      JSON.stringify({
        verifier: "v",
        nonce: "n",
        returnTo: "//evil.test",
      }),
      "utf8",
    ).toString("base64url");
    expect(decodeTransaction(forged)?.returnTo).toBe("/");
  });

  it("returns undefined for unusable cookie values", () => {
    expect(decodeTransaction("not-base64-json")).toBeUndefined();
    expect(
      decodeTransaction(Buffer.from("{}", "utf8").toString("base64url")),
    ).toBeUndefined();
    expect(decodeTransaction("")).toBeUndefined();
  });
});

describe("nonceMatches (CSRF check)", () => {
  it("accepts only an exact match", () => {
    expect(nonceMatches("abc123", "abc123")).toBe(true);
    expect(nonceMatches("abc123", "abc124")).toBe(false);
  });

  it("rejects length mismatches without throwing", () => {
    expect(nonceMatches("abc", "abcdef")).toBe(false);
    expect(nonceMatches("abc", "")).toBe(false);
  });
});

describe("buildAuthorizeUrl", () => {
  it("requests a PKCE authorization code for the edge callback", () => {
    const transaction = createTransaction("/reports");
    const url = new URL(buildAuthorizeUrl(config, transaction));

    expect(url.origin).toBe("https://auth.example.test");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("exampleclientid");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.test/_auth/callback",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(transaction.nonce);
    // The verifier itself must never leave the cookie.
    expect(url.toString()).not.toContain(transaction.verifier);
  });
});

describe("parseCookies", () => {
  function headers(...values: string[]): CloudFrontHeaders {
    return { cookie: values.map((value) => ({ key: "Cookie", value })) };
  }

  it("parses multiple pairs from one header", () => {
    const jar = parseCookies(headers("a=1; b=2"));
    expect(jar.get("a")).toBe("1");
    expect(jar.get("b")).toBe("2");
  });

  it("parses pairs split across several Cookie headers", () => {
    const jar = parseCookies(headers("a=1", "b=2"));
    expect(jar.get("a")).toBe("1");
    expect(jar.get("b")).toBe("2");
  });

  it("preserves values containing '=' (JWTs and base64url padding)", () => {
    const jar = parseCookies(headers("token=aaa.bbb.ccc==="));
    expect(jar.get("token")).toBe("aaa.bbb.ccc===");
  });

  it("is empty when no cookie header is present", () => {
    expect(parseCookies({}).size).toBe(0);
  });

  it("skips malformed segments", () => {
    const jar = parseCookies(headers("novalue; =noname; good=1"));
    expect(jar.get("good")).toBe("1");
    expect(jar.has("novalue")).toBe(false);
  });
});

describe("cookie serialization", () => {
  it("always sets the flags the gate depends on", () => {
    const cookie = serializeCookie("s", "v", { maxAgeSeconds: 3600 });
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    // Lax, not Strict: the cookie must survive the redirect back from Cognito.
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=3600");
  });

  it("expires a cookie with Max-Age=0", () => {
    expect(expireCookie("s")).toContain("Max-Age=0");
  });
});
