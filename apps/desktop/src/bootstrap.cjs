const { writeFileSync } = require("node:fs");
if (process.argv.includes("--smoke-test")) {
  if (process.env.FITZ_DESKTOP_SMOKE_OUTPUT) writeFileSync(process.env.FITZ_DESKTOP_SMOKE_OUTPUT, "FITZ_DESKTOP_SMOKE_OK\n", { encoding: "utf8", flag: "wx" });
  process.exit(0);
}
void import("./main.js");
