import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [language, definition] of Object.entries({ bash, cpp, csharp, css, go, java, javascript, json, markdown, python, rust, sql, typescript, xml, yaml })) hljs.registerLanguage(language, definition);

const LANGUAGE_ALIASES: Record<string, string> = {
  bash: "bash", sh: "bash", shell: "bash", c: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", h: "cpp", hpp: "cpp", cs: "csharp", csharp: "csharp", css: "css", go: "go", html: "xml", htm: "xml", xml: "xml", java: "java", js: "javascript", jsx: "javascript", javascript: "javascript", json: "json", md: "markdown", markdown: "markdown", mdx: "markdown", mjs: "javascript", py: "python", python: "python", rs: "rust", rust: "rust", sql: "sql", ts: "typescript", tsx: "typescript", typescript: "typescript", yaml: "yaml", yml: "yaml",
};

export function highlightSource(source: string, hint: string): { language?: string; html: string } {
  const language = sourceLanguage(hint);
  return language ? { language, html: hljs.highlight(source, { language, ignoreIllegals: true }).value } : { html: escapeHtml(source) };
}

function sourceLanguage(hint: string): string | undefined {
  const normalized = hint.toLowerCase().trim().replace(/^language-/, "");
  const extension = normalized.match(/\.([^.]+)$/)?.[1];
  return LANGUAGE_ALIASES[extension ?? normalized];
}

function escapeHtml(source: string): string { return source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
