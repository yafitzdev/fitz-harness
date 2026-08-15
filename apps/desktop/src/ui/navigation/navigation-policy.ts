export type ManagementView = "playbooks" | "connections" | "plugins" | "models" | "administration";

const ADMINISTRATOR_VIEWS = new Set<ManagementView>(["playbooks", "plugins", "models", "administration"]);

/** Central product capability policy for management navigation and deep links. */
export function canOpenManagementView(view: ManagementView, administrator: boolean): boolean {
  if (view === "playbooks") return false;
  return !ADMINISTRATOR_VIEWS.has(view) || administrator;
}

export function managementNavigationVisibility(administrator: boolean): Record<ManagementView, boolean> {
  return {
    playbooks: false,
    connections: true,
    plugins: canOpenManagementView("plugins", administrator),
    models: canOpenManagementView("models", administrator),
    administration: canOpenManagementView("administration", administrator),
  };
}
