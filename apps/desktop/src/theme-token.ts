import { readFileSync } from "node:fs";

/** Resolve a hex color from the renderer's CSS token register for native chrome. */
export function readThemeColor(path: string, token: string): string {
  const source = readFileSync(path, "utf8");
  const declarations = new Map<string, string>();
  for (const match of source.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1];
    const value = match[2];
    if (name && value) declarations.set(name, value.trim());
  }

  const resolve = (name: string, seen = new Set<string>()): string => {
    if (seen.has(name)) throw new Error(`Circular theme token: ${name}`);
    const value = declarations.get(name);
    if (!value) throw new Error(`Missing theme token: ${name}`);
    const reference = value.match(/^var\((--[a-zA-Z0-9-]+)\)$/)?.[1];
    if (reference) return resolve(reference, new Set([...seen, name]));
    if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`Theme token ${name} must resolve to a six-digit hex color`);
    return value;
  };

  return resolve(token);
}
