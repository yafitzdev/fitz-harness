import { describe, expect, it } from "vitest";
import { applyPostGeneration, flattenHeadings, postGenerationRules, stripBoldMarkers, stripInlineBackticks } from "./post-generation.js";

describe("post-generation rules", () => {
  it("registers the three built-in rules, enabled by default", () => {
    expect(postGenerationRules.map((rule) => rule.id)).toEqual(["strip-inline-backticks", "strip-bold-markers", "flatten-headings"]);
    expect(postGenerationRules.every((rule) => rule.enabled)).toBe(true);
  });

  it("strips backticks from inline text", () => {
    expect(stripInlineBackticks.apply("created `docs/project-overview.html` (393 lines)")).toBe("created docs/project-overview.html (393 lines)");
    expect(stripInlineBackticks.apply("a lone ` backtick")).toBe("a lone  backtick");
  });

  it("converts bold markers to plain text", () => {
    expect(stripBoldMarkers.apply("**important** and __also__")).toBe("important and also");
    expect(stripBoldMarkers.apply("unmatched ** stays")).toBe("unmatched ** stays");
  });

  it("flattens headings to plain text", () => {
    expect(flattenHeadings.apply("### Done\nbody")).toBe("Done\nbody");
    expect(flattenHeadings.apply("#not-a-heading")).toBe("#not-a-heading");
    expect(flattenHeadings.apply("C# is not a heading")).toBe("C# is not a heading");
  });

  it("leaves fenced code blocks completely intact", () => {
    const source = "before\n```ts\nconst tick = `raw`; // **bold** # heading\n```\nafter `x`";
    expect(applyPostGeneration(source)).toBe("before\n```ts\nconst tick = `raw`; // **bold** # heading\n```\nafter x");
  });

  it("applies rules in order to a whole message", () => {
    const message = "# Summary\n\nDone — created `docs/project-overview.html` with **no** backticks.";
    expect(applyPostGeneration(message)).toBe("Summary\n\nDone — created docs/project-overview.html with no backticks.");
  });

  it("is idempotent so streamed deltas can be re-processed safely", () => {
    const message = "# Done\n\nOpen `app.ts` and run **npm install**.";
    expect(applyPostGeneration(applyPostGeneration(message))).toBe(applyPostGeneration(message));
  });

  it("can preserve inline-code delimiters for structural renderers", () => {
    expect(applyPostGeneration("Open `src/app.ts`.", { preserveInlineCode: true })).toBe("Open `src/app.ts`.");
  });
});
