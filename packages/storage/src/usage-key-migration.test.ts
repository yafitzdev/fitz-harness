import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "./migrations.js";

describe("usage API-key migration", () => {
  it("purges usage that is not mapped to an active API key", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE devices (id TEXT PRIMARY KEY);
      CREATE TABLE request_usage (id TEXT PRIMARY KEY, owner_device_id TEXT);
      INSERT INTO devices (id) VALUES ('active-key');
      INSERT INTO request_usage (id, owner_device_id) VALUES
        ('active', 'active-key'),
        ('missing', NULL),
        ('deleted', 'deleted-key');
    `);

    database.exec(MIGRATIONS.find((migration) => migration.version === 33)!.sql);

    expect(database.prepare(`SELECT id FROM request_usage ORDER BY id`).all()).toEqual([
      expect.objectContaining({ id: "active" }),
    ]);
    database.close();
  });
});
