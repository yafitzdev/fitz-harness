// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunPlan } from "@fitz/protocol";
import { AgentPlanPanel } from "./agent-plan-panel.js";

const item = (id: string, task: string, status: "pending" | "running" | "completed", owner: "main" | "worker") => ({
  id, task, status, owner, dependencies: [], workerEligible: owner === "worker", required: true, attempts: 0,
});

function plan(revision: number, status: "active" | "completed", items: AgentRunPlan["items"], runId = "run-1"): AgentRunPlan {
  return { runId, revision, status, items, createdAt: "2026-08-15T00:00:00Z", updatedAt: "2026-08-15T00:00:00Z" };
}

beforeEach(() => document.body.replaceChildren());

describe("AgentPlanPanel", () => {
  it("keeps one checklist inside the composer shell and replaces it with newer revisions", () => {
    const dock = document.createElement("div");
    const shell = document.createElement("div");
    shell.className = "composer-shell";
    const form = document.createElement("form");
    shell.append(form);
    dock.append(shell);
    document.body.append(dock);
    const panel = new AgentPlanPanel(dock);

    expect(panel.root.hidden).toBe(true);
    expect(panel.root.parentElement).toBe(shell);
    expect(form.previousElementSibling).toBe(panel.root);
    panel.update(plan(1, "active", [item("inspect", "Inspect runtime", "running", "worker"), item("build", "Build fix", "pending", "main")]));
    panel.update(plan(2, "active", [item("inspect", "Inspect runtime", "completed", "worker"), item("build", "Build fix", "running", "main")]));

    expect(dock.querySelectorAll(".agent-plan-panel")).toHaveLength(1);
    expect([...dock.querySelectorAll(".agent-plan-panel-task")].map((node) => node.textContent)).toEqual(["Inspect runtime", "Build fix"]);
    expect(panel.root.querySelector(".agent-plan-panel-summary")?.textContent).toBe("1 of 2 done");
    expect(panel.root.querySelector('[data-task-id="build"]')?.classList.contains("running")).toBe(true);
    expect(panel.root.classList.contains("collapsed")).toBe(true);
    expect(panel.root.querySelector<HTMLOListElement>(".agent-plan-panel-list")!.hidden).toBe(true);
    expect(panel.root.querySelector(".agent-plan-panel-toggle")?.getAttribute("aria-expanded")).toBe("false");

    panel.root.querySelector<HTMLButtonElement>(".agent-plan-panel-toggle")!.click();
    expect(panel.root.classList.contains("collapsed")).toBe(false);
    expect(panel.root.querySelector<HTMLOListElement>(".agent-plan-panel-list")!.hidden).toBe(false);
    expect(panel.root.querySelector(".agent-plan-panel-toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(panel.root.textContent).toContain("1 of 2 done");
  });

  it("collapses each new run and only opens after a user click", () => {
    const dock = document.createElement("div"); dock.append(document.createElement("form"));
    const panel = new AgentPlanPanel(dock);
    const tasks = [item("build", "Build fix", "running", "main")];

    panel.update(plan(1, "active", tasks));
    expect(panel.root.classList.contains("collapsed")).toBe(true);
    panel.root.querySelector<HTMLButtonElement>(".agent-plan-panel-toggle")!.click();
    expect(panel.root.classList.contains("collapsed")).toBe(false);

    panel.update(plan(2, "active", tasks));
    expect(panel.root.classList.contains("collapsed")).toBe(false);
    panel.update(plan(1, "active", tasks, "run-2"));
    expect(panel.root.classList.contains("collapsed")).toBe(true);
  });

  it("spins every running row and keeps the first-observed running task in the collapsed header", () => {
    const dock = document.createElement("div"); dock.append(document.createElement("form"));
    const panel = new AgentPlanPanel(dock);
    const first = item("first", "Already running", "running", "main");
    const later = item("later", "Started later", "running", "worker");

    panel.update(plan(1, "active", [first, item("later", "Started later", "pending", "worker")]));
    panel.update(plan(2, "active", [later, first]));

    expect(panel.root.querySelectorAll(".agent-plan-panel-item.running .agent-plan-panel-spinner")).toHaveLength(2);
    expect([...panel.root.querySelectorAll(".agent-plan-panel-item.running .agent-plan-panel-mark")].every((mark) => mark.textContent === "")).toBe(true);
    expect(panel.root.querySelector(".agent-plan-panel-current-text")?.textContent).toBe("Already running");
    expect(panel.root.querySelector(".agent-plan-panel-current")?.getAttribute("title")).toBe("Already running");

    panel.update(plan(3, "active", [later, item("first", "Already running", "completed", "main")]));
    expect(panel.root.querySelector(".agent-plan-panel-current-text")?.textContent).toBe("Started later");
  });

  it("marks an overflowing collapsed preview for scrolling and a right-edge fade", async () => {
    const dock = document.createElement("div"); dock.append(document.createElement("form"));
    const panel = new AgentPlanPanel(dock);
    const viewport = panel.root.querySelector<HTMLElement>(".agent-plan-panel-current")!;
    const text = panel.root.querySelector<HTMLElement>(".agent-plan-panel-current-text")!;
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 100 });
    Object.defineProperty(text, "scrollWidth", { configurable: true, value: 260 });

    panel.update(plan(1, "active", [item("long", "A deliberately long task description", "running", "main")]));

    await vi.waitFor(() => expect(viewport.classList.contains("overflowing")).toBe(true));
    expect(viewport.style.getPropertyValue("--agent-plan-scroll-distance")).toBe("160px");
    expect(viewport.style.getPropertyValue("--agent-plan-scroll-duration")).not.toBe("");
  });

  it("extracts durable results, ignores stale revisions, and resets between chats", () => {
    const dock = document.createElement("div"); dock.append(document.createElement("form"));
    const panel = new AgentPlanPanel(dock);
    panel.updateFromToolResult({ details: { plan: plan(3, "completed", [item("done", "Finish", "completed", "main")]) } });
    panel.update(plan(2, "active", [item("old", "Old state", "running", "main")]));
    expect(panel.root.textContent).toContain("Finish");
    expect(panel.root.textContent).not.toContain("Old state");
    expect(panel.root.classList.contains("completed")).toBe(true);
    panel.reset();
    expect(panel.root.hidden).toBe(true);
    expect(panel.root.classList.contains("collapsed")).toBe(true);
    expect(panel.root.querySelectorAll("li")).toHaveLength(0);
    expect(panel.root.querySelector<HTMLElement>(".agent-plan-panel-current")!.hidden).toBe(true);
  });
});
