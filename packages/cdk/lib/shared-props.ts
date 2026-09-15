/**
 * Properties shared by every stack in the MCP Events Serverless Agent CDK app.
 *
 * The CDK app creates a dedicated subdomain zone `<subdomain>.<parentDomain>`
 * (for example `earthquake-agent.liguori.people.aws.dev`) and a wildcard ACM
 * certificate for `*.<subdomain>.<parentDomain>`. Each stack with a public
 * endpoint mounts a custom domain under this subdomain.
 *
 * Validates Requirements 13.1, 13.2, 13.3.
 */
export interface SharedProps {
  /**
   * The parent hosted zone that already exists in Route53 (registered out of
   * band). NS delegation for the subdomain zone is added to this zone.
   *
   * Default: {@link DEFAULT_PARENT_DOMAIN}.
   */
  parentDomain: string;

  /**
   * The label prepended to {@link parentDomain} to form the subdomain zone.
   *
   * Default: {@link DEFAULT_SUBDOMAIN}.
   */
  subdomain: string;
}

/** Default parent domain when none is supplied via CDK context. */
export const DEFAULT_PARENT_DOMAIN = "liguori.people.aws.dev";

/** Default subdomain label for the earthquake agent sample. */
export const DEFAULT_SUBDOMAIN = "earthquake-agent";

/**
 * Computes the fully qualified subdomain (`<subdomain>.<parentDomain>`) that
 * the sample's resources live under.
 */
export function resolveDomainName(props: SharedProps): string {
  return `${props.subdomain}.${props.parentDomain}`;
}


/**
 * Name of the SSM parameter (in the APP region) that carries the webapp edge
 * auth gate's runtime configuration.
 *
 * `AuthStack` writes it and the Lambda@Edge auth gate reads it once per cold
 * start. It exists because Lambda@Edge supports no environment variables and the
 * values it holds (User Pool id, app client id) are CloudFormation tokens at
 * synth time, so they can be delivered neither as env vars nor baked into the
 * function's bundle. The NAME, unlike those values, is a literal both sides can
 * agree on at synth time — hence this constant rather than a stack export.
 */
export const EDGE_AUTH_CONFIG_PARAMETER_NAME =
  "/earthquake-agent/auth/edge-config";
