// One-time migration to the unified dev data root (FITZ_DATA_ROOT=<repo>/data).
//
// Before this change the ninfer dev host kept its store at data/fitz-ninfer.db and the pi
// packages lived in %LOCALAPPDATA%\Fitz Codex\pi. The unified layout the host now derives
// from FITZ_DATA_ROOT is:
//   data/database/fitz.db   sessions + transcript store
//   data/pi/                pi agent dir (extensions/registry.json, settings.json)
//   data/logs/  data/cache/ logs and cache
//
// The script is idempotent and never overwrites data: it migrates the legacy database into
// the unified location (checkpointing first so the copy is self-consistent), verifies the
// copy, then renames the legacy files to *.pre-unify so nothing is lost. It also seeds
// data/pi/ from the packaged app's pi dir when the dev root has no registry yet.
//
// Opt-in cleanup of the packaged app's pi dir (npm/, stale fitz.db, stale settings.json):
//   node scripts/migrate-dev-data.mjs --cleanup-appdata-pi
// Renames those leftovers to *.pre-unify-removed instead of deleting them.

import { existsSync, mkdirSync, copyFileSync, cpSync, renameSync, readdirSync, statSync, rmSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devDataRoot = join(root, "data");
const legacyDb = join(devDataRoot, "fitz-ninfer.db");
const targetDb = join(devDataRoot, "database", "fitz.db");
const TARGET_SESSION_ID = "e9bedbf2-8ab2-4144-8023-59de90503896";
const cleanupAppDataPi = process.argv.includes("--cleanup-appdata-pi");

migrateDatabase();
seedPiDir();
if (cleanupAppDataPi) cleanupAppDataPiDir();

function migrateDatabase() {
  const sourceExists = existsSync(legacyDb);
  const targetSessions = targetSessionsCount();
  if (sourceExists && targetSessions !== null && targetSessions > 0) {
    console.log(`[database] already migrated: ${targetDb} holds ${targetSessions} session(s). Nothing to do.`);
    return;
  }
  if (!sourceExists) {
    console.log(targetSessions === null
      ? "[database] no legacy store found (data/fitz-ninfer.db); the unified store will be created on first host start."
      : `[database] unified store already in place at ${targetDb} (${targetSessions} session(s)).`);
    return;
  }

  console.log(`[database] migrating ${legacyDb} -> ${targetDb}`);
  checkpointLegacyDb();

  if (existsSync(targetDb)) {
    console.log("[database] target exists but holds no sessions; replacing the empty placeholder store.");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(targetDb + suffix, { force: true });
  }
  mkdirSync(dirname(targetDb), { recursive: true });
  copyFileSync(legacyDb, targetDb);

  const verified = verifyTargetDb();
  if (!verified || !verified.found) {
    rmSync(targetDb, { force: true });
    console.error("[database] verification failed after copy; removed the new store and left the legacy DB untouched.");
    console.error("Fix the failure and re-run this script.");
    process.exit(1);
  }
  console.log(`[database] verified: ${verified.sessions} session(s) copied, ${TARGET_SESSION_ID} present.`);

  for (const suffix of ["", "-wal", "-shm"]) {
    const source = legacyDb + suffix;
    if (existsSync(source)) {
      try {
        renameSync(source, source + ".pre-unify");
        console.log(`[database] renamed ${source} -> ${source}.pre-unify`);
      } catch (error) {
        console.warn(`[database] could not rename ${source}: ${error.message} (the copy is already verified; safe to delete by hand).`);
      }
    }
  }
}

function checkpointLegacyDb() {
  let db;
  try {
    db = new DatabaseSync(legacyDb);
  } catch (error) {
    console.error(`[database] cannot open ${legacyDb}: ${error.message}`);
    console.error("A dev host may still be running against it. Stop it first, then re-run this script.");
    process.exit(1);
  }
  try {
    const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (result && Number(result.busy) > 0) {
      console.error(`[database] ${legacyDb} is busy (checkpoint returned busy=${result.busy}). A dev host is likely still running. Stop it first.`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`[database] cannot checkpoint ${legacyDb}: ${error.message}`);
    console.error("A dev host may still be running against it. Stop it first, then re-run this script.");
    process.exit(1);
  } finally {
    db.close();
  }
}

function targetSessionsCount() {
  if (!existsSync(targetDb)) return null;
  try {
    const db = new DatabaseSync(targetDb, { readOnly: true });
    try {
      return Number(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function verifyTargetDb() {
  const db = new DatabaseSync(targetDb, { readOnly: true });
  try {
    const sessions = Number(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n);
    const found = db.prepare("SELECT 1 AS x FROM sessions WHERE id = ?").get(TARGET_SESSION_ID);
    return { sessions, found: Boolean(found) };
  } finally {
    db.close();
  }
}

function appDataPiDir() {
  if (process.platform !== "win32") return undefined;
  const localAppData = process.env.LOCALAPPDATA;
  return localAppData ? join(localAppData, "Fitz Codex", "pi") : undefined;
}

function seedPiDir() {
  const devRegistry = join(devDataRoot, "pi", "extensions", "registry.json");
  if (existsSync(devRegistry)) {
    console.log("[pi] dev registry already present at " + devRegistry + "; nothing to seed.");
    return;
  }
  const appPi = appDataPiDir();
  if (!appPi || !existsSync(join(appPi, "extensions"))) {
    console.log("[pi] no packaged-app pi dir found to seed from; data/pi will be created fresh on first host start.");
    return;
  }
  mkdirSync(join(devDataRoot, "pi"), { recursive: true });
  cpSync(join(appPi, "extensions"), join(devDataRoot, "pi", "extensions"), { recursive: true });
  console.log(`[pi] copied ${appPi}\\extensions -> ${devDataRoot}\\pi\\extensions`);
  const settings = join(appPi, "settings.json");
  if (existsSync(settings)) {
    copyFileSync(settings, join(devDataRoot, "pi", "settings.json"));
    console.log(`[pi] copied ${appPi}\\settings.json -> ${devDataRoot}\\pi\\settings.json`);
  }
}

function cleanupAppDataPiDir() {
  const devRegistry = join(devDataRoot, "pi", "extensions", "registry.json");
  if (!existsSync(devRegistry)) {
    console.error("[cleanup] refusing: the dev registry does not exist yet. Run the migration first so data/pi mirrors the packaged pi dir.");
    process.exit(1);
  }
  const appPi = appDataPiDir();
  if (!appPi || !existsSync(appPi)) {
    console.log("[cleanup] no packaged-app pi dir to clean.");
    return;
  }

  const registry = readJson(join(devRegistry)) ?? { packages: [] };
  const registryNames = new Set((Array.isArray(registry.packages) ? registry.packages : [])
    .filter((entry) => entry && typeof entry.name === "string")
    .map((entry) => entry.name));

  const npmDir = join(appPi, "npm");
  if (existsSync(npmDir)) {
    const uncovered = readdirSync(npmDir).filter((name) => !registryNames.has(name));
    if (uncovered.length > 0) {
      console.warn(`[cleanup] npm/ has packages not covered by the registry (never loaded, but kept for safety): ${uncovered.join(", ")}`);
    }
    const covered = readdirSync(npmDir).filter((name) => registryNames.has(name));
    console.log(`[cleanup] registry covers ${covered.length} of ${readdirSync(npmDir).length} npm/ entries; renaming npm/ (recoverable).`);
    renameKeep(join(appPi, "npm"), "npm", "pre-unify-removed");
  }

  const staleDb = join(appPi, "fitz.db");
  if (existsSync(staleDb)) {
    const size = statSync(staleDb).size;
    if (size === 0) {
      renameKeep(staleDb, "fitz.db", "pre-unify-removed");
    } else {
      console.warn(`[cleanup] skipping ${staleDb}: it holds ${size} bytes. Inspect it before removing.`);
    }
  }

  renameKeep(join(appPi, "settings.json.pre-terminal-merge"), "settings.json.pre-terminal-merge", "pre-unify-removed");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function renameKeep(target, label, suffix) {
  if (!existsSync(target)) return;
  try {
    const renamed = `${target}.${suffix}`;
    renameSync(target, renamed);
    console.log(`[cleanup] renamed ${label} -> ${renamed}`);
  } catch (error) {
    console.warn(`[cleanup] could not rename ${label}: ${error.message}`);
    console.warn(`[cleanup] a process (e.g. the packaged app) may hold a handle on it. Close it and re-run, or remove by hand — ${label} is never loaded by Fitz.`);
  }
}
