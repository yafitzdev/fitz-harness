import type { AgentEffort, AgentTopologyPresentation, EngineRegistration, InstanceSnapshot, Recipe, Route } from "@fitz/protocol";

export type CloudRouteRole = "smart" | "fast";

export interface ChatDefaults {
  route: string;
  effort: AgentEffort;
}

export interface EngineFolderSnapshot {
  folderName: string;
  rootPath: string;
  registered: boolean;
  engine?: EngineRegistration;
}

/** Typed, validated snapshot returned by /api/v1/management/status. */
export interface ManagementConfiguration {
  engine: InstanceSnapshot;
  residency: Record<string, unknown>;
  queueDepth: number;
  resources: Record<string, unknown>;
  routes: Route[];
  recipes: Recipe[];
  engines: EngineRegistration[];
  cloudRoutes: Partial<Record<CloudRouteRole, string>>;
  chatDefaults: ChatDefaults;
  agentTopologies: Record<string, AgentTopologyPresentation>;
  isAdministrator: boolean;
  hostName: string;
  engineRoot: string;
  engineFolders: EngineFolderSnapshot[];
}

export function parseManagementConfiguration(value: unknown): ManagementConfiguration {
  if (!isRecord(value)) throw invalidConfiguration("response is not an object");
  const chatDefaults = value.chatDefaults;
  if (!isRecord(chatDefaults) || typeof chatDefaults.route !== "string" || !isEffort(chatDefaults.effort)) {
    throw invalidConfiguration("chat defaults are invalid");
  }
  if (!isRecord(value.engine) || !isRecord(value.residency) || !isRecord(value.resources)) {
    throw invalidConfiguration("runtime snapshots are invalid");
  }
  if (!Array.isArray(value.routes) || !Array.isArray(value.recipes) || !Array.isArray(value.engines) || !Array.isArray(value.engineFolders)) {
    throw invalidConfiguration("routes, recipes, engines, or engine folders are invalid");
  }
  if (!isRecord(value.cloudRoutes) || !isRecord(value.agentTopologies)) {
    throw invalidConfiguration("route bindings or topology presentations are invalid");
  }
  if (typeof value.queueDepth !== "number" || !Number.isFinite(value.queueDepth)
    || typeof value.isAdministrator !== "boolean" || typeof value.hostName !== "string" || typeof value.engineRoot !== "string") {
    throw invalidConfiguration("host identity or queue state is invalid");
  }
  const routes = value.routes.map((route) => parseManagementRoute(route));
  const engineFolders = value.engineFolders.map((folder) => parseEngineFolder(folder));
  const cloudRoutes: Partial<Record<CloudRouteRole, string>> = {};
  for (const role of ["smart", "fast"] as const) {
    const recipeId = value.cloudRoutes[role];
    if (recipeId !== undefined && typeof recipeId !== "string") throw invalidConfiguration(`${role} route binding is invalid`);
    if (recipeId !== undefined) cloudRoutes[role] = recipeId;
  }
  return {
    ...value,
    engine: value.engine as InstanceSnapshot,
    residency: value.residency,
    queueDepth: value.queueDepth,
    resources: value.resources,
    routes,
    recipes: value.recipes as Recipe[],
    engines: value.engines as EngineRegistration[],
    cloudRoutes,
    chatDefaults: { route: chatDefaults.route, effort: chatDefaults.effort },
    agentTopologies: value.agentTopologies as Record<string, AgentTopologyPresentation>,
    isAdministrator: value.isAdministrator,
    hostName: value.hostName,
    engineRoot: value.engineRoot,
    engineFolders,
  };
}

export function parseManagementRoute(value: unknown): Route {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.displayName !== "string"
    || typeof value.recipeId !== "string" || typeof value.enabled !== "boolean") {
    throw invalidConfiguration("route is invalid");
  }
  if (value.kind !== undefined && value.kind !== "chat" && value.kind !== "image" && value.kind !== "video" && value.kind !== "audio") {
    throw invalidConfiguration("route kind is invalid");
  }
  return value as Route;
}

function parseEngineFolder(value: unknown): EngineFolderSnapshot {
  if (!isRecord(value) || typeof value.folderName !== "string" || typeof value.rootPath !== "string" || typeof value.registered !== "boolean") {
    throw invalidConfiguration("engine folder is invalid");
  }
  if (value.engine !== undefined && !isRecord(value.engine)) throw invalidConfiguration("engine registration is invalid");
  return {
    folderName: value.folderName,
    rootPath: value.rootPath,
    registered: value.registered,
    ...(value.engine !== undefined ? { engine: value.engine as EngineRegistration } : {}),
  };
}

function isEffort(value: unknown): value is AgentEffort {
  return value === "light" || value === "normal" || value === "high";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidConfiguration(detail: string): TypeError {
  return new TypeError(`The host returned an invalid management configuration: ${detail}`);
}
