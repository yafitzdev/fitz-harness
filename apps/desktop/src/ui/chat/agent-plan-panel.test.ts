// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import type { AgentRunPlan } from "@fitz/protocol";
import { AgentPlanPanel } from "./agent-plan-panel.js";

const item = (id: string, task: string, status: "pending" | "running" | "completed", owner: "main" | "worker") => ({
  id, task, status, owner, dependencies: [], workerEligible: owner === "worker", required: true, attempts: 0,
});

function plan(revision: number, status: "active" | "completed", items: AgentRunPlan["items"]): AgentRunPlan {
  return { runId: "run-1", revision, status, items, createdAt: "2026-08-15T00:00:00Z", updatedAt: "2026-08-15T00:00:00Z" };
}

beforeEach(() => document.body.replaceChildren());

describe("AgentPlanPanel", () => {
  it("keeps one checklist above the composer and replaces it with newer revisions", () => {
    const dock = document.createElement("div");
    const form = document.createElement("form");
    dock.append(form);
    document.body.append(dock);
    const panel = new AgentPlanPanel(dock);

    expect(panel.root.hidden).toBe(true);
    expect(form.previousElementSibling).toBe(panel.root);
    panel.update(plan(1, "active", [item("inspect", "Inspect runtime", "running", "worker"), item("build", "Build fix", "pending", "main")]));
    panel.update(plan(2, "active", [item("inspect", "Inspect runtime", "completed", "worker"), item("build", "Build fix", "running", "main")]));

    expect(dock.querySelectorAll(".agent-plan-panel")).toHaveLength(1);
    expect([...dock.querySelectorAll(".agent-plan-panel-task")].map((node) => node.textContent)).toEqual(["Inspect runtime", "Build fix"]);
    expect(panel.root.querySelector("header span")?.textContent).toBe("1 of 2 done");
    expect(panel.root.querySelector('[data-task-id="build"]')?.classList.contains("running")).toBe(true);

    panel.root.querySelector<HTMLButtonElement>(".agent-plan-panel-toggle")!.click();
    expect(panel.root.classList.contains("collapsed")).toBe(true);
    expect(panel.root.querySelector<HTMLOListElement>(".agent-plan-panel-list")!.hidden).toBe(true);
    expect(panel.root.querySelector(".agent-plan-panel-toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect(panel.root.textContent).toContain("1 of 2 done");
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
    expect(panel.root.querySelectorAll("li")).toHaveLength(0);
  });
});
