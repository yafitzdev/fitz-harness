const { writeFileSync } = require("node:fs");
if (process.argv.includes("--smoke-test") || process.env.FITZ_DESKTOP_SMOKE === "1") {
  if (process.env.FITZ_DESKTOP_SMOKE_OUTPUT) writeFileSync(process.env.FITZ_DESKTOP_SMOKE_OUTPUT, "FITZ_DESKTOP_SMOKE_OK\n", { encoding: "utf8", flag: "wx" });
  process.exit(0);
}
void import("./main.js");
