# AGENTS.md — working in this repository

Instructions for Kiro (and other agents) to navigate and contribute to the
**MCP Events Serverless Agent** sample. Read this before making changes.

## What this project is

A demo of the experimental **MCP Events extension** (webhook delivery mode) that
wakes a **serverless Strands agent** for multi-customer earthquake monitoring.
Two MCP servers deliver signed webhooks that wake a Lambda-hosted agent; the
agent's conversation history is its accumulator, and it emits per-customer
briefing reports. Full prose lives in `README.md`; the design, requirements, and
task breakdown live in `.kiro/specs/mcp-events-serverless-agent/`.

**The code is the source of truth.** The spec under `.kiro/specs` predates some
of the implementation and is out of date in places (see
[Where the code diverges from the spec](#where-the-code-diverges-from-the-spec)).
Verify against the code before relying on the spec.

## Repository map

TypeScript ESM (NodeNext) monorepo, npm workspaces, Node >= 20. Each package has
its own `tsconfig.json` (composite project references) and `src/`.

| Path                                | What lives here                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src`               | `models.ts` (data models), `validation.ts` (zod schemas), `constants.ts`, `crypto.ts` (KMS encrypt/decrypt of the webhook secret), `webhooks.ts` (Standard Webhooks), `secret.ts` (`whsec_` generation/format). Barrel: `index.ts`.                                                                                                   |
| `packages/mcp-server-core/src`      | Shared MCP server machinery: `clients.ts` (AWS SDK singletons + test seams), `env.ts`, `subscription-store.ts`, `webhook-delivery.ts` (signed POST + retry), `mcp-transport.ts` (JSON-RPC `events/*`), `dispatch.ts` (dual-trigger Lambda dispatch).                                                                                  |
| `packages/usgs-server/src`          | MCP Server 1: `poller.ts` (USGS fetch + cursor dedup), `filter.ts` (per-subscription filtering), `handler.ts`.                                                                                                                                                                                                                        |
| `packages/scheduler-server/src`     | MCP Server 2: `handler.ts` (interval-based schedule check + manual trigger).                                                                                                                                                                                                                                                            |
| `packages/webhook-receiver/src`     | `signature.ts` (HMAC verify + replay window), `handler.ts` (verify → SQS).                                                                                                                                                                                                                                                            |
| `packages/agent/src`                | The Strands agent: `router.ts` (SQS → subscription → customer), `config.ts` (load `CustomerConfig` from Data API), `lock.ts` (DynamoDB distributed lock), `accumulate.ts` (earthquake → conversation), `briefing.ts` (`save_report` tool), `recovery.ts` (corrupt-session archive), `sigv4.ts` (signed Data API calls), `handler.ts`. |
| `packages/subscription-manager/src` | `register.ts` (DynamoDB Stream → subscribe on both servers), `refresh.ts` (EventBridge → refresh/rotate), `secret.ts`, `handler.ts` (dual trigger).                                                                                                                                                                                   |
| `packages/data-api/src`             | `handler.ts` + `router.ts` + `auth.ts` (dual auth) + `routes/{config,subscriptions,reports,trigger,session}.ts`.                                                                                                                                                                                                                      |
| `packages/webapp/src`               | SvelteKit SPA. `lib/auth` (Cognito PKCE), `lib/api/client.ts`, `lib/{config,reports,conversation}`, `lib/components/ui` (shadcn-svelte), `routes/{config,reports,conversation}`.                                                                                                                                                      |
| `packages/cdk/bin/app.ts`           | Instantiates the ten stacks and wires their dependencies.                                                                                                                                                                                                                                                                             |
| `packages/cdk/lib`                  | One file per stack + `mcp-server-construct.ts` (shared by the two MCP server stacks), `shared-props.ts` (domain config), `dns-regional-stack.ts`, `dns-us-east-1-stack.ts`.                                                                                                                                                           |
| `packages/integration-tests/src`    | Black-box e2e against a deployed stack (`harness.ts`, `config.ts`, `e2e.test.ts`). See its `README.md`.                                                                                                                                                                                                                               |

## Standard development workflow

- Before completing a task, always validate your changes, which may include compile, lint, run tests, and run the application and interact with it.
- When you have completed a task, commit your changes in git using a well-formed commit message consisting of a single sentence summary and no more than one paragraph explaining the change.
  Do not include sensitive information in commit messages, including AWS resource ARNs.
  For the author of the commit, use `--author="$(git config user.name) (Kiro) <$(git config user.email)>"` in the git commit command.
  If you are working on a Kiro spec task, mark the task as complete in the tasks.md BEFORE committing your changes.

### Validation commands

Run from the repo root unless noted. Validate the whole monorepo, not just the
file you touched (composite project references mean a change can break a
dependent package).

```bash
npm run build       # tsc --build across all referenced packages (== typecheck)
npm run lint        # eslint . (flat config, type-checked rules)
npm test            # vitest run across the monorepo
```

Per-package iteration:

```bash
npx vitest run packages/<pkg>            # tests for one package
npm run build --workspace @mcp-events/<pkg>
```

The **webapp** has its own tooling and is excluded from the root `tsc --build`
references and root ESLint. Validate it separately:

```bash
npm run check --workspace @mcp-events/webapp   # svelte-check (type check)
npm run build --workspace @mcp-events/webapp   # vite build (static SPA)
cd packages/webapp && npx vitest run           # webapp unit tests (own vitest.config.ts, no `test` script)
```

### Testing the webapp with Playwright

Load the `playwright-cli` skill (`.kiro/skills/playwright-cli/SKILL.md`) before
driving a browser. There are two ways to exercise the webapp; pick based on what
you need.

`playwright-cli` general tips:

- Prefer `playwright-cli snapshot --raw` (accessibility tree) over screenshots to
  read state; use `screenshot --filename=foo.png` only when an image is needed.
- Use `playwright-cli console --raw` and `playwright-cli requests` /
  `request <n>` to diagnose failed API calls (status codes, the `Authorization`
  header, CORS errors).
- **In-memory tokens (Requirement 10.6):** JWTs live only in memory. A full-page
  navigation (`goto`) or `reload` drops the session and returns you to the
  signed-out home page. After signing in, navigate **by clicking links**
  (`/config`, `/reports`, `/conversation`), not by `goto`/`reload`, or you will
  have to sign in again.
- The webapp sends the Cognito **id token** (not the access token) as the
  `Authorization: Bearer` credential, because the API Gateway Cognito authorizer
  validates id tokens. An access token returns 401, which the browser surfaces
  as a CORS error.

#### Option A — against the deployed site (simplest end-to-end)

The deployed CloudFront site already serves the correct `config.json` (injected
at deploy time by `WebappStack`) and the Data API already allows the CloudFront
origin, so **no config edits or CORS flag are needed**. This is the most
faithful end-to-end test.

```bash
# Resolve the deployed app URL (or use https://app.earthquake-agent.<parentDomain>)
aws cloudformation describe-stacks --stack-name WebappStack --no-cli-pager \
  --query "Stacks[0].Outputs[?OutputKey=='WebappCustomDomainUrl'].OutputValue" --output text
```

Then create a test user (next subsection) and drive the live URL with Playwright.

#### Option B — against the local dev server

`npm run dev` serves the SPA on `http://localhost:5173` and loads `/config.json`
at runtime. With the committed dev placeholders (`static/config.json`) the pages
render but auth-gated API calls fail. To make login + API calls work locally,
create a **gitignored** `packages/webapp/config.local.json` with real deployed
values (see below). The dev server serves it at `/config.json` in place of the
committed placeholder, so you never edit (and never have to revert) a committed
file, and real values can never be committed. The Data API already allows the
`http://localhost:5173` origin (CORS), and that URL is already a registered
Cognito callback, so no stack redeploy is needed.

```bash
npm run dev --workspace @mcp-events/webapp   # vite dev server on :5173 (leave running)
```

This `config.local.json` override is dev-only (a Vite middleware in
`vite.config.ts`, `apply: "serve"`); `vite build` and the deployed site are
unaffected (`WebappStack` injects deploy-time values).

#### Filling in `config.local.json` (Option B only)

Copy the committed example and fill in real values from stack outputs:

```bash
cp packages/webapp/config.local.example.json packages/webapp/config.local.json

# clientId + hosted UI domain (AuthStack)
aws cloudformation describe-stacks --stack-name AuthStack --no-cli-pager \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" --output text
aws cloudformation describe-stacks --stack-name AuthStack --no-cli-pager \
  --query "Stacks[0].Outputs[?OutputKey=='HostedUiDomain'].OutputValue" --output text
# API base URL (DataApiStack)
aws cloudformation describe-stacks --stack-name DataApiStack --no-cli-pager \
  --query "Stacks[0].Outputs[?OutputKey=='DataApiCustomDomainUrl'].OutputValue" --output text
```

`packages/webapp/config.local.json` (gitignored; the dev server serves it fresh
on each load, so no rebuild is needed):

```json
{
  "cognito": {
    "hostedUiDomain": "auth.earthquake-agent.<parentDomain>",
    "clientId": "<UserPoolClientId>",
    "scopes": ["openid", "email", "profile"]
  },
  "apiBaseUrl": "https://api.earthquake-agent.<parentDomain>"
}
```

#### Retrieving test user credentials

`AuthStack` deploys a persistent test user (`test-user@example.com`) whose
password is auto-generated and stored in Secrets Manager. A Custom Resource
syncs the password to Cognito at deploy time - no manual step is needed.

Retrieve the credentials on demand:

```bash
SECRET_NAME=$(aws cloudformation describe-stacks --stack-name AuthStack --no-cli-pager \
  --query "Stacks[0].Outputs[?OutputKey=='TestUserSecretName'].OutputValue" --output text)

aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --no-cli-pager \
  --query SecretString --output text | jq -r '.username, .password'
```

The secret JSON has the shape `{"username": "test-user@example.com", "password": "..."}`.
The user's `sub` (visible in the app as "Customer ID") is the `customerId` for
that user's data.

#### Logging in with Playwright

Click "Sign in" to redirect to the Cognito Hosted UI, fill the form, and submit.
The flow returns to the app authenticated (the redirect carries the auth code;
the SPA completes the PKCE exchange and stores tokens in memory).

```bash
playwright-cli open <APP_URL>/                 # deployed URL (Option A) or http://localhost:5173/
playwright-cli snapshot --raw                  # find the "Sign in" button ref
playwright-cli click <signin-ref>              # redirects to the Cognito Hosted UI
playwright-cli snapshot --raw                  # find the email + password textbox refs
playwright-cli fill <email-ref> test-user@example.com
playwright-cli fill <password-ref> '<password from secret>'
playwright-cli click <submit-ref>              # returns to the app, authenticated
playwright-cli snapshot --raw                  # confirms "Signed in as ..." + nav links
# navigate by CLICKING nav links (not goto/reload) to keep the in-memory session:
playwright-cli click <configure-monitoring-ref>
```

If an existing Cognito browser session is still valid, clicking "Sign in" can
silently redirect back without showing the form. If the session has expired, the
form reappears — fill it again.

#### Cleanup

When finished, stop the dev server (Option B), close the browser
(`playwright-cli close`), and remove any data the test user created. The test
user itself is persistent (managed by `AuthStack`) and should not be deleted.
The local `config.local.json` is gitignored, so it does not need reverting
(delete it if you like):

```bash
# if you saved a config, remove the row keyed by the user's sub:
aws dynamodb delete-item --table-name <CustomerConfigTableName> --no-cli-pager \
  --key '{"customerId":{"S":"<sub>"}}'
```

#### Quick render-only preview (no backend)

To just inspect how pages render (no login), run the dev server with the
committed placeholders and snapshot each route — auth-gated calls fail but the
layouts render:

```bash
npm run dev --workspace @mcp-events/webapp     # :5173
playwright-cli open http://localhost:5173/     # also /config, /reports, /conversation
playwright-cli snapshot --raw
playwright-cli close
```

CDK changes:

```bash
cd packages/cdk && npm run synth   # cdk synth all stacks (must succeed, no circular deps)
```

After deploying changes, **always run the integration tests** against the live
stack to validate end-to-end behavior (wire format compatibility, cross-service
contracts):

```bash
AWS_REGION=us-west-2 npx vitest run packages/integration-tests/src/e2e.test.ts
```

Unit tests alone do not catch protocol-level mismatches between services (e.g.
subscription ID format, request/response wire shapes) because each service's
unit tests mock its dependencies. The e2e tests exercise the real deployed
services talking to each other.

`packages/cdk/lib/subscription-ttl.test.ts` is a vitest test in the CDK package;
it runs as part of `npm test`.

### Conventions

- **ESM + NodeNext**: relative imports use a `.js` extension (e.g.
  `import { x } from "./foo.js"`) even though the source is `.ts`.
- **Cross-package imports** go through the package barrel
  (`@mcp-events/shared`, `@mcp-events/mcp-server-core`), never deep paths — so
  internal layout can be refactored freely.
- **Property tests** are `*.property.test.ts` (fast-check); example/edge tests
  are `*.test.ts`. Each correctness property in the design maps to a property
  test.
- **Test seams over mocking frameworks**: handlers expose `setXForTesting(...)`
  injection points (see `agent/src/config.ts`, `agent/src/router.ts`) and AWS
  SDK calls are mocked with `aws-sdk-client-mock`.
- `noUnusedLocals`/`noUnusedParameters` are on; prefix intentionally-unused
  identifiers with `_`.
- Do not edit generated artifacts: `**/dist`, `**/*.tsbuildinfo`,
  `packages/cdk/cdk.out`, `packages/webapp/.svelte-kit`.
- **Vendored MCP SDK**: `@modelcontextprotocol/server` and
  `@modelcontextprotocol/core` are installed from tarballs in `vendor/`,
  built from a [fork](https://github.com/clareliguori/mcp-typescript-sdk/tree/events-bufferemits-and-examples)
  that adds serverless support (`WebhookSubscriptionStore`, `serverless`
  mode, `flush()`). After updating the fork, regenerate tarballs with
  `pnpm pack` (see README Install section) and run `npm install`.

## AWS guidance

- Before starting a task, check whether a relevant AWS skill is available
  (`.kiro/skills/`, e.g. `aws-cdk`, `aws-serverless`, `aws-iam`,
  `aws-sdk-js-v3-usage`). Load the skill and prefer its guidance over general
  knowledge.
- When uncertain about specific AWS details (API parameters, permissions,
  limits, error codes), verify against documentation rather than guessing.
  State uncertainty explicitly if you cannot confirm.
- Prefer infrastructure-as-code (AWS CDK) over direct CLI commands. Do not use raw CloudFormation or SAM templates.
- Do not use em dashes in AWS resource names or descriptions. Use hyphens instead.
- Always use `--no-cli-pager` with the aws cli to get the full output.

## CDK cross-stack references

- Do not pass TypeScript construct references across stacks (no handing a construct, or a stack instance, from one stack's constructor to another). Sharing live constructs creates implicit, auto-generated CloudFormation exports and tight deploy-time coupling between stacks.
- Instead, share values across stacks with explicitly-named exports and imports: the producing stack publishes a `cdk.CfnOutput` with an explicit `exportName` (prefixed `EarthquakeAgent-`), and the consuming stack reads it with `cdk.Fn.importValue("<exportName>")`, rehydrating constructs as needed via `fromXxxArn` / `fromTableAttributes` / `fromUserPoolId`, etc.
- Because string-based `Fn.importValue` imports do not create deploy-time ordering, `bin/app.ts` declares each import relationship with `addDependency(...)` so `cdk deploy --all` creates exporters before importers. Keep that list in sync when you add a cross-stack import.
- For deterministic values (such as custom-domain URLs derived from the shared domain name), pass them as Lambda environment variables or recompute them from `SharedProps` rather than importing, to avoid synth-time stack ordering dependencies.
- Do not expose public construct properties on a stack class solely for another stack to read. Keep cross-stack contracts to the named CfnOutput/Fn.importValue surface.
- Cross-region exception: `Fn.importValue` cannot resolve across regions. When a stack must consume a resource from a stack in a different region (for example, a CloudFront or Cognito custom-domain certificate that must live in us-east-1 while the app deploys to another region), enable `crossRegionReferences: true` on both stacks and pass the resource as a construct reference via props. This is the only sanctioned case for passing a construct across stacks; same-region sharing must still use named exports/imports.

## CDK certificate regions

- ACM certificates are regional. CloudFront and Cognito custom-domain certificates MUST live in us-east-1; REGIONAL API Gateway custom-domain certificates must live in the API's own region.
- This app splits the DNS/TLS foundation into `DnsRegionalStack` (target region: subdomain hosted zone, NS delegation, and the regional wildcard certificate for the API Gateways) and `DnsUsEast1Stack` (pinned to us-east-1: the wildcard certificate for CloudFront and Cognito). `DnsUsEast1Stack` is pinned to us-east-1 explicitly in `bin/app.ts`, not via `CDK_DEFAULT_REGION`.
- Prefer one shared wildcard certificate per region over per-service certificates. ACM issues one deterministic DNS validation CNAME per FQDN, so multiple certificates for the same wildcard name share a single validation record; binding one certificate to multiple API Gateways is supported and the certificate ARN is stable across automatic renewals.

## Key implementation facts to respect

- **Webhook secret handling** (Requirement 17.9): the **Data API** Lambda is the
  only client-side encryptor/decryptor of its Subscriptions table secret — it
  returns/accepts the plaintext `whsec_` over IAM-authed HTTPS. The
  **Subscription Manager** and **Webhook Receiver** hold **no** KMS permissions
  and exchange plaintext with the Data API. The two MCP servers encrypt/decrypt
  their own table's secret directly with their own per-stack KMS key. No KMS key
  is exported or granted across stacks.
- **Backend vs webapp Data API routes**: backend (SigV4/IAM) callers use
  `/backend/...` routes; the bare `/customers/...` config/session/report read
  routes are Cognito-only. In API Gateway, explicit resources take routing
  precedence over the IAM `{proxy+}` fallback, so a SigV4 call to a Cognito path
  is rejected. When adding a backend read, add or reuse a `/backend/...` route.
- **Agent LLM**: Bedrock via the Strands SDK `BedrockModel`. Default model
  `us.anthropic.claude-haiku-4-5-20251001-v1:0`, overridable with the
  `BEDROCK_MODEL_ID` env var. Sessions persist via the SDK `SessionManager` +
  `S3Storage` (imported from `@strands-agents/sdk/session/s3-storage`) at
  `sessions/{customerId}/scopes/agent/agent/snapshots/...`.
- **Session writes are serialized** with `@deliveryhero/dynamodb-lock`
  (`agent/src/lock.ts`). Always go through `withLock(customerId, fn)`.

  Two lock settings are load-bearing and easy to break:

  1. **`trustLocalTime: true` + an explicit `waitDurationInMs`** are what make a
     contended waiter actually poll. The library only honours a caller-set wait
     interval on the `trustLocalTime` path; with both unset its contended path
     sleeps for the whole `leaseDurationInMs` before re-checking, so a waiter got
     one attempt and then slept past the acquisition timeout — every contended
     acquisition failed no matter how fast the holder released. That produced 109
     lock timeouts across 81 messages in one week, 7 of which exhausted
     `maxReceiveCount` and dead-lettered.
  2. **`LOCK_TTL_MS` must stay >= the agent Lambda's timeout** (300s). Because
     `prolongLeaseEnabled` is false the lease is fixed at acquisition and a live
     holder never refreshes it, so a shorter lease would expire mid-work and let a
     waiter steal the lock from a still-working holder — two concurrent writers to
     one session. `lock.test.ts` asserts this invariant; if you change the Lambda
     timeout, change the lease with it.

  Note these numbers diverge from Requirements 6.3/6.4, which specify a 60s lease
  and a 10s acquisition timeout. Both were unsafe in combination with the library's
  actual behaviour; the code is the source of truth.
- **The event queue is SQS FIFO, grouped by customer.** The Webhook Receiver
  enqueues every delivery with `MessageGroupId = customerId` (and
  `MessageDeduplicationId = eventId`), which is what actually serializes a
  customer's events; Lambda caps FIFO concurrency at the number of active
  message groups, so different customers still process in parallel. **Preserve
  this invariant** — anything that enqueues to this queue must group by
  `customerId`, and the receiver returns 401 rather than guessing a group when
  the Data API lookup yields no `customerId`.

  FIFO grouping and the lock are deliberately belt-and-suspenders: FIFO means the
  lock should never be contended in normal operation, and the lock still protects
  the cases FIFO does not cover (a redriven message racing a live one, a future
  non-queue caller).

  FIFO tradeoff to know: a failing message blocks its own message group until it
  succeeds or dead-letters, so one poison event delays that customer's later
  events for up to `maxReceiveCount` x `visibilityTimeout`.
- **Idempotency** is enforced via a bounded `processedEventIds` window in the
  session metadata (`agent/src/accumulate.ts`), not just `lastEventId`.
- **The accumulator can degenerate if briefings stop.** The conversation history
  *is* the accumulator, and it is only cleared when a briefing succeeds. If
  briefings stall, the conversation grows unbounded (bounded only by
  `SlidingWindowConversationManager`) and the model can fall into a
  self-reinforcing refusal loop — every new earthquake turn conditions on the
  previous refusal and repeats it, so `save_report` is never called and
  `processBriefingEvent` throws `did not produce a saved report` forever.
  `recovery.ts` does **not** catch this: it only classifies *structurally*
  unloadable snapshots (bad JSON, wrong `scope`/`schemaVersion`) as corrupt, and
  a degenerate conversation is structurally valid. Recovery is manual — archive
  the snapshot aside (the `recoverCorruptedSession` convention) and let the next
  event start fresh:

  ```bash
  B=<sessions bucket>; K=sessions/<customerId>/scopes/agent/agent/snapshots/snapshot_latest.json
  aws s3api copy-object --bucket "$B" --key "$K-degenerate-$(date -u +%Y-%m-%dT%H-%M-%S-000Z)" \
    --copy-source "$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$B/$K")" --no-cli-pager
  aws s3api delete-object --bucket "$B" --key "$K" --no-cli-pager
  ```

  The first briefing after a reset skips with `no-activity` (empty
  conversation); reports resume once events accumulate again. When diagnosing a
  briefing that delivers but produces no report, read the tail of
  `snapshot_latest.json` (`data.messages`) before anything else — the model's
  own replies show the degeneration directly.
- **Subscription records must not carry legacy-shaped fields forward.** A
  refresh re-derives `filterParams`/`schedule` from the customer's current
  config (`refresh.ts` `domainFieldsFor`) rather than copying them off the
  stored record. Copying them meant a record written under an older schema (a
  cron-string `schedule` from before the interval migration) failed Data API
  validation with a 400 on every refresh; since `upsertSubscriptionRecord` only
  falls back to POST-create on a **404**, the refresh wedged permanently and the
  Webhook Receiver 401'd every delivery for the id the MCP server was actually
  using. Schema changes to `webhookSubscriptionSchema` need a migration or a
  deliberate heal path for existing rows.

## Monitoring gotchas

- **The log-error metric filters match `WARN` as well as `ERROR`**
  (`addLogErrorAlarm` uses `FilterPattern.anyTerm("ERROR", "WARN")`), and each
  alarm fires at `Sum >= 1` over a single 5-minute period. So *any* single
  `console.warn` pages. Keep that in mind when adding a warn-level log on a
  routine path — and conversely, it is what lets `fetchUsgsFeed` log a WARN per
  retry and stay visible to the alarm even when the retry succeeds.
- **`earthquake-agent-system-health` is a composite `anyOf` over every child
  alarm.** One chronically-failing child pins it in ALARM indefinitely, and
  because it never returns to OK it never re-notifies — so a single persistent
  failure silently masks every other alarm in the system. During the three-month
  briefing outage `subscription-manager-log-errors` was recording **288
  errors/day** (one per 5-minute refresh) and `agent-log-errors` 15-37/day from
  lock timeouts. Detection and notification (SNS -> AWS Chatbot) were both
  working; the signal was simply drowned. When triaging, check the child alarms'
  metrics directly rather than trusting the composite's current state.
- `fetchUsgsFeed` retries transient failures ({@link FEED_RETRY_DELAYS_MS}) but
  has **no per-attempt timeout**. A hung connection therefore has nothing to
  abort it and will stall until the poller Lambda's 60s timeout instead of
  failing fast into a retry. Adding `AbortSignal.timeout(...)` is the remaining
  gap there.

## Where the code diverges from the spec

The spec (`.kiro/specs/.../{design,requirements,tasks}.md`) is out of date here;
trust the code:

- A `packages/mcp-server-core` package exists that the design's component list
  does not mention; both MCP servers are built on it.
- There are **ten** CDK stacks (DNS is split into `DnsRegionalStack` +
  `DnsUsEast1Stack`), not the eight in the design's stack table.
- Webhook secret decryption is done by the **Data API**, not by the Webhook
  Receiver / Subscription Manager as some design component text implies. The
  code follows Requirement 17.9.
- The webapp is fully implemented (Cognito PKCE auth, config/reports/conversation
  pages). It is intentionally excluded from root ESLint and the root TS project
  references because it has its own SvelteKit toolchain (svelte-check, vite, its
  own vitest config).

If you change behavior that the spec describes, update the code first, then note
the divergence (or update the spec if the task is spec-driven).

## Generating diagrams

Architecture diagrams in `diagrams/` are generated with the Python
[`diagrams`](https://diagrams.mingrammer.com/) library (Graphviz-based, uses
official AWS icons). The source is `generate-diagrams.py` at the repo root.

To regenerate after editing:

```bash
uv venv /tmp/diagrams-venv && source /tmp/diagrams-venv/bin/activate
uv pip install diagrams
python3 generate-diagrams.py
```

This writes PNGs directly to `diagrams/`. Commit the updated PNGs alongside
any changes to `generate-diagrams.py`. The README references the PNGs via
`<img>` tags with `width` attributes to control sizing.

### Keeping these docs current

- When you add functionality, refactor packages, or change the build/test/deploy
  workflow, update this `AGENTS.md` and `README.md` in the same change.
- "always do this", "make a note", "remember to" => update this `AGENTS.md`.
