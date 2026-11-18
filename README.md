# DockerPilot
HI, I AM J GANESH SETTY

DockerPilot is a locally running Docker management application for registering projects and safely managing containers, Compose deployments, images, volumes, networks, host health, account activity, and AI assisted diagnostics.

## Main features

- Authenticated project and Compose environment management with public-repository import, safe demo fallback, automatic localhost ports, and a restricted YAML subset.
- Container inventory, search, state filtering, details, one-shot metrics, bounded logs, and ownership-checked lifecycle controls.
- Image, volume, and network inventories with inspection and guarded operations.
- Docker host overview with explicit unavailable and partial metric states.
- Per-account Activity History for supported project and Docker actions.
- AI Brain dashboard with live container metrics, evidence-based alerts, recommendations, and optional contextual chat.
- Smart Auto-Sleep review of sustained idle candidates with explicit confirmation and ownership-checked stop controls.
- Git Detective in Intelligence compares public GitHub commits with the latest Stack Doctor findings.

## Architecture overview

The React, TypeScript, and Vite frontend calls an Express API. The API uses Prisma with PostgreSQL for accounts, projects, Compose environments, deployment state, activity history, and AI Brain metric snapshots. Docker data is collected by the local API or its paired local agent; the browser never receives Docker socket access. Authentication uses signed HTTP-only session cookies.

## Requirements

- Node.js 22.12+ (Google Sign-In uses a Node 22 compatible Google auth client)
- npm 10+
- Docker with Docker Compose

## Setup

```bash
npm install
cp .env.example .env
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

The root `.env` supplies local PostgreSQL settings to Compose. The example credentials are for local development only. If you change them, update `DATABASE_URL` in `backend/.env` to match.
Generate a random JWT signing secret with `openssl rand -base64 48` and replace the `JWT_SECRET` placeholder in `backend/.env` before starting the API. Keep `.env` files out of version control.

## Run locally

Start PostgreSQL in one terminal:

```bash
docker compose up -d postgres
```

In another terminal, start both apps:

```bash
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:4000
- Health check: http://localhost:4000/api/health

The liveness endpoint does not require PostgreSQL; `/api/health/ready` checks database connectivity. Apply the checked-in database migrations with:

```bash
npm run db:generate
npm run db:migrate --workspace backend
```

Use `npm run db:deploy` to apply committed migrations without resetting the database. See [local installation](docs/installation.md), [local agent design](docs/local-agent-design.md), and [operations](docs/operations.md).

Create an account at `/register`, then sign in at `/login`. Sessions use an HTTP-only cookie; project routes require that session and only return or modify the signed-in user's projects. Project registration and management are available through `POST`, `GET`, `PATCH`, and `DELETE /api/projects` (single-project operations use `/api/projects/:id`). The dashboard reads project records from this API; the API uses Prisma to store them in PostgreSQL.

Google Sign-In is optional and leaves email/password authentication available. To enable it, create an OAuth 2.0 Client ID of type **Web application** in Google Cloud Console, configure the OAuth consent screen, and add the exact callback URL `http://localhost:4000/api/auth/google/callback` under **Authorized redirect URIs**. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_OAUTH_REDIRECT_URI` in `backend/.env`; the redirect URI must match exactly. Set all three variables or leave all three unset. The backend verifies Google's ID token, audience, nonce, state, PKCE exchange, and verified email before creating a session. Existing accounts with a matching verified email are linked to that Google identity. Never commit the client secret.

The dashboard reads local Engine status and container summaries from `GET /api/docker/status` and `GET /api/docker/containers`. AI Brain uses authenticated `GET /api/brain` to sample account-owned container health and resource metrics, stores per-account snapshots for 30 days, and exposes contextual chat at `POST /api/brain/chat`. Set `OPENAI_API_KEY` in `backend/.env` to enable chat; set optional `OPENAI_MODEL` and `OPENAI_BASE_URL` for a compatible API. Without a provider key, live diagnostics still work and chat clearly reports that it is not configured. The key stays in the backend and is never sent to the browser.

Stack Doctor scans saved Compose configuration, owned container health, resources, and bounded recent logs. Git Detective is a separate page under Intelligence; it reads metadata and recent commits from the public GitHub URL saved in project settings and compares them with the latest Stack Doctor findings. No token or local repository path is required. Candidate ranking is heuristic and does not prove a commit caused a failure. See [GitHub repository integration](docs/github-repository-integration.md).

DockerPilot supports one-time pairing via **Pair This Computer**. The code is single-use and expires after five minutes. The agent stores its revocable credential with private file permissions. For local pairing, `DOCKERPILOT_AGENT_API_URL` defaults to `http://localhost:4000/api`; set `DOCKER_CONNECTION_MODE=agent` to route Docker requests through that paired computer. The default `local` mode connects from the API process directly.

Container controls require the backend to find both `com.dockerpilot.managed=true` and `com.dockerpilot.owner-id=<authenticated user ID>` labels on the container. The owner ID is checked from Docker Engine metadata, never accepted from the browser. Existing unlabelled containers and DockerPilot infrastructure containers remain read-only. Only a trusted backend workflow should apply ownership labels; the current UI does not register existing containers.

Open a project to manage its Compose environments. A new environment imports compatible prebuilt image services from the root Compose file in the connected public GitHub repository. Configurations requiring builds, environment values, databases, volumes, or other unsupported fields fall back to a `traefik/whoami` request-inspection demo rather than leaving an unstartable stack. The demo publishes container port 80 on an automatically assigned localhost port. The validator accepts only `services` with `image`, loopback-only `ports` (`127.0.0.1:HOST:CONTAINER` or `127.0.0.1::CONTAINER`), supported `restart` policies, and list-form `depends_on`. It rejects builds, volumes, host namespaces, privileged mode, device access, capability/security overrides, and credential-bearing fields. Keep credentials out of Compose YAML; this milestone does not provide a secret store. Validation alone only checks the saved configuration.

After validation succeeds, use **Deploy** on the environment card and confirm. DockerPilot revalidates the saved YAML, generates a fresh Compose file containing only the supported fields, and invokes the local Docker Compose CLI from a private temporary directory. It never executes the original YAML. Published services bind to loopback on an automatically assigned free host port; after deploy, DockerPilot shows the URL to open or the exact port mapping. Each environment uses a deterministic, isolated Compose project name and receives backend-generated `com.dockerpilot.managed`, `com.dockerpilot.owner-id`, `com.dockerpilot.project-id`, and `com.dockerpilot.environment-id` labels. Services have default CPU and memory limits. Docker Compose must be installed and available to the backend process; deployments are reported as failed with a diagnostic if the CLI or Docker Engine is unavailable. Deployment status and safe error summaries are available from `GET /api/compose/:environmentId/deployment`; deployments use `POST /api/compose/:environmentId/deploy`.

Deployment lifecycle controls are available through authenticated `POST /api/compose/:environmentId/deployment/start`, `/stop`, and `/restart` routes. They operate on the deployment's registered container IDs and reuse the ownership verifier. Cleanup uses `DELETE /api/compose/:environmentId/deployment`; it removes only verified registered containers and networks, never images or volumes, and supports retry after partial failure.

Deployment monitoring is available through `GET /api/compose/:environmentId/monitoring`. It returns registered service/container details and one-shot CPU and memory snapshots. A deployment may contain at most 20 containers for statistics collection; unsupported metrics are returned as unavailable. Container and Compose logs accept an optional `tail` query value of `50`, `100`, `250`, or `500`; output remains capped at 64 KB. Common credential formats are redacted on a best-effort basis. Pattern-based redaction cannot guarantee that arbitrary application output is free of secrets. Do not write credentials or secret values to application logs.

The authenticated Activity History page reads `GET /api/activity`. Optional `actionType`, `resourceType`, and `page` filters are supported. Activity is private to the signed-in account, records safe action summaries and outcomes, and does not store Compose YAML, environment values, or raw Docker error payloads. Account creation, Docker changes, Compose operations, and monitoring/log requests have modest in-memory rate limits; multi-process production deployments should use a shared rate-limit store.

The additive activity-history schema is in `backend/prisma/migrations/20261031190000_add_activity_history/`. Apply it with the documented Prisma migration workflow after PostgreSQL is available. Migration SQL is versioned with the project; do not reset a database to install updates.

The Compose schema is added by the migration in `backend/prisma/migrations/20261031110138_add_compose_environments/`, and deployment tracking by `backend/prisma/migrations/20261031111252_add_compose_deployment_tracking/`. For a fresh local setup, generate the client and apply migrations with `npm run db:generate` and `npm run db:migrate`.

## Testing and builds

Run the main verification commands from the project root:

```bash
npm test --workspace @dockerpilot/backend
npm run typecheck
npm run build
npm audit
```

Run frontend helper tests from `frontend/` and the mocked browser suite from the project root:

```bash
node --import tsx --test tests/*.test.ts
npm run test:e2e --workspace @dockerpilot/frontend
```

Validate the Prisma schema and check applied migrations from `backend/`:

```bash
npx prisma validate --schema prisma/schema.prisma
npx prisma migrate status --schema prisma/schema.prisma
npm run db:generate
npm run db:migrate
```

For a deployment environment, review each checked-in migration and use `npx prisma migrate deploy --schema prisma/schema.prisma` to apply committed migrations. Do not use `migrate reset` or `db push` as a deployment workflow.

The real Docker lifecycle test is opt-in:

```bash
npm run test:docker --workspace @dockerpilot/backend
```

It requires PostgreSQL with migrations applied, a reachable Docker daemon, and the `nginx:alpine` image. It creates a uniquely named Compose project and is not part of the default test suite.

## Local operation notes

- The agent relay and rate limiter are in memory; keep one local API process.
- Never expose the Docker socket or an unauthenticated Docker API. Keep one API process while its relay and rate limiter remain in memory. Review [local architecture](docs/production-architecture.md) and [local readiness](docs/expo-readiness.md).
- The API has a database readiness endpoint and bounded graceful shutdown. Configure a strong local `JWT_SECRET` and keep `.env` files private.
- The online dependency audit reports three high-severity affected packages in the same Prisma 6 dependency chain (`deepmerge-ts`, `@prisma/config`, and `prisma`). A safe fix requires a tested Prisma 7 upgrade; this remains a public-release blocker and is documented in [operations](docs/operations.md).
- Use controlled `npm run db:deploy` migrations and keep local database backups if you need to preserve data.
- The repository has no `LICENSE` file. The owner must choose a license before public open-source distribution.

Environment variables are configured by name in the example files. Keep actual credentials in private local `.env` files and never commit them.

## Project layout

- `frontend/` — React, TypeScript, Vite, and React Router application.
- `backend/` — Express API, authentication, Docker services, and Prisma client.
- `backend/prisma/` — Prisma schema and versioned database migrations.
- `docker-compose.yml` — local PostgreSQL development service and persistent volume.

Docker operations run only through authenticated backend APIs. Container lifecycle controls and Compose cleanup verify ownership; image, volume, and network operations retain their explicit protection and reference checks. Do not use global prune commands to troubleshoot this project.
