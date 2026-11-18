export class DockerUnavailableError extends Error {
  constructor() {
    super('DockerPilot cannot reach a local Docker Engine. Start Docker Desktop or Docker Engine and verify access from this computer.');
    this.name = 'DockerUnavailableError';
  }
}
