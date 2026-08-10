export type ManagementView = "playbooks" | "connections" | "plugins" | "models" | "usage" | "administration";

const ADMINISTRATOR_VIEWS = new Set<ManagementView>(["playbooks", "plugins", "models", "usage", "administration"]);

/** Central product capability policy for management navigation and deep links. */
export function canOpenManagementView(view: ManagementView, administrator: boolean): boolean {
  return !ADMINISTRATOR_VIEWS.has(view) || administrator;
}

export function managementNavigationVisibility(administrator: boolean): Record<ManagementView, boolean> {
  return {
    playbooks: canOpenManagementView("playbooks", administrator),
    connections: true,
    plugins: canOpenManagementView("plugins", administrator),
    models: canOpenManagementView("models", administrator),
    usage: canOpenManagementView("usage", administrator),
    administration: canOpenManagementView("administration", administrator),
  };
}
