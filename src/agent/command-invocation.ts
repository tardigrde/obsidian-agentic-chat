import type { AgentCommandResources } from "./command-dispatcher";
import {
  type AgentCommandPlan,
  resolveAgentCommand,
  resolveInitCommand,
  resolveInstructionCommand,
  resolveSkillCommand,
} from "./command-dispatcher";

export interface AgentCommandInvocationOptions {
  getResources: () => AgentCommandResources;
  runPrompt: (prompt: string) => Promise<void>;
  setError: (message: string) => void;
}

export class AgentCommandInvocationRuntime {
  constructor(private readonly options: AgentCommandInvocationOptions) {}

  invokeSkill(name: string, args?: string): Promise<void> {
    return this.runPlan(resolveSkillCommand(this.options.getResources(), name, args));
  }

  invokeAgent(name: string, task: string): Promise<void> {
    return this.runPlan(resolveAgentCommand(this.options.getResources(), name, task));
  }

  invokeInit(instructions?: string): Promise<void> {
    return this.runPlan(resolveInitCommand(instructions));
  }

  invokeInstruction(instruction: string): Promise<void> {
    return this.runPlan(resolveInstructionCommand(instruction));
  }

  private async runPlan(plan: AgentCommandPlan): Promise<void> {
    if (plan.type === "error") {
      this.options.setError(plan.message);
      return;
    }
    await this.options.runPrompt(plan.prompt);
  }
}
