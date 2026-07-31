import type { InstanceState } from "@fitz/protocol";

const ALLOWED_TRANSITIONS: Readonly<Record<InstanceState, readonly InstanceState[]>> = {
  UNLOADED: ["PREPARING"],
  PREPARING: ["LOADING", "FAILED"],
  LOADING: ["READY", "FAILED"],
  READY: ["BUSY", "DRAINING", "EVICTING", "FAILED"],
  BUSY: ["READY", "FAILED"],
  DRAINING: ["EVICTING", "FAILED"],
  EVICTING: ["UNLOADED", "FAILED"],
  FAILED: ["PREPARING", "UNLOADED", "EVICTING"],
};

export function canTransition(from: InstanceState, to: InstanceState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: InstanceState, to: InstanceState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid instance transition: ${from} -> ${to}`);
  }
}
