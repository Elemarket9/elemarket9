export type QueryIntent = {
  normalized: string;
  wantsAvailability: boolean;
  wantsNewest: boolean;
  valueSeeking: boolean;
  priceCeiling?: number;
  priceFloor?: number;
  hardPriceCeiling?: number;
  hardPriceFloor?: number;
  brandHint?: string;
  categoryHints: string[];
};

const STOP = new Set(["a","an","the","for","me","with","and","or","to","of","in","on","best","good","buy","get","find","show"]);
export type IntentVocabulary = { brands?: string[]; categories?: string[] };

export function normalizeDiscoveryQuery(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[“”‘’]/g, "'").replace(/[^\p{L}\p{N}.'+/_\-\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export function classifyQueryIntent(value: string, vocabulary: IntentVocabulary = {}): QueryIntent {
  // Parse currency before lexical normalization removes the cedi symbol.
  const money = value.normalize("NFKC").toLowerCase().replace(/gh₵|₵/g, "ghs ").replace(/(\d),(?=\d{3}(?:\D|$))/g, "$1");
  const amount = "([0-9]+(?:\\.[0-9]+)?)(?![\\p{L}\\p{N}.])";
  const ceiling = money.match(new RegExp("\\b(?:under|below|less than|up to|max(?:imum)?(?: price)?)\\s*(?:ghs\\s*)?" + amount, "u"));
  const budget = money.match(new RegExp("\\bbudget\\s*(?:ghs\\s*)?" + amount, "u"));
  const floor = money.match(new RegExp("\\b(?:over|above|more than|min(?:imum)?(?: price)?)\\s*(?:ghs\\s*)?" + amount, "u"));
  const range = money.match(new RegExp("\\bbetween\\s*(?:ghs\\s*)?" + amount + "\\s+and\\s*(?:ghs\\s*)?" + amount + "(?:\\s*(?:cedis|ghs)\\b)?", "u"));
  const explicit = money.match(new RegExp("\\bghs\\s*" + amount, "u")) ?? money.match(new RegExp("\\b" + amount + "\\s*cedis\\b", "u"));
  const numeric = (raw: string | undefined) => raw != null && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : undefined;
  const lexical = money.replace(new RegExp("\\bbetween\\s*(?:ghs\\s*)?" + amount + "\\s+and\\s*(?:ghs\\s*)?" + amount + "(?:\\s*(?:cedis|ghs)\\b)?", "gu"), " ")
    .replace(new RegExp("\\b(?:under|below|less than|up to|budget|max(?:imum)?(?: price)?|over|above|more than|min(?:imum)?(?: price)?)\\s*(?:ghs\\s*)?" + amount + "(?:\\s*cedis)?", "gu"), " ")
    .replace(new RegExp("\\bghs\\s*" + amount + "|\\b" + amount + "\\s*cedis\\b", "gu"), " ")
    .replace(/\b(?:in stock|available|newest|latest|new arrivals?)\b/g, " ");
  const normalized = normalizeDiscoveryQuery(lexical);
  const contains = (term: string) => (` ${normalized} `).includes(` ${normalizeDiscoveryQuery(term)} `);
  const brands = (vocabulary.brands ?? []).filter(contains).sort((a,b)=>b.length-a.length);
  return {
    normalized,
    wantsAvailability: /\b(?:available|in stock|ready|today)\b/.test(money),
    wantsNewest: /\b(?:newest|latest|new arrival|new arrivals|recent)\b/.test(money),
    valueSeeking: /\b(?:cheap|cheapest|budget|affordable|value|deal|deals)\b/.test(money),
    priceCeiling: numeric(range?.[2] ?? ceiling?.[1] ?? budget?.[1] ?? (!floor ? explicit?.[1] : undefined)),
    priceFloor: numeric(range?.[1] ?? floor?.[1]),
    hardPriceCeiling: numeric(range?.[2] ?? ceiling?.[1] ?? (!floor ? explicit?.[1] : undefined)),
    hardPriceFloor: numeric(range?.[1] ?? floor?.[1]),
    brandHint: brands[0],
    categoryHints: (vocabulary.categories ?? []).filter(contains),
  };
}

export function meaningfulTokens(value: string): string[] {
  return [...new Set(normalizeDiscoveryQuery(value).split(" ").filter((t) => t.length > 1 && !STOP.has(t)))].slice(0, 24);
}


/** Conservative typo recovery: one unique edit against validated vocabulary only. */
export function correctDiscoveryQuery(query: string, vocabulary: IntentVocabulary): string {
  const terms = [...new Set([...(vocabulary.brands ?? []), ...(vocabulary.categories ?? [])]
    .map(normalizeDiscoveryQuery).filter(t => /^[\p{L}]{5,40}$/u.test(t)))];
  const near = (a: string, b: string) => {
    if (Math.abs(a.length-b.length)>1) return false;
    if (a.length===b.length) {
      const differences = [...a].flatMap((c,i)=>c!==b[i]?[i]:[]);
      return differences.length===1 || (differences.length===2 && differences[1]===differences[0]+1 && a[differences[0]]===b[differences[1]] && a[differences[1]]===b[differences[0]]);
    }
    const shorter=a.length<b.length?a:b, longer=a.length<b.length?b:a;
    let i=0,j=0,skips=0;
    while(i<shorter.length && j<longer.length) {
      if(shorter[i]===longer[j]){i++;j++;}else{j++;if(++skips>1)return false;}
    }
    return true;
  };
  return query.split(' ').map(token=>{
    if(!/^[\p{L}]{5,40}$/u.test(token)||terms.includes(token))return token;
    const candidates=terms.filter(term=>near(token,term));
    return candidates.length===1?candidates[0]:token;
  }).join(' ');
}
