# Render deployment guide

`render.yaml` describes a Render Static Site, a Node web service, and Render Postgres. Both services use the repository root because this npm workspaces repository needs the root `package.json` and lockfile. No credentials are committed: Render generates `JWT_SECRET`, supplies the database URL from the database resource, and prompts for the frontend/API URLs.

## Important limits

- This Blueprint uses Render's free plans to avoid silently requiring a paid resource. The free Postgres database is limited and expires after 30 days; it has no backups. Use it only to preview the deployment. Do not store data that must be retained there. Upgrade PostgreSQL before real use. Render's free web service can sleep and has limited availability. See [Render's free plan limits](https://render.com/docs/free).
- Render's pre-deploy command is unavailable on free web services. Therefore the API start command runs the idempotent `prisma migrate deploy` workflow before starting the API. This runs at each cold start, but applies only migrations not yet recorded as applied. If you later choose a paid API service, you can move the migration command to `preDeployCommand` and remove it from `startCommand`.
- Render's default `*.onrender.com` domains are on the [Public Suffix List](https://publicsuffix.org/list/public_suffix_list.dat). Since DockerPilot uses a credentialed `SameSite=Lax` session cookie, use two HTTPS sibling subdomains on a domain you control, for example `app.example.com` and `api.example.com`. Do not expect the cookie to work reliably between unrelated sites or the default Render domains. Add both domains to their corresponding Render services and configure their DNS as Render directs.
- A Render-hosted API has no connection to the Docker daemon on your Mac. Do not set `DOCKER_HOST` or `DOCKER_SOCKET_PATH`, and do not expose a Docker socket. The API and database can host account, project, saved Compose configuration, Compose validation, and activity data. Docker inventory and control features require a local Docker agent; no such agent is implemented yet.

## Create the Blueprint

1. Push the project to the Git provider connected to Render. The repository's default branch is `main`.
2. In Render, create a Blueprint from the repository and inspect the resource plan before applying it. The initial Blueprint sync creates a new empty Render database; this guide does not import or modify local database data.
3. When prompted for `FRONTEND_ORIGIN`, enter the exact HTTPS frontend origin, such as `https://app.example.com` (no trailing slash).
4. When prompted for `VITE_API_BASE_URL`, enter the HTTPS API base URL, such as `https://api.example.com/api`. Vite embeds this value at build time; changing it requires rebuilding the static site.
5. Confirm that Render has generated `JWT_SECRET`. Do not copy a local `.env` file into the hosted service.
6. Add the frontend and API custom domains and configure DNS. Keep them as sibling subdomains of the same registrable domain. The API's exact-origin CORS setting and the frontend build URL must match these domains.
7. Wait for the API health check and static build to pass. Confirm the health endpoint at `https://api.example.com/api/health/ready` returns HTTP 200. Then test account registration/login, project CRUD, Compose environment save/validation, and Activity History.
8. Treat Docker host status and Docker management pages as unavailable in the hosted app until a separately designed and security-reviewed local agent exists.

Blueprint creation starts the initial deployment even though subsequent automatic deploys are disabled with `autoDeployTrigger: off`. Review the free database lifetime and service plan on the Render confirmation screen before applying it. No Render resources are created by this repository change.

## Services and commands

### `dockerpilot-api` web service

- Root directory: unset (repository root).
- Build: `npm ci --include=dev && npm run db:generate --workspace @dockerpilot/backend && npm run build --workspace @dockerpilot/backend`
- Start: `npm run db:deploy --workspace @dockerpilot/backend && npm run start --workspace @dockerpilot/backend`
- Health check: `/api/health/ready`, which verifies PostgreSQL with a small query.
- `NODE_VERSION=22.22.0`, `NODE_ENV=production`, `TRUST_PROXY_HOPS=1`.
- `FRONTEND_ORIGIN`: exact HTTPS frontend origin (prompted, no committed value).
- `JWT_SECRET`: Render generated value.
- `DATABASE_URL`: private Render Postgres connection string reference.
- Render supplies `PORT`. The backend binds to `0.0.0.0` and that port.
- `DOCKER_SOCKET_PATH` and `DOCKER_HOST`: intentionally unset.

### `dockerpilot-frontend` Static Site

- Root directory: unset (repository root).
- Build: `npm ci --include=dev && npm run build --workspace @dockerpilot/frontend`
- Publish directory: `frontend/dist`.
- `VITE_API_BASE_URL`: exact HTTPS API base URL ending in `/api` (prompted, no committed value).
- SPA route rewrite sends browser routes to `/index.html`.

### `dockerpilot-db` PostgreSQL

- PostgreSQL 17 to match the version used by local development.
- Free plan explicitly selected for preview only.
- Internal connection only (`ipAllowList: []`); API and database share the Singapore region.
- The first API start applies the checked-in Prisma migrations via `prisma migrate deploy`; it never runs `migrate reset` or recreates the database.

## Authentication and CORS

The browser API client already sends `credentials: 'include'`. The backend permits only the configured `FRONTEND_ORIGIN`, requires HTTPS for that origin in production, and sets session cookies to Secure, HttpOnly, and SameSite=Lax. The sibling custom domains keep those cross-origin API requests same-site while allowing the existing cookie settings. The `TRUST_PROXY_HOPS=1` value enables Express to use the client address forwarded through Render's proxy for existing IP-based rate limits. The current limiter remains in-memory and the Blueprint intentionally keeps one API instance.

## How to get real Docker connectivity

Do not point the hosted backend at a Mac socket, publish Docker TCP, or tunnel the socket. A separate local agent is required for hosted users to control their own Docker installations. It must use an authenticated outbound connection, revocable pairing, typed and authorized operations, bounded data and logs, timeouts, and local resource ownership checks. The current hosted configuration does not implement or claim that functionality. Local development continues to use the existing backend-to-local-Docker connection.
