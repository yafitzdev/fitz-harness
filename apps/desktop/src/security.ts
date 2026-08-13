const ALLOWED_PREFIXES = ["/v1/", "/api/v1/"];
export function validateHostUrl(value: string): URL { const url = new URL(value); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Host URL must use HTTP or HTTPS"); return url; }
export function validateRequestPath(value: string): string { if (!value.startsWith("/") || value.startsWith("//") || !(value === "/health" || ALLOWED_PREFIXES.some((prefix) => value.startsWith(prefix)))) throw new Error("Desktop bridge request path is not allowed"); return value; }
export function isAllowedExternalUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:"; } catch { return false; } }
export function requireInAppBrowserUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Browser URL must be a string");
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw new Error("Browser URL must use HTTP or HTTPS without embedded credentials");
  return url.toString();
}
