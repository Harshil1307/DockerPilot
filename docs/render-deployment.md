# Render deployment guide

`render.yaml` describes a Render Static Site, a Node web service, and Render Postgres. Both services use the repository root because this npm workspaces repository needs the root `package.json` and lockfile. No credentials are committed: Render generates `JWT_SECRET`, supplies the database URL from the database resource, and prompts for the frontend/API URLs.

## Important limits

- This Blueprint uses Render's free plans to avoid silently requiring a paid resource. The free Postgres database is limited and expires after 30 days; it has no backups. Use it only to preview the deployment. Do not store data that must be retained there. Upgrade PostgreSQL before real use. Render's free web service can sleep and has limited availability. See [Render's free plan limits](https://render.com/docs/free).
- The Blueprint currently runs `prisma migrate deploy` in the API build command, then starts the built API. Review this sequence before changing service plans or build configuration; never use `migrate reset` for deployment.
- The frontend uses same-origin `/api` requests and both checked-in Vercel rewrite files proxy them to Render. This preserves the first-party session cookie; `VITE_API_BASE_URL` is not used in the production frontend build.
- A Render-hosted API cannot reach a Docker daemon on your laptop. The current Blueprint sets `DOCKER_CONNECTION_MODE=agent`; the paired local agent makes the authenticated outbound connection. Do not set `DOCKER_HOST` or `DOCKER_SOCKET_PATH` on Render and never expose a Docker socket.

## Create the Blueprint

1. Push the project to the Git provider connected to Render. The repository's default branch is `main`.
2. In Render, create a Blueprint from the repository and inspect the resource plan before applying it. The initial Blueprint sync creates a new empty Render database; this guide does not import or modify local database data.
3. When prompted for `FRONTEND_ORIGIN`, enter the exact HTTPS frontend origin, such as `https://app.example.com` (no trailing slash).
4. Confirm that Render has generated `JWT_SECRET`. Do not copy a local `.env` file into the hosted service.
5. Configure the exact HTTPS Vercel frontend origin in Render's `FRONTEND_ORIGIN`. Keep the production Vercel `/api` rewrite pointed to the Render API origin.
6. Wait for the API health check and static build to pass. Confirm `/api/health/ready` through the Vercel site returns HTTP 200. Then test account registration/login, project CRUD, Compose environment save/validation, and Activity History.
7. To test Docker controls, start Docker Desktop on the user computer, verify `docker version`, and pair/run the local agent. The current preview agent requires Git, Node.js 22, and a repository checkout; standalone installers are not yet published.

Blueprint creation starts the initial deployment. The checked-in Blueprint currently uses automatic deploys on commits and free preview resources. Review the free database lifetime and service plan on the Render confirmation screen before applying it. No Render resources are created by this repository change.

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
- Production frontend API base: same-origin `/api`, rewritten by Vercel to the Render API origin.
- SPA route rewrite sends browser routes to `/index.html`.

### `dockerpilot-db` PostgreSQL

- PostgreSQL 17 to match the version used by local development.
- Free plan explicitly selected for preview only.
- Internal connection only (`ipAllowList: []`); API and database share the Singapore region.
- The first API start applies the checked-in Prisma migrations via `prisma migrate deploy`; it never runs `migrate reset` or recreates the database.

## Authentication and CORS

The browser API client already sends `credentials: 'include'`. The backend permits only the configured `FRONTEND_ORIGIN`, requires HTTPS for that origin in production, and sets session cookies to Secure, HttpOnly, and SameSite=Lax. The sibling custom domains keep those cross-origin API requests same-site while allowing the existing cookie settings. The `TRUST_PROXY_HOPS=1` value enables Express to use the client address forwarded through Render's proxy for existing IP-based rate limits. The current limiter remains in-memory and the Blueprint intentionally keeps one API instance.

## Local Docker connectivity

Do not point the hosted backend at a Mac socket, publish Docker TCP, or tunnel the socket. Hosted Docker controls use the implemented authenticated outbound agent relay, revocable pairing, typed operations, bounded data, timeouts, and local resource ownership checks. Keep the relay on one API instance. Pairing still uses the source-based preview agent; signed Windows/macOS installers and multiple computers per account remain unfinished.
