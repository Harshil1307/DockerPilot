# Production operations

## Deployment shape

This release is for one operator on a private or self-hosted machine. Build the frontend as static files and serve them from an HTTPS reverse proxy. Proxy `/api` to the persistent Node API process on a private interface. Run the API on the same trusted host as its Docker daemon and PostgreSQL, or connect it to a private managed PostgreSQL instance. Do not deploy this API as a public multi-tenant Docker control plane.

No provider has been provisioned and no deployment configuration is connected to external credentials. A static host such as Vercel can serve the frontend, but it does not make a remote browser able to safely reach a user's local daemon. A general public API service that cannot access the user's daemon is not a Docker management backend. The current recommended deployment remains self-hosted; a hosted agent control plane is future work.

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `NODE_ENV` | Yes for deployment | Set to `production` for production cookie and origin checks. |
| `PORT` | No | API listen port; defaults to `4000`. |
| `FRONTEND_ORIGIN` | Yes | Exact browser origin, including scheme and port if applicable. Must use HTTPS in production. |
| `DATABASE_URL` | Yes | PostgreSQL URL for Prisma. Keep private; use a least-privilege application role and TLS for remote PostgreSQL. |
| `JWT_SECRET` | Yes | Unique random signing secret, at least 32 characters. Never use the example value. |
| `TRUST_PROXY_HOPS` | Only behind a proxy | Number of trusted proxy hops between the API and clients, from `0` to `5`. Keep `0` when directly addressed. Configure to the actual topology; do not blindly trust forwarded headers. |
| `DOCKER_SOCKET_PATH` | No | Backend-only local socket override. Never expose this socket over TCP/public interfaces. |
| `VITE_API_BASE_URL` | Build-time, optional | Defaults to same-origin `/api`. Use a same-origin reverse proxy in production. |
| `VITE_API_PROXY_TARGET` | Dev only | Vite development proxy target; defaults to `http://localhost:4000`. It is not included in production frontend output. |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Local Compose only | Development database initialization values in the root `.env`; replace example values outside a disposable local setup. |

The API validates `FRONTEND_ORIGIN`, requires HTTPS for the production origin, rejects recognizable placeholder JWT secrets in production, and sets session cookies `Secure`, `HttpOnly`, and `SameSite=Lax`. CORS permits only the configured origin and credentialed requests. Keep frontend and API on the same origin to avoid cross-site cookie restrictions.

## Database and migrations

The local Compose file uses PostgreSQL 17 and a named persistent volume. Production should use a supported PostgreSQL release (PostgreSQL 17 is the repository's configured baseline), private networking, persistent storage, and a least-privilege role. Set `DATABASE_URL` through protected runtime configuration. Do not place it in frontend variables.

For each release, review the migration SQL and make a verified backup first. Apply committed migrations with:

```bash
npm run db:deploy
```

This runs `prisma migrate deploy`; it does not reset or recreate the database. Run it as a controlled release step before starting application code that depends on the new schema. Confirm migration status with `npx prisma migrate status --schema backend/prisma/schema.prisma`.

Back up PostgreSQL on a schedule appropriate to the data and test restoring a backup to an isolated database. Store backups separately from the database host and restrict access. Preserve the PostgreSQL data volume during application upgrades. Keep the prior application build and a documented database recovery plan; migrations are not automatically rolled back by application rollback.

## Build and start

```bash
npm ci
npm run db:generate
npm run build
npm run db:deploy
npm prune --omit=dev
NODE_ENV=production npm run start --workspace @dockerpilot/backend
```

The API requires the production variables above at runtime. Serve `frontend/dist` as static content and configure the reverse proxy to serve the SPA entry for client routes while forwarding `/api/*` to the API. Keep the API private behind that proxy. The API handles `SIGINT` and `SIGTERM` by stopping new HTTP connections and disconnecting Prisma, with a bounded shutdown period.

Health endpoints:

- `GET /api/health`: process liveness; does not query dependencies.
- `GET /api/health/ready`: readiness; returns 503 if PostgreSQL cannot be queried.

The current limiter is in-memory and appropriate only for a single API instance. A horizontally scaled/public deployment requires shared rate-limit storage and a security review. The application currently uses console logging with request method/path and generic safe errors; it does not include a production log aggregation or alerting integration.

## Dependency audit finding (2026-10-31)

The online `npm audit` reports three high-severity affected packages in one dependency chain: `prisma@6.19.3` → `@prisma/config@6.19.3` → `deepmerge-ts@7.1.5` (GHSA-ggr8-5vv4-36mx). The advisory describes stack exhaustion when merging recursive object graphs. npm offers a fix only by moving to Prisma 7, a major upgrade with generator, datasource configuration, and client-instantiation changes. This phase did not force that breaking upgrade or override Prisma's pinned transitive dependency. Treat the finding as a public-release blocker: upgrade `prisma` and `@prisma/client` together on an isolated branch, follow the official Prisma 7 migration guide, and rerun schema, migrations, backend tests, builds, and a restored-database verification before adopting it. [GitHub advisory](https://github.com/advisories/GHSA-ggr8-5vv4-36mx), [Prisma 7 upgrade guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7).

## Hosting cost notes (checked 2026-10-31)

- **Self-hosted on existing hardware:** no new hosting charge; electricity, internet, backups, and maintenance are operator costs. This is the only current recommended configuration.
- **Vercel frontend:** the official pricing page currently lists Hobby at $0/month and Pro at $20/month; limits, taxes, eligibility, and prices may change. A frontend host alone does not provide Docker daemon access. [Vercel pricing](https://vercel.com/pricing)
- **Render backend:** the official page lists a free compute option with limitations and a small paid web service at $7/month. A sleeping/ephemeral/free backend is not appropriate for persistent Docker daemon control, and connecting it to each user's local daemon is not supported by the current architecture. [Render pricing](https://render.com/pricing)
- **Small VPS:** Hetzner's June 2024 announcement listed CX22 at €3.79/month, excluding VAT; this is a dated estimate, not a verified current quote. A VPS running DockerPilot and a Docker daemon manages only that VPS's Docker environment. [Hetzner announcement](https://www.hetzner.com/pressroom/new-cx-plans/)
- **Managed PostgreSQL, domain, backups, and bandwidth:** prices vary by provider and usage and are not included above. No account, service, domain, or payment method has been used.

## Public release checklist

Before public distribution, the owner must choose and add a license, complete a security review, decide how registrations are controlled, review the support/backup/update commitments, and verify the deployment in its actual target environment. Do not market this version as a shared public Docker management service. The local agent target needs a separate threat model, protocol review, implementation, and test suite.
