import type {
  EmbeddingInput,
  EmbeddingModelProfile,
  EmbeddingRequestOptions,
  EmbeddingResult,
  RetrievalDocument,
  RetrievalEmbedder,
} from "../../src/retrieval/policy";

export const MULTILINGUAL_RETRIEVAL_FIXTURE: readonly RetrievalDocument[] = [
  {
    id: "en-mcp-oauth",
    path: "Projects/MCP OAuth.md",
    title: "MCP OAuth plan",
    content: "OAuth refresh tokens need reauth, scope step-up, and clear diagnostics.",
    language: "en",
    tags: ["mcp", "security"],
    aliases: ["remote tools"],
    frontmatter: { status: "draft", owner: "platform" },
    links: ["Security/Audit log.md"],
    backlinks: ["Projects/Agentic Chat.md"],
    modifiedTime: Date.UTC(2026, 5, 10),
  },
  {
    id: "hu-agent-naplo",
    path: "Napi/Agent naplo.md",
    title: "Agent naplo",
    content: "Az agent muveletei legyenek naplozva, visszavonhatok es idezhetoek.",
    language: "hu-HU",
    tags: ["agent", "biztonsag"],
    aliases: ["audit"],
    frontmatter: { status: "jegyzet", owner: "platform" },
    links: ["Projects/MCP OAuth.md"],
    backlinks: [],
    modifiedTime: Date.UTC(2026, 5, 11),
  },
  {
    id: "en-retrieval",
    path: "Research/Retrieval.md",
    title: "Retrieval ladder",
    content: "Start with lexical, metadata, graph, and recency signals before embeddings.",
    language: "en",
    tags: ["retrieval", "rag"],
    aliases: ["hybrid search"],
    frontmatter: { status: "accepted" },
    links: ["Projects/MCP OAuth.md"],
    backlinks: ["Napi/Agent naplo.md"],
    modifiedTime: Date.UTC(2026, 5, 12),
  },
];

export const FAKE_EMBEDDING_PROFILE: EmbeddingModelProfile = {
  id: "test/fake-deterministic-embedding",
  provider: "test",
  dimensions: 8,
  execution: "local-cpu",
  languageCoverage: "multilingual",
  requiresNetwork: false,
};

export class DeterministicFakeEmbedder implements RetrievalEmbedder {
  readonly profile: EmbeddingModelProfile;

  constructor(profile: EmbeddingModelProfile = FAKE_EMBEDDING_PROFILE) {
    this.profile = profile;
  }

  async embed(input: EmbeddingInput, options?: EmbeddingRequestOptions): Promise<EmbeddingResult> {
    if (options?.signal?.aborted) throw new Error("fake embedding cancelled");
    return {
      inputId: input.id,
      modelId: this.profile.id,
      dimensions: this.profile.dimensions,
      values: stableVector(`${normalizeSeed(input.text)}:${input.language ?? ""}`, this.profile.dimensions),
      language: input.language,
    };
  }

  async embedBatch(inputs: readonly EmbeddingInput[], options?: EmbeddingRequestOptions): Promise<EmbeddingResult[]> {
    return Promise.all(inputs.map((input) => this.embed(input, options)));
  }
}

function normalizeSeed(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function stableVector(seed: string, dimensions: number): readonly number[] {
  return Array.from({ length: dimensions }, (_unused, index) => hashToUnit(`${seed}:${index}`));
}

function hashToUnit(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Number((((hash >>> 0) / 0xffffffff) * 2 - 1).toFixed(6));
}
