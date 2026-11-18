# Local release readiness

DockerPilot is configured for local development on one trusted computer. The API, PostgreSQL, frontend, and Docker Engine should run locally. Pair This Computer creates a five-minute, single-use pairing code and a revocable agent credential.

## Current limits

- The relay and rate limiter are process memory; run one API process.
- Application accounts are not security boundaries for multiple users sharing one Docker daemon.
- The agent requires Node.js and a source checkout.
- Windows and Linux agent behavior has not been verified in this workspace.
- Chat requires an optional compatible LLM provider. Without provider configuration, the evidence-based diagnostics still work.
- Smart Auto-Sleep currently reports candidates only; it does not stop containers.

## Local verification

Follow [installation](installation.md), then run the backend tests, type checks, and production builds documented in the root README. Real Docker pairing and Engine checks require a running local Docker daemon and PostgreSQL migrations.
