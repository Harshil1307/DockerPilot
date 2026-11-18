# Local Docker connection and AI Brain

DockerPilot runs on the developer's computer. The Express API connects to that computer's Docker Engine using Dockerode. The browser uses authenticated REST endpoints and never receives a Docker socket or Docker credential.

## Pair This Computer

The dashboard can create a cryptographically random one-time code. The API stores only its hash, binds it to the signed-in account, expires it after five minutes, and consumes it atomically. The user runs the agent command from this checkout and enters the code at the terminal prompt. The code is not placed in the command or URL. Pairing returns a random revocable agent credential; only its hash is stored by the API, and the agent stores it in a private user file. The computer name and live connection state are shown in the dashboard. Disconnect revokes the credential and closes its active connection.

The local agent endpoint defaults to `http://localhost:4000/api`; set `DOCKERPILOT_AGENT_API_URL` in `backend/.env` only when the local API uses a different address. Set `DOCKER_CONNECTION_MODE=agent` to route Docker requests through the paired agent. The default `local` mode connects Dockerode directly from the API process. The command is `npm run agent:dev --workspace @dockerpilot/backend -- pair`.

## AI Brain data flow

`Docker Engine → local DockerPilot API → monitoring and rule-based analysis → authenticated Brain API → dashboard`

The dashboard samples DockerPilot account-owned container state, exit code, restart count, health check, CPU, memory, network counters, block I/O, recent Docker events, and configuration risks from Docker Engine. Event reads are bounded to 15 minutes and 100 owned-container events. Samples are stored per account in PostgreSQL for 30 days. Alerts are rule based. Smart Auto-Sleep is a separate review page; idle candidates require consecutive stored samples across the configured inactivity window. Thresholds are `AI_IDLE_CPU_THRESHOLD_PERCENT`, `AI_IDLE_IO_THRESHOLD_BYTES`, and `AI_IDLE_MINIMUM_MINUTES`. Databases and common infrastructure names are excluded. A user must confirm before an owned candidate is stopped; no container is stopped automatically.

Stack Doctor remains available on each project and inspects saved Compose configuration, owned deployment health, resource limits, and bounded recent logs. Log evidence is redacted best effort before presentation. Pattern based secret removal cannot guarantee arbitrary logs contain no secrets.

## Git Detective

Git history is read directly from the public GitHub URL saved in project settings. The paired agent does not inspect local Git folders.

Stack Doctor gathers Git findings as an optional report section after Docker checks. GitHub metadata is verified when connected; scan history uses an in-memory ten-minute per-project cache. The comparison ranks up to eight candidates using time proximity to a nonzero exit, `oom`, or unhealthy event, service/path matches, configuration or dependency files, and terms also present in diagnostics. If there is no matching event, scan time is only a weak recency signal. The score is a heuristic; it does not assert causation. The optional root-cause call uses the backend's configured OpenAI-compatible provider and receives redacted, bounded findings and diffs. `.env` and known credential/key files are never diffed. If GitHub or the optional provider is unavailable, Docker findings are still saved and returned.

Git Detective only reads public GitHub metadata, commit history, and bounded diffs from the URL saved in project settings. It never checks out branches or executes repository scripts.

## Contextual chat

Set `OPENAI_API_KEY` in `backend/.env` to enable the optional OpenAI compatible chat endpoint. `OPENAI_MODEL` defaults to `gpt-4o-mini`; `OPENAI_BASE_URL` defaults to `https://api.openai.com/v1`. The key stays on the backend. The chat receives a bounded container summary and current alerts, not environment values, labels, credentials, or raw logs. Chat is advisory: it cannot execute shell commands or Docker actions. If the provider is missing or unavailable, the API returns a clear error and the dashboard continues to show local rule based analysis.

## Boundaries

Authenticated APIs preserve account ownership. Agent requests use a typed allowlist; arbitrary shell text and Docker API paths are not accepted. Lifecycle controls still require DockerPilot ownership labels and user initiated actions. Local mode is intended for one trusted operator; user accounts do not isolate users sharing one Docker daemon.
