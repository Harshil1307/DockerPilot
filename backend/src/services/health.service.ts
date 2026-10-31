export interface HealthStatus {
  status: 'ok';
  service: 'dockerpilot-api';
  timestamp: string;
}

export function getHealthStatus(): HealthStatus {
  return {
    status: 'ok',
    service: 'dockerpilot-api',
    timestamp: new Date().toISOString(),
  };
}
