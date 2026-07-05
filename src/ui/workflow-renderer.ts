export interface ActionRow {
  label: string;
  detail?: string;
  icon: string;
  onClick: () => void;
}

export interface WorkflowRenderer {
  clear(): void;
  info(title: string, entries: Array<[string, string]>): void;
  error(message: string): void;
  actionList(title: string, subtitle: string, items: ActionRow[]): void;
}
