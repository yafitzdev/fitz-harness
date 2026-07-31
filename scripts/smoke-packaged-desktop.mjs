import { resolve } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
const executable = resolve("apps/desktop/release/win-unpacked/Fitz Codex.exe"); const marker = resolve(tmpdir(), `fitz-desktop-smoke-${randomUUID()}.txt`); const child = spawn(executable, [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FITZ_DESKTOP_SMOKE: "1", FITZ_DESKTOP_SMOKE_OUTPUT: marker } }); let exited; let stderr = ""; child.once("exit", (code) => { exited = code; }); child.stderr.on("data", (chunk) => { stderr += String(chunk); }); try { for (let attempt = 0; attempt < 100 && !existsSync(marker) && exited === undefined; attempt += 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, 200)); if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== "FITZ_DESKTOP_SMOKE_OK") throw new Error(`Packaged desktop smoke failed (exit=${exited ?? "timeout"}): ${stderr}`); process.stdout.write("FITZ_PACKAGED_DESKTOP_SMOKE_OK\n"); } finally { child.kill(); if (existsSync(marker)) rmSync(marker); }
