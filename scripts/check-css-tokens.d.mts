export const ALLOWLIST: string[];
export interface CssDeclaration {
  property: string;
  value: string;
  line: number;
  selector: string;
}
export function declarations(css: string): CssDeclaration[];
export function checkCssTokens(css: string, file?: string): string[];
