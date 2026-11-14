export class DockerUnavailableError extends Error {
  constructor() {
    super('DockerPilot’s API cannot reach a Docker Engine. On the hosted site, the API runs on Render and cannot access Docker installed on your computer. To manage your local Docker, run DockerPilot on the same computer as Docker, or add a secure local agent.');
    this.name = 'DockerUnavailableError';
  }
}
