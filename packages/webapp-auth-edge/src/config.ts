/**
 * Runtime configuration loading for the Lambda@Edge auth gate.
 *
 * WHY THIS EXISTS AT ALL: Lambda@Edge does not support environment variables
 * (see "Restrictions on Lambda@Edge" in the CloudFront developer guide), and the
 * two values this function needs — the Cognito User Pool id and the app client
 * id — are CloudFormation tokens at synth time, so they cannot be baked into the
 * esbuild asset either. They are therefore published by `AuthStack` into a
 * single SSM String parameter in the APP region and read here once per cold
 * start, cached in module scope for the life of the execution environment.
 *
 * The parameter NAME and the APP REGION *are* known at synth time, so they are
 * injected into the bundle by esbuild `define` (see `WebappAuthEdgeStack`),
 * which replaces the `process.env.*` reads below with string literals. Reading
 * them through `process.env` keeps this module runnable (and testable) outside
 * the bundle, where the same values can be supplied as real env vars.
 *
 * NO AWS SDK CLIENT: this calls the SSM JSON API directly with a SigV4-signed
 * `fetch` (the same approach as `agent/src/sigv4.ts`) rather than bundling
 * `@aws-sdk/client-ssm`. Not because of a package-size limit — Lambda@Edge
 * allows 50 MB compressed — but because this function runs on EVERY viewer
 * request, so its bundle is cold-start latency in the request path: the signed
 * `fetch` keeps the asset at ~450 KB where a full SSM client roughly doubles it.
 * For the same reason the response is validated with a hand-written type guard
 * instead of the repo's usual zod schemas.
 */

import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsCredentialIdentity, HttpRequest } from "@smithy/types";

/** The values the auth gate needs to run the Cognito authorization code flow. */
export interface EdgeAuthConfig {
  /** Cognito User Pool id, e.g. `us-west-2_ABC123`. Used for JWKS + issuer. */
  readonly userPoolId: string;
  /** Public (PKCE) app client id used for authorize + token requests. */
  readonly clientId: string;
  /** Hosted UI custom domain, e.g. `auth.earthquake-agent.example.com`. */
  readonly hostedUiDomain: string;
  /** The app's own custom domain, e.g. `app.earthquake-agent.example.com`. */
  readonly appDomain: string;
}

function isEdgeAuthConfig(value: unknown): value is EdgeAuthConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.userPoolId === "string" &&
    candidate.userPoolId.length > 0 &&
    typeof candidate.clientId === "string" &&
    candidate.clientId.length > 0 &&
    typeof candidate.hostedUiDomain === "string" &&
    candidate.hostedUiDomain.length > 0 &&
    typeof candidate.appDomain === "string" &&
    candidate.appDomain.length > 0
  );
}

/**
 * Read the execution role's credentials from the reserved environment
 * variables.
 *
 * Deliberately NOT `defaultProvider()` from `@aws-sdk/credential-provider-node`.
 * CDK's `NodejsFunction` leaves `@aws-sdk/*` imports EXTERNAL by default,
 * expecting the Lambda runtime to supply them — a bet this function should not
 * make, because it must be self-contained to run at the edge. Lambda@Edge does
 * populate the reserved credential variables even though user-defined
 * environment variables are unsupported, so reading them directly is both
 * smaller and one less runtime assumption. (`externalModules: []` in the stack
 * enforces the self-contained property for anything added later.)
 */
function credentialsFromEnvironment(): AwsCredentialIdentity {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "No execution role credentials in the environment; cannot sign the SSM request",
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(process.env.AWS_SESSION_TOKEN !== undefined && {
      sessionToken: process.env.AWS_SESSION_TOKEN,
    }),
  };
}

/**
 * Fetch the config parameter with a SigV4-signed call to the SSM JSON API.
 */
async function fetchConfigFromSsm(): Promise<EdgeAuthConfig> {
  const parameterName = process.env.EQA_EDGE_CONFIG_PARAM;
  const region = process.env.EQA_EDGE_CONFIG_REGION;
  if (!parameterName || !region) {
    throw new Error(
      "Edge auth config location was not injected into the bundle (EQA_EDGE_CONFIG_PARAM / EQA_EDGE_CONFIG_REGION)",
    );
  }

  const hostname = `ssm.${region}.amazonaws.com`;
  const body = JSON.stringify({ Name: parameterName });
  const toSign: HttpRequest = {
    method: "POST",
    protocol: "https:",
    hostname,
    path: "/",
    headers: {
      host: hostname,
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "AmazonSSM.GetParameter",
    },
    body,
  };

  const signer = new SignatureV4({
    service: "ssm",
    region,
    credentials: credentialsFromEnvironment(),
    sha256: Sha256,
  });
  const signed = await signer.sign(toSign);

  const response = await fetch(`https://${hostname}/`, {
    method: "POST",
    headers: signed.headers,
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `SSM GetParameter for ${parameterName} failed (${String(response.status)}): ${text}`,
    );
  }

  const envelope = JSON.parse(text) as { Parameter?: { Value?: string } };
  const raw = envelope.Parameter?.Value;
  if (!raw) {
    throw new Error(`SSM parameter ${parameterName} has no value`);
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isEdgeAuthConfig(parsed)) {
    throw new Error(
      `SSM parameter ${parameterName} does not contain a valid edge auth config`,
    );
  }
  return parsed;
}

/**
 * The in-flight or resolved config load. The PROMISE is cached (not just the
 * value) so concurrent invocations on a warm environment share a single SSM
 * call. A failed load is discarded so the next invocation retries rather than
 * pinning a transient error for the life of the container.
 */
let cached: Promise<EdgeAuthConfig> | undefined;

/** Load the edge auth config, reusing the cached value on warm invocations. */
export function loadConfig(): Promise<EdgeAuthConfig> {
  cached ??= fetchConfigFromSsm().catch((err: unknown) => {
    cached = undefined;
    throw err;
  });
  return cached;
}

/** Test seam: replace the cached config (pass `undefined` to clear it). */
export function setConfigForTesting(config: EdgeAuthConfig | undefined): void {
  cached = config === undefined ? undefined : Promise.resolve(config);
}
