import type { ComposeDeploymentStatus } from './api';

export type ComposeLifecycleAction = 'start' | 'stop' | 'restart' | 'cleanup' | 'refresh';

export function deploymentStatusLabel(status: ComposeDeploymentStatus): string {
  return ({
    NOT_DEPLOYED: 'Not deployed',
    DEPLOYING: 'Working',
    RUNNING: 'Running',
    FAILED: 'Failed',
    STOPPED: 'Stopped',
    CLEANING: 'Cleaning',
    CLEANUP_FAILED: 'Cleanup failed',
    REMOVED: 'Removed',
  })[status];
}

export function availableComposeActions(status: ComposeDeploymentStatus, hasRegisteredResources: boolean): ComposeLifecycleAction[] {
  return [
    ...(status === 'STOPPED' ? ['start' as const] : []),
    ...(status === 'RUNNING' ? ['stop' as const, 'restart' as const] : []),
    'refresh',
    ...(hasRegisteredResources && status !== 'CLEANING' ? ['cleanup' as const] : []),
  ];
}
