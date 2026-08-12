import { join, resolve } from "node:path";
import type { FitzRuntimePaths } from "./runtime-paths.js";

/** One Fitz-owned Linux filesystem shared by Linux-only inference engines.
 * Engine source remains in the host registry; only deployed executables,
 * package environments, and runtime-resident model payloads live here. */
export const MANAGED_LINUX_RUNTIME_ID = "inference-linux";
export const MANAGED_LINUX_DISTRIBUTION = "Fitz-Inference";
export const MANAGED_LINUX_GUEST_ROOT = "/opt/fitz/llm";

export interface ManagedLinuxRuntimeLayout {
  id: string;
  distribution: string;
  hostRoot: string;
  guestRoot: string;
  engineRoot: string;
  environmentRoot: string;
  modelRoot: string;
  logRoot: string;
}

export interface ManagedLinuxRuntimeManifest {
  schemaVersion: 2;
  id: string;
  distribution: string;
  guestRoot: string;
  provisionedAt: string;
  components: Record<string, unknown>;
}

export function managedLinuxRuntimeLayout(paths: FitzRuntimePaths): ManagedLinuxRuntimeLayout {
  return {
    id: MANAGED_LINUX_RUNTIME_ID,
    distribution: MANAGED_LINUX_DISTRIBUTION,
    hostRoot: resolve(join(paths.runtimeRoot, MANAGED_LINUX_RUNTIME_ID)),
    guestRoot: MANAGED_LINUX_GUEST_ROOT,
    engineRoot: `${MANAGED_LINUX_GUEST_ROOT}/engines`,
    environmentRoot: `${MANAGED_LINUX_GUEST_ROOT}/environments`,
    modelRoot: `${MANAGED_LINUX_GUEST_ROOT}/models`,
    logRoot: `${MANAGED_LINUX_GUEST_ROOT}/logs`,
  };
}

export function managedLinuxRuntimeMap(layout: ManagedLinuxRuntimeLayout): ReadonlyMap<string, { distribution: string }> {
  return new Map([[layout.id, { distribution: layout.distribution }]]);
}

export function mergeManagedLinuxRuntimeComponent(
  layout: ManagedLinuxRuntimeLayout,
  componentId: string,
  component: unknown,
  existing?: ManagedLinuxRuntimeManifest,
): ManagedLinuxRuntimeManifest {
  if (existing && (existing.schemaVersion !== 2 || existing.id !== layout.id)) {
    throw new Error(`Runtime manifest does not describe ${layout.id}`);
  }
  return {
    schemaVersion: 2,
    id: layout.id,
    distribution: layout.distribution,
    guestRoot: layout.guestRoot,
    provisionedAt: new Date().toISOString(),
    components: { ...(existing?.components ?? {}), [componentId]: component },
  };
}
