export function formatDockerBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const amount = bytes / (1024 ** index);
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[index]}`;
}

export function dockerStoragePercent(bytes: number | null, total: number | null): number | null {
  if (bytes === null || total === null || total <= 0 || bytes < 0) return null;
  return Math.min(100, Math.max(0, (bytes / total) * 100));
}
