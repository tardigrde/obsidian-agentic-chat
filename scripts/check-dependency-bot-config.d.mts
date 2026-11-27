export const DEPENDABOT_CONFIGS: string[];
export const RENOVATE_CONFIG: string;
export const REQUIRED_GROUPS: Array<{ groupName: string; packages: string[] }>;
export function checkDependencyBotConfig(input: {
  renovate: string | null;
  dependabotPaths?: string[];
}): string[];
