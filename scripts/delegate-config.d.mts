export type DelegateRule = { action: string; resource: string; effect: "allow" | "deny" | "ask" };
export function delegatePermissions(options: { mode: "work" | "review"; main: string; edit: string }): DelegateRule[];
export function wildcardMatch(pattern: string, value: string): boolean;
export function decide(rules: DelegateRule[], action: string, resource: string): "allow" | "deny" | "ask";
export function lastVerdictIsFail(bodies: string[]): boolean;
