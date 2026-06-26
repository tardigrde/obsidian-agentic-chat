import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { E2EStreamOptions } from "./e2e-stream";

export type {
  E2EStreamOptions,
  E2EStreamTarget,
  E2EStreamTurn,
} from "./e2e-stream";

export function createWindowE2EStreamFn(_options: E2EStreamOptions): StreamFn | undefined {
  return undefined;
}
