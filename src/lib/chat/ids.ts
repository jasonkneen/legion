export function newId(): string {
  return crypto.randomUUID();
}

export function slugHandle(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_]+/g, "")
    .slice(0, 24);
  return cleaned || "seat";
}

export function uniqueHandle(desired: string, taken: Set<string>): string {
  const base = slugHandle(desired);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 40; i += 1) {
    const next = `${base.slice(0, 20)}${i}`;
    if (!taken.has(next)) return next;
  }
  return `${base.slice(0, 16)}${Math.floor(Math.random() * 999)}`;
}

export function titleFromPrompt(content: string): string {
  const line = content.replace(/\s+/g, " ").replace(/@\w+/g, "").trim();
  if (!line) return "New chamber";
  return line.length > 42 ? `${line.slice(0, 40).trim()}…` : line;
}
