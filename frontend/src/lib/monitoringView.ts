export type MonitoringPanelState = 'loading' | 'error' | 'empty' | 'ready';

export function monitoringPanelState(input: {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  itemCount: number;
}): MonitoringPanelState {
  if (!input.loaded && input.loading) return 'loading';
  if (!input.loaded && input.error) return 'error';
  if (!input.loaded) return 'loading';
  return input.itemCount === 0 ? 'empty' : 'ready';
}
