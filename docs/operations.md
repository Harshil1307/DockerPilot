# Local operations

## Run shape

Run the frontend, API, PostgreSQL, and Docker Engine on the developer's computer. Use one API process because the agent relay and rate limiter are in memory. Never expose the Docker socket or an unauthenticated Docker API. Pairing is optional for direct local mode; when used, choose **Pair This Computer**, run the shown local agent command, and enter the five-minute one-time code. Disconnect revokes the agent credential.

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `NODE_ENV` | No | Defaults to `development`. |
| `PORT` | No | API listen port; defaults to `4000`. |
| `FRONTEND_ORIGIN` | No | Exact local browser origin; defaults to `http://localhost:5173`. |
| `DATABASE_URL` | Yes | PostgreSQL URL for Prisma. Keep private; use a least-privilege application role and TLS for remote PostgreSQL. |
| `JWT_SECRET` | Yes | Unique random signing secret, at least 32 characters. Never use the example value. |
| `TRUST_PROXY_HOPS` | No | Keep `0` for the local application. |
| `DOCKER_SOCKET_PATH` | No | Backend-only local socket override. Never expose this socket over TCP/public interfaces. |
| `DOCKER_CONNECTION_MODE` | No | `local` uses Dockerode from the API; set `agent` to route Docker requests through the paired computer. |
| `DOCKERPILOT_AGENT_API_URL` | No | Defaults to `http://localhost:4000/api` for local pairing. |
| `OPENAI_API_KEY` | Optional | Backend-only key for contextual AI Brain chat. |
| `OPENAI_MODEL` | Optional | AI model name; defaults to `gpt-4o-mini`. |
| `OPENAI_BASE_URL` | Optional | OpenAI-compatible API base URL. |
| `AI_IDLE_CPU_THRESHOLD_PERCENT` | No | Idle candidate CPU threshold; defaults to `1`. |
| `AI_IDLE_IO_THRESHOLD_BYTES` | No | Maximum network and block I/O counter change per recorded sample; defaults to `1024`. |
| `AI_IDLE_MINIMUM_MINUTES` | No | Minimum span across low activity samples before suggesting idle; defaults to `15`. |
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

The current limiter is in-memory and appropriate only for a single API process. The application uses console logging with request method/path and generic safe errors.

## Dependency audit finding (2026-10-31)

The online `npm audit` reports three high-severity affected packages in one dependency chain: `prisma@6.19.3` → `@prisma/config@6.19.3` → `deepmerge-ts@7.1.5` (GHSA-ggr8-5vv4-36mx). The advisory describes stack exhaustion when merging recursive object graphs. npm offers a fix only by moving to Prisma 7, a major upgrade with generator, datasource configuration, and client-instantiation changes. This phase did not force that breaking upgrade or override Prisma's pinned transitive dependency. Treat the finding as a public-release blocker: upgrade `prisma` and `@prisma/client` together on an isolated branch, follow the official Prisma 7 migration guide, and rerun schema, migrations, backend tests, builds, and a restored-database verification before adopting it. [GitHub advisory](https://github.com/advisories/GHSA-ggr8-5vv4-36mx), [Prisma 7 upgrade guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7).
