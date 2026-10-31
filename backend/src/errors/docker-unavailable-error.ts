export class DockerUnavailableError extends Error {
  constructor() {
    super('Docker Engine is unavailable. Start Docker Desktop and check its local socket connection.');
    this.name = 'DockerUnavailableError';
  }
}
