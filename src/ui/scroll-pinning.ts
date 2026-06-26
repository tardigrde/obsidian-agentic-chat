export interface ScrollMetrics {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

const DEFAULT_BOTTOM_THRESHOLD_PX = 32;

export function isPinnedToBottom(metrics: ScrollMetrics, thresholdPx = DEFAULT_BOTTOM_THRESHOLD_PX): boolean {
  if (metrics.scrollHeight <= metrics.clientHeight) return true;
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= thresholdPx;
}
