# Installation and first use

## Supported setup

The documented path is a single-operator local or private self-hosted installation with Node.js 20.19+ or 22.12+, npm 10+, PostgreSQL 17 (the version used by the development Compose file), Docker Engine, and Docker Compose v2. The current workspace has previously been used on macOS. Linux and Windows/WSL have not been verified in this repository; treat them as unverified. Docker Desktop on macOS supplies the Engine and Compose CLI.

## Local setup

1. Install Node.js, npm, Docker Desktop/Engine, and Docker Compose v2.
2. From the repository root, run `npm install`.
3. Copy `.env.example` to `.env` and `backend/.env.example` to `backend/.env`. These examples contain development-only values. Keep both files private.
4. Set a random local `JWT_SECRET` (for example, generate one with `openssl rand -base64 48`). Ensure `DATABASE_URL` matches the local PostgreSQL values in `.env`.
5. Start only the PostgreSQL service with `docker compose up -d postgres`.
6. Generate Prisma and apply local development migrations with `npm run db:generate` and `npm run db:migrate`.
7. Start the API and frontend with `npm run dev`.
8. Open `http://localhost:5173/register`, create the local operator account, and sign in.
9. The dashboard's Docker indicator verifies Engine reachability. Open Containers, Images, Volumes, Networks, or Docker Host to inspect resources. Register a project, add and validate a supported Compose environment, then deploy it. Use the project monitoring and logs panels to inspect only that registered deployment.
10. To disconnect, log out and stop DockerPilot. Stopping DockerPilot does not stop or delete Docker resources. Use a deployment's guarded cleanup action only when you intend to remove that deployment's registered containers and networks.

`npm run dev` starts the Vite frontend on port 5173 and the API on port 4000. The frontend proxies `/api` to the local API during development. `GET /api/health` is a liveness check; `GET /api/health/ready` also verifies database connectivity.

## Troubleshooting

- **API cannot connect to PostgreSQL:** check that the local `postgres` service is healthy and that `backend/.env` `DATABASE_URL` matches `.env`. Do not reset the database to repair connectivity.
- **Schema is behind:** run `npm run db:generate`, then the documented development migration command. For a deployed database use the deployment migration command in [operations](operations.md). Review migration SQL before applying it.
- **Docker is unavailable:** start Docker Desktop/Engine and verify that the same operating-system user running the API can access it. `DOCKER_SOCKET_PATH` is an optional backend-only override. Never publish a socket listener.
- **Compose is unavailable:** install Docker Compose v2 and ensure the `docker compose` CLI is available to the API process.
- **Login cookie is absent in production:** use HTTPS, an exact `FRONTEND_ORIGIN`, and same-origin proxying. Secure cookies are enabled automatically when `NODE_ENV=production`.
- **Port is already in use:** choose another API `PORT` or frontend Vite port and update the proxy target; do not stop or remove unrelated processes or containers without identifying them first.
