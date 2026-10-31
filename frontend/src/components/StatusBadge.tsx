interface StatusBadgeProps {
  connected: boolean | null;
}

export function StatusBadge({ connected }: StatusBadgeProps) {
  const label = connected === null ? 'Checking API' : connected ? 'API connected' : 'API unavailable';
  const tone = connected === null ? 'status-pending' : connected ? 'status-online' : 'status-offline';

  return (
    <span className={`status-badge ${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
