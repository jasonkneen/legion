const HANDLE_RE = /@([a-z0-9_]{1,24})/gi;

export function parseMentions(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(HANDLE_RE)) {
    const handle = match[1]?.toLowerCase();
    if (handle) found.add(handle);
  }
  return [...found];
}

export function hasAskAll(text: string): boolean {
  return /@all\b/i.test(text);
}

export function splitMentionQuery(value: string, caret: number): {
  active: boolean;
  start: number;
  query: string;
} {
  const head = value.slice(0, caret);
  const at = head.lastIndexOf("@");
  if (at < 0) return { active: false, start: -1, query: "" };
  const before = at === 0 ? " " : head[at - 1] ?? " ";
  if (before && !/\s/.test(before)) return { active: false, start: -1, query: "" };
  const query = head.slice(at + 1);
  if (/\s/.test(query)) return { active: false, start: -1, query: "" };
  return { active: true, start: at, query };
}
