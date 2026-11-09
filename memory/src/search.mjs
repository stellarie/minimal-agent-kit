const TOKEN = /[\p{L}\p{N}_]+/gu;
const MAX_HITS_PER_FIELD = 3;
const WEIGHTS = { title: 3, tags: 2, body: 1 };

export function tokenize(text) {
  return (String(text ?? "").toLowerCase().match(TOKEN) ?? []).filter(
    (token) => token.length >= 2,
  );
}

function fieldScore(queryToken, fieldTokens) {
  let exact = 0;
  let prefix = 0;
  for (const token of fieldTokens) {
    if (token === queryToken) exact++;
    else if (queryToken.length >= 3 && token.startsWith(queryToken)) prefix++;
  }
  return Math.min(exact, MAX_HITS_PER_FIELD) + 0.5 * Math.min(prefix, MAX_HITS_PER_FIELD);
}

export function scoreMemory(query, memory) {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return 0;
  const fields = {
    title: tokenize(memory.title),
    tags: tokenize(memory.tags.join(" ")),
    body: tokenize(memory.body),
  };
  let score = 0;
  for (const token of queryTokens) {
    for (const [name, tokens] of Object.entries(fields)) {
      score += WEIGHTS[name] * fieldScore(token, tokens);
    }
  }
  const phrase = String(query).trim().toLowerCase();
  if (phrase && memory.title.toLowerCase().includes(phrase)) score += 5;
  return score;
}

export function snippet(query, memory, width = 160) {
  const tokens = tokenize(query);
  const lines = memory.body.split("\n").map((line) => line.trim()).filter(Boolean);
  const hit =
    lines.find((line) => tokens.some((token) => line.toLowerCase().includes(token))) ??
    lines[0] ??
    "";
  return hit.length > width ? `${hit.slice(0, width - 3)}...` : hit;
}
