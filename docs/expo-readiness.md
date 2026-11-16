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
- [ ] Hosted first-run onboarding: no complete onboarding wizard or developer setup separation exists in the UI.
- [ ] Production configuration and credentials: OAuth, persistent PostgreSQL/backups, domains, TLS, and deployment secrets require operator configuration.
- [ ] Two-user/two-daemon end-to-end test: requires two accounts and independently running Docker engines; not available in this local audit.
- [ ] Windows agent execution/install: not verified in this macOS workspace.
- [ ] Real OAuth provider flow: requires Google client credentials and a configured callback.

## Confirmed reliability adjustment

Registration now counts failed attempts rather than successful account creations. This keeps repeated successful registrations from exhausting the same IP budget on shared networks while retaining the five-failure limit. Login already used the same failed-attempt behavior. This is an in-process limiter and is not a substitute for shared storage on a multi-instance deployment.

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
