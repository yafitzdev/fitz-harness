import type { Route } from "@fitz/protocol";
import { RecipeNotFoundError, RouteNotFoundError, type ResolvedRoute, type RouteResolver } from "@fitz/inference-core";
import type { SqliteStore } from "@fitz/storage";

export const LOCAL_OWNER_ID = "local";
export const CHAT_ROUTE_IDS = ["default", "fast", "smart"] as const;
export type ChatRouteId = (typeof CHAT_ROUTE_IDS)[number];
export type CloudRouteRole = "smart" | "fast";

export interface ConsumerModelRegistration {
  modelId: string;
  recipeId: string;
}

export interface ConsumerMediaModelRegistration {
  modelId: string;
  recipeId: string;
  routeId: string;
  modality: "image" | "video" | "audio";
  template: string;
}

export interface ConsumerConnectionRegistration {
  ownerUserId: string;
  id: string;
  displayName: string;
  baseUrl: string;
  authType: "none" | "bearer";
  credentialEnv: string;
  template: string;
  models: ConsumerModelRegistration[];
  mediaModels: ConsumerMediaModelRegistration[];
  updatedAt: string;
}

export interface ConsumerCloudRouteBinding {
  ownerUserId: string;
  role: CloudRouteRole;
  recipeId: string;
  updatedAt: string;
}

const CONNECTIONS_SETTING = "consumerConnections";
const CLOUD_ROUTES_SETTING = "consumerCloudRoutes";

export function hasCloudRouteBinding(store: SqliteStore, ownerUserId: string, role: CloudRouteRole): boolean {
  const value = store.getSetting<unknown>(CLOUD_ROUTES_SETTING);
  return Array.isArray(value) && value.some((binding) => isCloudRouteBinding(binding)
    && binding.ownerUserId === ownerUserId && binding.role === role);
}

/** Resolves the product's three user-facing text roles. Default is global host
 * state. Smart and Fast are private cloud choices owned by one consumer. Fast
 * is also the worker route used by delegated runs. */
export class UserRouteResolver {
  constructor(
    readonly store: SqliteStore,
    readonly routes: RouteResolver,
  ) {}

  resolve(routeId: string, ownerUserId = LOCAL_OWNER_ID, internal = false): ResolvedRoute {
    if (routeId === "default") return this.routes.resolve("default");
    if (routeId === "smart") return this.#resolveCloudRole(ownerUserId, "smart");
    if (routeId === "fast") return this.#resolveCloudRole(ownerUserId, "fast");
    throw new RouteNotFoundError(routeId);
  }

  publicRoutes(ownerUserId = LOCAL_OWNER_ID): Route[] {
    const result: Route[] = [this.routes.resolve("default").route];
    for (const role of ["fast", "smart"] as const) {
      const binding = this.binding(ownerUserId, role);
      if (binding) result.push(this.#resolvedCloudRoute(role, binding.recipeId).route);
    }
    return result;
  }

  contextTokens(routeId: string, ownerUserId = LOCAL_OWNER_ID, internal = false): number {
    return this.resolve(routeId, ownerUserId, internal).recipe.contextTokens;
  }

  connections(ownerUserId: string): ConsumerConnectionRegistration[] {
    return this.#allConnections().filter((connection) => connection.ownerUserId === ownerUserId);
  }

  allConnections(): ConsumerConnectionRegistration[] {
    return this.#allConnections();
  }

  replaceConnection(ownerUserId: string, connection: ConsumerConnectionRegistration): void {
    if (connection.ownerUserId !== ownerUserId) throw new TypeError("Connection owner does not match the authenticated user");
    const retained = this.#allConnections().filter((item) => item.ownerUserId !== ownerUserId || item.id !== connection.id);
    const next = [...retained, connection];
    this.store.setSetting(CONNECTIONS_SETTING, next);
    const validRecipeIds = new Set(next.filter((item) => item.ownerUserId === ownerUserId).flatMap((item) => item.models.map((model) => model.recipeId)));
    this.store.setSetting(CLOUD_ROUTES_SETTING, this.#allBindings().filter((binding) =>
      binding.ownerUserId !== ownerUserId || validRecipeIds.has(binding.recipeId)));
  }

  removeConnection(ownerUserId: string, connectionId: string): void {
    const connection = this.connections(ownerUserId).find((item) => item.id === connectionId);
    if (!connection) return;
    const ownedRecipes = new Set(connection.models.map((model) => model.recipeId));
    this.store.setSetting(CONNECTIONS_SETTING, this.#allConnections().filter((item) => item.ownerUserId !== ownerUserId || item.id !== connectionId));
    this.store.setSetting(CLOUD_ROUTES_SETTING, this.#allBindings().filter((binding) =>
      binding.ownerUserId !== ownerUserId || !ownedRecipes.has(binding.recipeId)));
  }

  bindings(ownerUserId: string): ConsumerCloudRouteBinding[] {
    return this.#allBindings().filter((binding) => binding.ownerUserId === ownerUserId);
  }

  binding(ownerUserId: string, role: CloudRouteRole): ConsumerCloudRouteBinding | undefined {
    return this.bindings(ownerUserId).find((binding) => binding.role === role);
  }

  assign(ownerUserId: string, role: CloudRouteRole, recipeId: string): ConsumerCloudRouteBinding {
    const recipe = this.routes.resolveRecipe(recipeId);
    if (!recipe.capabilities.chatCompletions) throw new TypeError(`Recipe ${recipeId} does not support chat completions`);
    const ownsRecipe = this.connections(ownerUserId).some((connection) => connection.models.some((model) => model.recipeId === recipeId));
    if (!ownsRecipe) throw new RecipeNotFoundError(recipeId);
    const binding: ConsumerCloudRouteBinding = { ownerUserId, role, recipeId, updatedAt: new Date().toISOString() };
    this.store.setSetting(CLOUD_ROUTES_SETTING, [
      ...this.#allBindings().filter((item) => item.ownerUserId !== ownerUserId || item.role !== role),
      binding,
    ]);
    return binding;
  }

  clear(ownerUserId: string, role: CloudRouteRole): void {
    this.store.setSetting(CLOUD_ROUTES_SETTING, this.#allBindings().filter((item) => item.ownerUserId !== ownerUserId || item.role !== role));
  }

  configuration(ownerUserId: string): Record<CloudRouteRole, string | undefined> {
    return {
      smart: this.binding(ownerUserId, "smart")?.recipeId,
      fast: this.binding(ownerUserId, "fast")?.recipeId,
    };
  }

  #resolveCloudRole(ownerUserId: string, role: CloudRouteRole): ResolvedRoute {
    const binding = this.binding(ownerUserId, role);
    if (!binding) throw new RouteNotFoundError(role);
    return this.#resolvedCloudRoute(role, binding.recipeId);
  }

  #resolvedCloudRoute(role: CloudRouteRole, recipeId: string): ResolvedRoute {
    const recipe = this.routes.resolveRecipe(recipeId);
    return {
      route: {
        id: role,
        displayName: role === "smart" ? "Smart" : "Fast",
        description: role === "smart" ? "Your cloud planning model" : "Your cloud subagent model",
        recipeId,
        enabled: true,
      },
      recipe,
    };
  }

  #allConnections(): ConsumerConnectionRegistration[] {
    const value = this.store.getSetting<unknown>(CONNECTIONS_SETTING);
    if (!Array.isArray(value)) return [];
    // Registrations without an explicit owner belong to the removed global
    // connection model and are intentionally not interpreted as user state.
    return value.filter(isConsumerConnectionRegistration);
  }

  #allBindings(): ConsumerCloudRouteBinding[] {
    const value = this.store.getSetting<unknown>(CLOUD_ROUTES_SETTING);
    return Array.isArray(value) ? value.filter(isCloudRouteBinding) : [];
  }
}

function isConsumerConnectionRegistration(value: unknown): value is ConsumerConnectionRegistration {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ConsumerConnectionRegistration>;
  return typeof item.ownerUserId === "string" && item.ownerUserId.length > 0
    && typeof item.id === "string" && typeof item.credentialEnv === "string"
    && Array.isArray(item.models) && Array.isArray(item.mediaModels);
}

function isCloudRouteBinding(value: unknown): value is ConsumerCloudRouteBinding {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ConsumerCloudRouteBinding>;
  return typeof item.ownerUserId === "string" && item.ownerUserId.length > 0
    && (item.role === "smart" || item.role === "fast")
    && typeof item.recipeId === "string" && item.recipeId.length > 0
    && typeof item.updatedAt === "string";
}
