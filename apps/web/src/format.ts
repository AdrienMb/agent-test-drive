export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export const formatNumber = (n: number | undefined) => (n === undefined ? "—" : n.toLocaleString());

export const formatCost = (usd: number | undefined) => (usd === undefined ? "—" : `$${usd.toFixed(4)}`);

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
