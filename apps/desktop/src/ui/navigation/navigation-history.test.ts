import { describe, expect, it, vi } from "vitest";
import { NavigationHistoryController } from "./navigation-history.js";

describe("NavigationHistoryController", () => {
  it("deduplicates entries and replays backward and forward", async () => {
    const replay = vi.fn();
    const history = new NavigationHistoryController({ blocked: () => false, replay });
    history.remember({ view: "conversation", sessionId: "one" });
    history.remember({ view: "conversation", sessionId: "one" });
    history.remember({ view: "connections" });
    await history.navigate(-1);
    await history.navigate(1);
    expect(replay.mock.calls).toEqual([
      [{ view: "conversation", sessionId: "one" }],
      [{ view: "connections" }],
    ]);
  });

  it("drops forward history after a new location and blocks navigation during runs", async () => {
    let blocked = false;
    const replay = vi.fn();
    const history = new NavigationHistoryController({ blocked: () => blocked, replay });
    history.remember({ view: "conversation", sessionId: "one" });
    history.remember({ view: "connections" });
    await history.navigate(-1);
    history.remember({ view: "plugins" });
    await history.navigate(1);
    expect(replay).toHaveBeenCalledOnce();
    blocked = true;
    await history.navigate(-1);
    expect(replay).toHaveBeenCalledOnce();
  });

  it("does not record locations emitted while replaying", async () => {
    let history!: NavigationHistoryController;
    const replay = vi.fn(async (location) => history.remember(location));
    history = new NavigationHistoryController({ blocked: () => false, replay });
    history.remember({ view: "conversation", sessionId: "one" });
    history.remember({ view: "connections" });
    await history.navigate(-1);
    await history.navigate(1);
    expect(replay).toHaveBeenCalledTimes(2);
  });
});
