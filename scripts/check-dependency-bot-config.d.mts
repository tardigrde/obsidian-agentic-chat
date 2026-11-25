export const DEPENDABOT_CONFIG: string;
export const RENOVATE_CONFIG: string;
export const REQUIRED_GROUPS: Array<{ groupName: string; packages: string[] }>;
export function checkDependencyBotConfig(input: {
  renovate: string | null;
  dependabot: boolean;
}): string[];
