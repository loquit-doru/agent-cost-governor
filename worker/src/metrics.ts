type MetricsDataset = {
  writeDataPoint: (point: { indexes?: string[]; doubles?: number[]; blobs?: string[] }) => void;
};

export function writeMetric(
  env: { METRICS?: MetricsDataset } | undefined,
  point: { indexes?: string[]; doubles?: number[]; blobs?: string[] },
): void {
  const ds = env?.METRICS;
  if (!ds) return;

  try {
    ds.writeDataPoint(point);
  } catch {
    // Metrics must never break core flows.
  }
}
