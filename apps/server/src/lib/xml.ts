export function xmlEscape(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function opdsDateFromUnix(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) {
    return new Date().toISOString();
  }
  return new Date(ts * 1000).toISOString();
}
