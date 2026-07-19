export const AGENTIC_EVAL_SUITE_VERSION = 1;

export type EvalSeverity = "error" | "warning";
export type EvalCaseStatus = "pass" | "problem" | "skipped";

export interface EvalSuite {
  version: typeof AGENTIC_EVAL_SUITE_VERSION;
  name: string;
  description?: string;
  cases: AgenticEvalCase[];
}

export type AgenticEvalCase = StaticContextEvalCase | ScriptedDogfoodEvalCase | LlmJudgeEvalCase;

export interface StaticContextEvalCase {
  id: string;
  type: "static-context";
  prompt?: string;
  systemPrompt?: string;
  toolSurface?: "default" | "compat";
  contextWindow?: number;
  externalWorkspace?: StaticExternalWorkspaceConfig;
  assertions: EvalAssertion[];
}

export interface StaticExternalWorkspaceConfig {
  enabled?: boolean;
  rootPath?: string;
}

export interface ScriptedDogfoodEvalCase {
  id: string;
  type: "scripted-dogfood";
  dogfood?: {
    spec?: string;
    timeoutMs?: number;
    turnTimeoutMs?: number;
  };
  assertions: EvalAssertion[];
}

export interface LlmJudgeEvalCase {
  id: string;
  type: "llm-judge";
  dogfoodRunId?: string;
  minOverallScore?: number;
  minDimensionScore?: number;
}

export type EvalAssertion =
  | ContextContainsAssertion
  | ContextNotContainsAssertion
  | ToolRegisteredAssertion
  | ToolNotRegisteredAssertion
  | ToolDescriptionContainsAssertion
  | MaxToolSchemaTokensAssertion
  | MaxContextCharsAssertion
  | PromptMentionsOnlyRegisteredToolsAssertion
  | DogfoodInvariantsPassAssertion
  | RequiredToolStartedAssertion
  | MaxRepeatedExternalPathActionAssertion
  | MaxDuplicateToolStartsAssertion
  | MaxUserMessageCharsAssertion
  | MaxToolErrorsAssertion;

interface EvalAssertionBase {
  type: string;
  severity?: EvalSeverity;
  area?: string;
  message?: string;
}

export interface ContextContainsAssertion extends EvalAssertionBase {
  type: "context_contains";
  text: string;
}

export interface ContextNotContainsAssertion extends EvalAssertionBase {
  type: "context_not_contains";
  text: string;
}

export interface ToolRegisteredAssertion extends EvalAssertionBase {
  type: "tool_registered";
  name: string;
}

export interface ToolNotRegisteredAssertion extends EvalAssertionBase {
  type: "tool_not_registered";
  name: string;
}

export interface ToolDescriptionContainsAssertion extends EvalAssertionBase {
  type: "tool_description_contains";
  name: string;
  text: string;
}

export interface MaxToolSchemaTokensAssertion extends EvalAssertionBase {
  type: "max_tool_schema_tokens";
  max: number;
}

export interface MaxContextCharsAssertion extends EvalAssertionBase {
  type: "max_context_chars";
  max: number;
}

export interface PromptMentionsOnlyRegisteredToolsAssertion extends EvalAssertionBase {
  type: "prompt_mentions_only_registered_tools";
  names?: string[];
}

export interface DogfoodInvariantsPassAssertion extends EvalAssertionBase {
  type: "dogfood_invariants_pass";
}

export interface RequiredToolStartedAssertion extends EvalAssertionBase {
  type: "required_tool_started";
  name: string;
}

export interface MaxRepeatedExternalPathActionAssertion extends EvalAssertionBase {
  type: "max_repeated_external_path_action";
  max: number;
  key?: string;
  allowedKeys?: string[];
}

export interface MaxDuplicateToolStartsAssertion extends EvalAssertionBase {
  type: "max_duplicate_tool_starts";
  max: number;
  key?: string;
  allowedKeys?: string[];
}

export interface MaxUserMessageCharsAssertion extends EvalAssertionBase {
  type: "max_user_message_chars";
  max: number;
}

export interface MaxToolErrorsAssertion extends EvalAssertionBase {
  type: "max_tool_errors";
  max: number;
  name?: string;
  allowedByTool?: Record<string, number>;
}

export interface EvalFinding {
  severity: EvalSeverity;
  caseId: string;
  area: string;
  message: string;
  details?: unknown;
}

export interface EvalCaseResult {
  id: string;
  type: AgenticEvalCase["type"];
  status: EvalCaseStatus;
  findings: EvalFinding[];
  metrics?: Record<string, unknown>;
  artifacts?: Record<string, string>;
  skippedReason?: string;
}

export interface StaticContextSnapshot {
  systemPrompt: string;
  userPrompt: string;
  contextChars: number;
  toolSchemaTokens: number;
  knownToolNames: string[];
  tools: Array<{
    name: string;
    label?: string;
    description?: string;
    parameters?: unknown;
  }>;
}

export interface DogfoodInvariantSnapshot {
  ok: boolean;
  findings: Array<{ severity: EvalSeverity; area: string; message: string }>;
  metrics: {
    maxUserMessageChars?: number;
    toolStarts?: Record<string, number>;
    toolErrors?: Record<string, number>;
  };
}

export interface SessionTraceRepeatedItem {
  key: string;
  count: number;
}

export interface SessionTraceFileSummary {
  file?: string;
  maxUserMessageChars?: number;
  duplicateToolStarts?: SessionTraceRepeatedItem[];
  repeatedExternalPathActions?: SessionTraceRepeatedItem[];
}

export interface SessionTraceAggregate {
  maxUserMessageChars?: number;
  maxAssistantInput?: number;
  cacheHits?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
  };
  toolStartsByTool?: Record<string, number>;
  toolErrorsByTool?: Record<string, number>;
}

export interface SessionTraceSnapshot {
  files?: SessionTraceFileSummary[];
  aggregate?: SessionTraceAggregate;
}

export interface ScriptedDogfoodSnapshot {
  dogfoodRunId?: string;
  runDir?: string;
  e2eExitCode?: number;
  setupErrors?: string[];
  invariant?: DogfoodInvariantSnapshot;
  trace?: SessionTraceSnapshot;
}

const ASSERTION_TYPES = new Set<EvalAssertion["type"]>([
  "context_contains",
  "context_not_contains",
  "tool_registered",
  "tool_not_registered",
  "tool_description_contains",
  "max_tool_schema_tokens",
  "max_context_chars",
  "prompt_mentions_only_registered_tools",
  "dogfood_invariants_pass",
  "required_tool_started",
  "max_repeated_external_path_action",
  "max_duplicate_tool_starts",
  "max_user_message_chars",
  "max_tool_errors",
]);

export function validateEvalSuite(input: unknown): EvalSuite {
  const suite = objectValue(input, "suite");
  if (suite.version !== AGENTIC_EVAL_SUITE_VERSION) {
    throw new Error(`Unsupported eval suite version: ${String(suite.version)}`);
  }
  const name = requiredString(suite.name, "suite.name");
  const cases = arrayValue(suite.cases, "suite.cases").map((entry, index) => validateCase(entry, index));
  if (cases.length === 0) throw new Error("Eval suite must contain at least one case.");

  const seen = new Set<string>();
  for (const evalCase of cases) {
    if (seen.has(evalCase.id)) throw new Error(`Duplicate eval case id: ${evalCase.id}`);
    seen.add(evalCase.id);
  }

  return {
    version: AGENTIC_EVAL_SUITE_VERSION,
    name,
    description: optionalString(suite.description),
    cases,
  };
}

export function evaluateStaticContextCase(
  evalCase: StaticContextEvalCase,
  snapshot: StaticContextSnapshot,
): EvalCaseResult {
  const findings: EvalFinding[] = [];
  for (const assertion of evalCase.assertions) {
    findings.push(...evaluateStaticAssertion(evalCase.id, assertion, snapshot));
  }
  return {
    id: evalCase.id,
    type: evalCase.type,
    status: findings.length > 0 ? "problem" : "pass",
    findings,
    metrics: {
      contextChars: snapshot.contextChars,
      toolSchemaTokens: snapshot.toolSchemaTokens,
      toolCount: snapshot.tools.length,
      toolNames: snapshot.tools.map((tool) => tool.name),
    },
  };
}

export function evaluateScriptedDogfoodCase(
  evalCase: ScriptedDogfoodEvalCase,
  snapshot: ScriptedDogfoodSnapshot,
): EvalCaseResult {
  const findings: EvalFinding[] = [];
  for (const error of snapshot.setupErrors ?? []) {
    findings.push({
      severity: "error",
      caseId: evalCase.id,
      area: "dogfood-setup",
      message: error,
    });
  }
  if (typeof snapshot.e2eExitCode === "number" && snapshot.e2eExitCode !== 0) {
    findings.push({
      severity: "error",
      caseId: evalCase.id,
      area: "dogfood-e2e",
      message: `Dogfood E2E command exited with code ${snapshot.e2eExitCode}.`,
    });
  }

  for (const assertion of evalCase.assertions) {
    findings.push(...evaluateDogfoodAssertion(evalCase.id, assertion, snapshot));
  }
  return {
    id: evalCase.id,
    type: evalCase.type,
    status: findings.length > 0 ? "problem" : "pass",
    findings,
    metrics: {
      dogfoodRunId: snapshot.dogfoodRunId,
      invariantOk: snapshot.invariant?.ok ?? null,
      maxUserMessageChars: dogfoodMaxUserMessageChars(snapshot),
      maxAssistantInput: snapshot.trace?.aggregate?.maxAssistantInput ?? 0,
      cacheHits: snapshot.trace?.aggregate?.cacheHits ?? 0,
      totalTokens: snapshot.trace?.aggregate?.usage?.totalTokens ?? 0,
      cacheReadTokens: snapshot.trace?.aggregate?.usage?.cacheRead ?? 0,
      repeatedExternalPathActions: repeatedExternalPathActions(snapshot.trace),
      duplicateToolStarts: duplicateToolStarts(snapshot.trace),
      toolStarts: toolStarts(snapshot),
      toolErrors: toolErrors(snapshot),
    },
    artifacts: snapshot.runDir ? { runDir: snapshot.runDir } : undefined,
  };
}

export function skippedEvalCase(evalCase: AgenticEvalCase, reason: string): EvalCaseResult {
  return {
    id: evalCase.id,
    type: evalCase.type,
    status: "skipped",
    findings: [],
    skippedReason: reason,
  };
}

function validateCase(input: unknown, index: number): AgenticEvalCase {
  const evalCase = objectValue(input, `suite.cases[${index}]`);
  const id = requiredString(evalCase.id, `suite.cases[${index}].id`);
  const type = requiredString(evalCase.type, `suite.cases[${index}].type`);
  if (type === "static-context") {
    const assertions = validateAssertions(evalCase.assertions, `suite.cases[${index}].assertions`);
    return {
      id,
      type,
      prompt: optionalString(evalCase.prompt),
      systemPrompt: optionalString(evalCase.systemPrompt),
      toolSurface: evalCase.toolSurface === "compat" ? "compat" : "default",
      contextWindow: optionalPositiveNumber(evalCase.contextWindow, `suite.cases[${index}].contextWindow`),
      externalWorkspace: validateStaticExternalWorkspaceConfig(
        evalCase.externalWorkspace,
        `suite.cases[${index}].externalWorkspace`,
      ),
      assertions,
    };
  }
  if (type === "scripted-dogfood") {
    const assertions = validateAssertions(evalCase.assertions, `suite.cases[${index}].assertions`);
    return {
      id,
      type,
      dogfood: validateDogfoodConfig(evalCase.dogfood, `suite.cases[${index}].dogfood`),
      assertions,
    };
  }
  if (type === "llm-judge") {
    return {
      id,
      type,
      dogfoodRunId: optionalString(evalCase.dogfoodRunId),
      minOverallScore: optionalPositiveNumber(evalCase.minOverallScore, `suite.cases[${index}].minOverallScore`),
      minDimensionScore: optionalPositiveNumber(evalCase.minDimensionScore, `suite.cases[${index}].minDimensionScore`),
    };
  }
  throw new Error(`Unsupported eval case type for ${id}: ${type}`);
}

function validateAssertions(input: unknown, path: string): EvalAssertion[] {
  return arrayValue(input, path).map((entry, assertionIndex) => validateAssertion(entry, `${path}[${assertionIndex}]`));
}

function validateDogfoodConfig(input: unknown, path: string): ScriptedDogfoodEvalCase["dogfood"] {
  if (input === undefined) return undefined;
  const config = objectValue(input, path);
  return {
    spec: optionalString(config.spec),
    timeoutMs: optionalPositiveNumber(config.timeoutMs, `${path}.timeoutMs`),
    turnTimeoutMs: optionalPositiveNumber(config.turnTimeoutMs, `${path}.turnTimeoutMs`),
  };
}

function validateStaticExternalWorkspaceConfig(
  input: unknown,
  path: string,
): StaticContextEvalCase["externalWorkspace"] {
  if (input === undefined) return undefined;
  const config = objectValue(input, path);
  return {
    enabled: typeof config.enabled === "boolean" ? config.enabled : undefined,
    rootPath: optionalString(config.rootPath),
  };
}

function validateAssertion(input: unknown, path: string): EvalAssertion {
  const assertion = objectValue(input, path);
  const type = requiredString(assertion.type, `${path}.type`);
  if (!ASSERTION_TYPES.has(type as EvalAssertion["type"])) {
    throw new Error(`Unsupported assertion type at ${path}: ${type}`);
  }
  const severity: EvalSeverity = assertion.severity === "warning" ? "warning" : "error";
  const base = {
    severity,
    area: optionalString(assertion.area),
    message: optionalString(assertion.message),
  };

  switch (type) {
    case "context_contains":
      return { ...base, type, text: requiredString(assertion.text, `${path}.text`) };
    case "context_not_contains":
      return { ...base, type, text: requiredString(assertion.text, `${path}.text`) };
    case "tool_registered":
      return { ...base, type, name: requiredString(assertion.name, `${path}.name`) };
    case "tool_not_registered":
      return { ...base, type, name: requiredString(assertion.name, `${path}.name`) };
    case "required_tool_started":
      return { ...base, type, name: requiredString(assertion.name, `${path}.name`) };
    case "tool_description_contains":
      return {
        ...base,
        type,
        name: requiredString(assertion.name, `${path}.name`),
        text: requiredString(assertion.text, `${path}.text`),
      };
    case "max_tool_schema_tokens":
      return { ...base, type, max: positiveNumber(assertion.max, `${path}.max`) };
    case "max_context_chars":
      return { ...base, type, max: positiveNumber(assertion.max, `${path}.max`) };
    case "max_user_message_chars":
      return { ...base, type, max: positiveNumber(assertion.max, `${path}.max`) };
    case "max_tool_errors":
      return {
        ...base,
        type,
        max: positiveNumber(assertion.max, `${path}.max`),
        name: optionalString(assertion.name),
        allowedByTool: validateOptionalCountRecord(assertion.allowedByTool, `${path}.allowedByTool`),
      };
    case "prompt_mentions_only_registered_tools":
      return {
        ...base,
        type,
        names: assertion.names === undefined ? undefined : arrayValue(assertion.names, `${path}.names`).map((value, index) =>
          requiredString(value, `${path}.names[${index}]`),
        ),
      };
    case "dogfood_invariants_pass":
      return { ...base, type };
    case "max_repeated_external_path_action":
    case "max_duplicate_tool_starts":
      return {
        ...base,
        type,
        max: positiveNumber(assertion.max, `${path}.max`),
        key: optionalString(assertion.key),
        allowedKeys: validateOptionalStringArray(assertion.allowedKeys, `${path}.allowedKeys`),
      };
  }
  throw new Error(`Unsupported assertion type at ${path}: ${type}`);
}

function evaluateStaticAssertion(
  caseId: string,
  assertion: EvalAssertion,
  snapshot: StaticContextSnapshot,
): EvalFinding[] {
  switch (assertion.type) {
    case "context_contains":
      return snapshot.systemPrompt.includes(assertion.text)
        ? []
        : [finding(caseId, assertion, "prompt", `System prompt does not contain required text: ${assertion.text}`)];
    case "context_not_contains":
      return snapshot.systemPrompt.includes(assertion.text)
        ? [finding(caseId, assertion, "prompt", `System prompt contains forbidden text: ${assertion.text}`)]
        : [];
    case "tool_registered":
      return hasTool(snapshot, assertion.name)
        ? []
        : [finding(caseId, assertion, "tools", `Expected tool is not registered: ${assertion.name}`)];
    case "tool_not_registered":
      return hasTool(snapshot, assertion.name)
        ? [finding(caseId, assertion, "tools", `Tool should not be registered: ${assertion.name}`)]
        : [];
    case "tool_description_contains": {
      const tool = toolByName(snapshot, assertion.name);
      if (!tool) return [finding(caseId, assertion, "tool-description", `Tool is not registered: ${assertion.name}`)];
      return (tool.description ?? "").includes(assertion.text)
        ? []
        : [
            finding(
              caseId,
              assertion,
              "tool-description",
              `Tool ${assertion.name} description does not contain: ${assertion.text}`,
              { description: tool.description ?? "" },
            ),
          ];
    }
    case "max_tool_schema_tokens":
      return snapshot.toolSchemaTokens <= assertion.max
        ? []
        : [
            finding(
              caseId,
              assertion,
              "context-budget",
              `Tool schema estimate is ${snapshot.toolSchemaTokens} tokens, over limit ${assertion.max}.`,
            ),
          ];
    case "max_context_chars":
      return snapshot.contextChars <= assertion.max
        ? []
        : [
            finding(
              caseId,
              assertion,
              "context-budget",
              `Static context is ${snapshot.contextChars} chars, over limit ${assertion.max}.`,
            ),
          ];
    case "prompt_mentions_only_registered_tools": {
      const mentionedUnavailable = (assertion.names ?? snapshot.knownToolNames).filter(
        (name) => !hasTool(snapshot, name) && mentionsToolName(snapshot.systemPrompt, name),
      );
      return mentionedUnavailable.length === 0
        ? []
        : [
            finding(
              caseId,
              assertion,
              "prompt-tools",
              `System prompt mentions unavailable tool(s): ${mentionedUnavailable.join(", ")}.`,
              { mentionedUnavailable },
            ),
          ];
    }
    default:
      return [];
  }
}

function evaluateDogfoodAssertion(
  caseId: string,
  assertion: EvalAssertion,
  snapshot: ScriptedDogfoodSnapshot,
): EvalFinding[] {
  switch (assertion.type) {
    case "dogfood_invariants_pass":
      if (snapshot.invariant?.ok === true) return [];
      return [
        finding(caseId, assertion, "dogfood-invariants", "Dogfood invariant oracle did not pass.", {
          invariantFindings: snapshot.invariant?.findings ?? [],
        }),
      ];
    case "required_tool_started": {
      const count = toolStarts(snapshot)[assertion.name] ?? 0;
      return count > 0
        ? []
        : [finding(caseId, assertion, "tool-coverage", `Required dogfood tool was not started: ${assertion.name}`)];
    }
    case "max_repeated_external_path_action": {
      const repeated = repeatedExternalPathActions(snapshot.trace).filter(
        (item) =>
          !assertion.allowedKeys?.includes(item.key) &&
          (assertion.key ? item.key === assertion.key : true) &&
          item.count > assertion.max,
      );
      return repeated.length === 0
        ? []
        : [
            finding(
              caseId,
              assertion,
              "tool-efficiency",
              `Repeated external path action count exceeded ${assertion.max}.`,
              { repeated },
            ),
          ];
    }
    case "max_duplicate_tool_starts": {
      const duplicates = duplicateToolStarts(snapshot.trace).filter(
        (item) =>
          !assertion.allowedKeys?.includes(item.key) &&
          (assertion.key ? item.key === assertion.key : true) &&
          item.count > assertion.max,
      );
      return duplicates.length === 0
        ? []
        : [
            finding(
              caseId,
              assertion,
              "tool-efficiency",
              `Duplicate exact tool starts exceeded ${assertion.max}.`,
              { duplicates },
            ),
          ];
    }
    case "max_user_message_chars": {
      const max = dogfoodMaxUserMessageChars(snapshot);
      return max <= assertion.max
        ? []
        : [finding(caseId, assertion, "context-budget", `Max user message was ${max} chars, over limit ${assertion.max}.`)];
    }
    case "max_tool_errors": {
      const errors = toolErrors(snapshot);
      const count = assertion.name
        ? adjustedToolErrorCount(errors, assertion.allowedByTool, assertion.name)
        : Object.keys(errors).reduce((total, name) => total + adjustedToolErrorCount(errors, assertion.allowedByTool, name), 0);
      return count <= assertion.max
        ? []
        : [
            finding(
              caseId,
              assertion,
              "tool-errors",
              `Tool error count was ${count}, over limit ${assertion.max}.`,
              { toolErrors: errors },
            ),
          ];
    }
    default:
      return [];
  }
}

function finding(
  caseId: string,
  assertion: EvalAssertionBase,
  defaultArea: string,
  defaultMessage: string,
  details?: unknown,
): EvalFinding {
  return {
    severity: assertion.severity ?? "error",
    caseId,
    area: assertion.area ?? defaultArea,
    message: assertion.message ?? defaultMessage,
    details,
  };
}

function hasTool(snapshot: StaticContextSnapshot, name: string): boolean {
  return snapshot.tools.some((tool) => tool.name === name);
}

function toolByName(snapshot: StaticContextSnapshot, name: string): StaticContextSnapshot["tools"][number] | undefined {
  return snapshot.tools.find((tool) => tool.name === name);
}

function mentionsToolName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`, "i");
  return pattern.test(text);
}

function dogfoodMaxUserMessageChars(snapshot: ScriptedDogfoodSnapshot): number {
  const invariantMax = snapshot.invariant?.metrics.maxUserMessageChars ?? 0;
  const aggregateMax = snapshot.trace?.aggregate?.maxUserMessageChars ?? 0;
  const fileMax = Math.max(0, ...(snapshot.trace?.files ?? []).map((file) => file.maxUserMessageChars ?? 0));
  return Math.max(invariantMax, aggregateMax, fileMax);
}

function repeatedExternalPathActions(trace: SessionTraceSnapshot | undefined): SessionTraceRepeatedItem[] {
  return mergeRepeated((trace?.files ?? []).flatMap((file) => file.repeatedExternalPathActions ?? []));
}

function duplicateToolStarts(trace: SessionTraceSnapshot | undefined): SessionTraceRepeatedItem[] {
  return mergeRepeated((trace?.files ?? []).flatMap((file) => file.duplicateToolStarts ?? []));
}

function mergeRepeated(items: SessionTraceRepeatedItem[]): SessionTraceRepeatedItem[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.key, (counts.get(item.key) ?? 0) + item.count);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count);
}

function toolStarts(snapshot: ScriptedDogfoodSnapshot): Record<string, number> {
  return snapshot.invariant?.metrics.toolStarts ?? snapshot.trace?.aggregate?.toolStartsByTool ?? {};
}

function toolErrors(snapshot: ScriptedDogfoodSnapshot): Record<string, number> {
  return snapshot.invariant?.metrics.toolErrors ?? snapshot.trace?.aggregate?.toolErrorsByTool ?? {};
}

function adjustedToolErrorCount(errors: Record<string, number>, allowedByTool: Record<string, number> | undefined, name: string): number {
  return Math.max(0, (errors[name] ?? 0) - (allowedByTool?.[name] ?? 0));
}

function objectValue(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${path} must be an object.`);
  return input as Record<string, unknown>;
}

function arrayValue(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input)) throw new Error(`${path} must be an array.`);
  return input;
}

function requiredString(input: unknown, path: string): string {
  if (typeof input !== "string" || !input.trim()) throw new Error(`${path} must be a non-empty string.`);
  return input;
}

function optionalString(input: unknown): string | undefined {
  return typeof input === "string" ? input : undefined;
}

function validateOptionalStringArray(input: unknown, path: string): string[] | undefined {
  if (input === undefined) return undefined;
  return arrayValue(input, path).map((value, index) => requiredString(value, `${path}[${index}]`));
}

function validateOptionalCountRecord(input: unknown, path: string): Record<string, number> | undefined {
  if (input === undefined) return undefined;
  const record = objectValue(input, path);
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) counts[key] = positiveNumber(value, `${path}.${key}`);
  return counts;
}

function positiveNumber(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    throw new Error(`${path} must be a positive number.`);
  }
  return input;
}

function optionalPositiveNumber(input: unknown, path: string): number | undefined {
  if (input === undefined) return undefined;
  return positiveNumber(input, path);
}
