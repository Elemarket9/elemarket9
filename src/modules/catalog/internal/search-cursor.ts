/** Page predicate for price and newest search. Parentheses must stay balanced. */
export function nonRelevanceCursorPredicate(
  sort: "price_asc" | "price_desc" | "newest",
  lane: string,
  key: string,
  score: string,
  id: string,
): string {
  const op = sort === "price_asc" ? ">" : "<";
  return `where (_key${op}${key} or (_key=${key} and (_lane<${lane} or (_lane=${lane} and (_score<${score} or (_score=${score} and id>${id}))))))`;
}
