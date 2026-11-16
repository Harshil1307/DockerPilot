# Hosted Docker access through a local agent

## Goal and implementation status

Let the hosted DockerPilot API manage the Docker Engine on a user's own computer without exposing a Docker socket or accepting inbound connections to that computer. The same design must support one agent for the current expo demo and separate agents for other users later.

The authenticated outbound relay, single-use pairing, revocation, reconnect loop, typed operation allowlist, and account ownership checks are implemented. The agent is still distributed as source and requires Node.js. The in-memory relay accepts only one live agent per account; selecting between multiple computers on one account is not implemented.

## Connection shape

```mermaid
flowchart LR
  Browser[Browser on Vercel] -->|Authenticated REST request| API[DockerPilot API on Render]
  API -->|Request ID + typed operation| Relay[Agent request broker]
  Agent[Local DockerPilot agent] -->|Outbound authenticated WSS| Relay
  Agent -->|Local Docker API / Compose CLI| Engine[Docker Engine on user's computer]
```

The browser continues to call the existing authenticated API. The local agent makes an outbound TLS WebSocket connection to the API, so it works behind NAT and does not require port forwarding, a public Docker socket, or a tunnel to the Docker API.

## Pairing and device identity

1. A signed-in user requests a pairing challenge from the API.
2. The API creates a cryptographically random, single-use challenge bound to that user, with a short expiry and strict attempt limits. Store only a hash of the challenge.
3. The local agent is given that challenge by the user and exchanges it over HTTPS for a device identity and random revocable credential. The challenge is consumed atomically.
4. The agent stores its credential in a private per-user file with restrictive file permissions. The API stores only a hash and the owning account ID.
5. The agent reconnects over WSS using its credential. Users can list and revoke devices from DockerPilot. Revocation closes any active connection.

Do not put the account's session cookie, JWT signing secret, Docker socket path, or Docker credentials in the agent credential or pairing flow. Pairing codes must not be accepted in URLs or logs.

## Request protocol

The API keeps authentication, project authorization, Compose validation, rate limits, and activity recording. It sends the connected agent a bounded request containing a unique request ID, expiry, and an operation from a closed allowlist. The agent returns a bounded JSON result or a safe error for that request ID.

The protocol must not carry shell text, arbitrary Docker API paths, or an unvalidated Compose file. Operations should express intent such as listing containers, inspecting a named resource, starting an owned container, pulling an image, collecting bounded logs, or applying a server-validated Compose deployment. The agent independently checks DockerPilot ownership labels before lifecycle changes or cleanup. Compose execution uses a generated configuration and fixed argument templates.

Set strict message-size, response-size, concurrency, and execution-time limits. Reject expired, duplicate, unknown, and malformed requests. Do not log credentials, raw Compose YAML, raw Docker errors, or secret values. A disconnected agent returns a clear unavailable response; it must never fall back to another user's Docker Engine.

## Persistence and account boundaries

Each agent is an account-owned device with created/last-seen/revoked timestamps and a hashed credential. Pairing challenges are single-use and expire. Multiple device records may exist for an account, but only one live socket may connect per account and requests have no device selector yet. In local backend mode, do not treat account records as isolation between multiple users sharing one Docker daemon.

## Remaining rollout work

- [x] Pairing schema/API, credential revocation, authenticated outbound relay, and agent command allowlist.
- [x] Route Docker operations through typed agent operations while preserving local mode.
- [x] Show agent connectivity and pairing instructions in the website.
- [ ] Build, sign, and publish no-runtime-required Windows and macOS installers.
- [ ] Add device selection and support multiple live agents per account.
- [ ] Move relay and rate-limit state to a shared store before scaling the API beyond one instance.
- [ ] Exercise the deployed Vercel-to-Render-to-local-Docker path on clean Windows and macOS machines, including account isolation and reconnection.
