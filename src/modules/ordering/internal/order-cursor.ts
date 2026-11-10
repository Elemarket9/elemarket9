/** Keyset cursor for customer orders. Timestamp alone drops rows created together. */
export function formatOrderCursor(createdAt: string, id: string): string {
  return `${createdAt}|${id}`;
}

export function parseOrderCursor(cursor: string | null | undefined): { at: string | null; id: string | null } {
  if (!cursor) return { at: null, id: null };
  const pipe = cursor.lastIndexOf("|");
  if (pipe <= 0) return { at: cursor, id: null };
  const at = cursor.slice(0, pipe);
  const id = cursor.slice(pipe + 1);
  if (!at || !id || id.length > 128) return { at: cursor, id: null };
  return { at, id };
}
