import type { Recipe, Route } from "@fitz/protocol";

const capabilities = {
  chatCompletions: true,
  streaming: true,
  toolCalls: false,
  responseFormat: false,
  minP: false,
  maxConcurrentGenerations: 1,
} as const;

export const DEFAULT_RECIPES: Recipe[] = [
  {
    id: "fake-best",
    playbookId: "fake-development",
    displayName: "Fake Best Model",
    adapter: "fake",
    modelId: "fake-best-v1",
    contextTokens: 100_000,
    capabilities,
    lifecycle: {
      loadPolicy: "onDemand",
      evictionPolicy: "idle-ttl",
      idleTtlSeconds: 600,
      minimumResidencySeconds: 1,
    },
    configuration: {},
  },
  {
    id: "fake-fast",
    playbookId: "fake-development",
    displayName: "Fake Fast Model",
    adapter: "fake",
    modelId: "fake-fast-v1",
    contextTokens: 100_000,
    capabilities,
    lifecycle: {
      loadPolicy: "onDemand",
      evictionPolicy: "idle-ttl",
      idleTtlSeconds: 600,
      minimumResidencySeconds: 1,
    },
    configuration: {},
  },
];

export const DEFAULT_ROUTES: Route[] = [
  {
    id: "default",
    displayName: "Default",
    description: "Balanced default route",
    recipeId: "fake-best",
    enabled: true,
    isDefault: true,
  },
];
