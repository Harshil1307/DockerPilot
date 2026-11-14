import { stringify as stringifyYaml } from 'yaml';
import type { ApprovedComposeConfiguration } from './compose-validation.service.js';
import type { ComposeDeploymentIdentity } from './docker.service.js';

export function generatedComposeConfiguration(
  configuration: ApprovedComposeConfiguration,
  identity: ComposeDeploymentIdentity,
): string {
  const labels = {
    'com.dockerpilot.managed': 'true',
    'com.dockerpilot.owner-id': identity.ownerId,
    'com.dockerpilot.project-id': identity.projectId,
    'com.dockerpilot.environment-id': identity.environmentId,
  };
  const services: Record<string, Record<string, unknown>> = {};

  for (const [serviceName, approved] of Object.entries(configuration.services)) {
    services[serviceName] = {
      image: approved.image,
      ...(approved.ports ? { ports: approved.ports } : {}),
      ...(approved.restart ? { restart: approved.restart } : {}),
      ...(approved.depends_on ? { depends_on: approved.depends_on } : {}),
      labels: { ...labels },
      deploy: { resources: { limits: { cpus: '0.50', memory: '512M' } } },
    };
  }

  return stringifyYaml({
    services,
    networks: { default: { labels: { ...labels } } },
  }, { lineWidth: 0 });
}
