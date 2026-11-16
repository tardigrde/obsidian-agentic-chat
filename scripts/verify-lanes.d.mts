export interface VerifyStep {
  label: string;
  command: string;
  args: string[];
  expectTests: boolean;
  explainE2eSandboxFailure?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
}
export const SMOKE_SPEC: string;
export const MOBILE_SPEC: string;
export const MOBILE_TWO_TAB_SPEC: string;
export const LANE_NAMES: string[];
export const RETIRED_LANES: Record<string, string>;
export const lanes: Record<string, (args: string[]) => VerifyStep[]>;
export function step(label: string, command: string, args: string[], options?: Partial<VerifyStep>): VerifyStep;
export function staticSteps(): VerifyStep[];
export function resolveSpec(value: string, dirs?: string[], cwd?: string): string;
export function resolveToolUseSuite(value: string | undefined, cwd?: string): string | undefined;
export function usage(): string;
