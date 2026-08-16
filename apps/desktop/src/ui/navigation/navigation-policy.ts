export type ManagementView = "playbooks" | "connections" | "plugins" | "models" | "administration";

/** Central product capability policy for management navigation and deep links. */
export function canOpenManagementView(view: ManagementView, _administrator: boolean): boolean { return view !== "playbooks"; }

export function managementNavigationVisibility(_administrator: boolean): Record<ManagementView, boolean> {
  return {
    playbooks: false,
    connections: true,
    plugins: true,
    models: true,
    administration: true,
  };
}
