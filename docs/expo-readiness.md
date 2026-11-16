# Expo readiness audit

Audit date: 2026-11-16

## Findings checklist

- [x] Frontend: React 19, TypeScript, Vite, React Router; browser API requests include session credentials.
- [x] Backend: Express 5, Zod request schemas, Prisma 6, PostgreSQL, HTTP-only cookie sessions, optional Google OAuth.
- [x] Docker: Dockerode and constrained Compose generation. The hosted control plane uses an authenticated outbound WSS local-agent relay when `DOCKER_CONNECTION_MODE=agent`.
- [x] Pairing: single-use random code, five-minute expiry, stored code hash, hashed revocable agent credential, account ownership, and request operation validation.
- [x] Deployment identity: Compose names derive from the unique environment UUID; ownership is checked against account, project, environment, and Docker labels. Project names are account-scoped in PostgreSQL and can repeat across accounts.
- [x] Database connections: one module-level Prisma client is reused by the API process; readiness checks query PostgreSQL.
- [x] Hosting: Render Blueprint provisions API/PostgreSQL; Vercel configuration serves the frontend and API route. Render free service/database constraints make this preview-only.
- [x] CI: GitHub Actions checks Node 22/24, Prisma schema, types, unit tests, browser tests, and builds. Delivery workflow scopes package write permission to the image-publishing job.
- [x] Authentication controls: password hashing, session cookies, Google OAuth state/nonce/PKCE, origin checks, CORS allowlist, and route-level rate limiting are present in the implementation.
- [ ] Distributed rate-limit storage: current counters are process-local; keep one API instance or configure a shared store before scaling.
- [ ] Device selection and multiple computers per account: relay currently accepts only one connected agent per account, and Docker operations route to that single connection.
- [ ] User-ready installers: no Windows or macOS installer artifacts or release publishing workflow exist. The current agent requires Node.js and a repository checkout.
- [x] Hosted connection steps now guide users through Docker Desktop, `docker version`, agent preview setup, pairing, and developer-only PostgreSQL setup.
- [ ] No-clone hosted use: standalone signed Windows/macOS agent installers are still not published; the preview path requires Git, Node.js, and a source checkout.
- [ ] Production configuration and credentials: OAuth, persistent PostgreSQL/backups, domains, TLS, and deployment secrets require operator configuration.
- [ ] Two-user/two-daemon end-to-end test: requires two accounts and independently running Docker engines; not available in this local audit.
- [ ] Windows agent execution/install: not verified in this macOS workspace.
- [ ] Real OAuth provider flow: requires Google client credentials and a configured callback.

## Confirmed reliability adjustment

Registration now counts failed attempts rather than successful account creations. This keeps repeated successful registrations from exhausting the same IP budget on shared networks while retaining the five-failure limit. Login already used the same failed-attempt behavior. This is an in-process limiter and is not a substitute for shared storage on a multi-instance deployment.

Unhandled backend failures now log only the error class and a validated Render `CF-Ray` request ID, never the raw exception message. Common Prisma connection/authentication failures return a safe database-unavailable response and a stable error code. Frontend requests now show retry guidance for rate-limit and transient server responses. This improves diagnosis and user recovery; it does not establish the root cause of any past account-creation error. Render logs for the failing request are required to prove that.

## Hosting assessment (2026-11-16)

The error may be caused by application/database behavior, the free instance waking from idle, inbound rate limiting, database connection limits, or a platform event. No Render request logs or failing request identifiers were available in this audit, so it would be incorrect to claim a confirmed Render root cause.

Render's official free-service documentation says a free web service sleeps after 15 minutes without inbound traffic and takes about a minute to spin back up. Its free PostgreSQL expires after 30 days, is limited to 1 GB, has no backups, and lacks managed connection pooling. Render also documents that inbound request rate limiting can affect free services and that a 500 may come from application exceptions, unstable PostgreSQL connections, or exhausted resources. Its REST API rate limits apply to management API requests, not ordinary DockerPilot website requests. See [free instance limits](https://render.com/docs/free), [Render 429/500 troubleshooting](https://render.com/docs/troubleshooting-deploys), and [Render REST API rate limits](https://api-docs.render.com/reference/rate-limiting).

| Option | Fit for this project | Decision |
| --- | --- | --- |
| Render paid web service + persistent paid PostgreSQL | Keeps the existing Blueprint, WebSocket relay, region, and migration workflow. Removes free-tier sleep/expiry limits, subject to actual plan selection and budget. | **Recommended for the expo.** Inspect Render logs for the registration failure, move off free resources, and keep one API instance until relay/rate-limit state is shared. No provider migration needed. |
| Railway Hobby | Official pricing currently shows a $5/month minimum with $5 included usage; deploys Node/PostgreSQL and can support a small demonstration. Service and volume configuration would need porting and redeployment. | Viable alternative if Render's paid service remains unreliable; migration adds risk and there is no evidence yet that it is necessary. See [Railway pricing](https://railway.com/pricing). |
| Fly.io | Flexible Machines are usage-priced, but its official Managed Postgres currently starts at $38/month before storage. More infrastructure setup and operational work than this expo needs. | Not the student-budget default. See [Fly Machines pricing](https://fly.io/pricing-update/) and [Managed Postgres pricing](https://fly.io/docs/mpg/). |
| Vercel Functions for the backend | Existing Vercel frontend is static and works well there. A function-based API would require redesigning the persistent WebSocket agent relay and replacing in-memory routing/rate limits with shared services. | Not a drop-in replacement for the current Express backend. Vercel documents a 120-second proxy timeout and plan-specific function limits; see [Vercel limits](https://vercel.com/docs/limits). |

Do not migrate providers based only on a generic `Internal Server Error`. First correlate the failed signup's time and `CF-Ray` value with Render logs, confirm HTTP status and Prisma error code, and inspect API/database resource and connection metrics. For a live expo, the existing Render architecture is the lowest-change path if its paid always-on API and persistent database fit the budget.

## Expo checklist

- [ ] Backend liveness and PostgreSQL readiness return healthy from the deployed origin.
- [ ] Persistent database, backup, and restore have been verified.
- [ ] Register, login, logout, refresh, and session restoration work on the demonstration domain.
- [ ] Google OAuth works if it will be shown; otherwise keep password login available.
- [ ] Docker Desktop is running on the paired computer and `docker version` reports both Client and Server.
- [ ] The local agent is paired to the intended account and shows connected.
- [ ] Container inventory and guarded start/stop/restart work on demo containers.
- [ ] Compose validation and deployment use a harmless demo stack and have a cleanup plan.
- [ ] Disconnecting Docker Desktop and restoring it produces unavailable and recovered states.
- [ ] Agent reconnect has been exercised after a temporary network interruption.
- [ ] CI is green for the exact commit being demonstrated.
- [ ] No public Docker socket, credentials, `.env` file, or Google secret is exposed.
- [ ] Installer distribution and Windows setup are not represented as ready until signed artifacts and release links exist.

## Remaining release blockers

The current pairing UI instructs users to launch the source-based `agent:dev` command. This is suitable only for a developer preview and fails the ordinary hosted-user requirement. Do not claim that the site is ready as a public hosted SaaS or that Windows/macOS installers are available until packaged, signed agents are published and pairing is tested using those artifacts. The relay is in-memory and single-agent-per-account, so the current deployment must remain a single API instance and cannot satisfy multiple computers on one account.
