export type MemorySearchResultLike = {
  path?: string;
  score?: number;
  snippet?: string;
};

export type TrainedAnswerCandidate = {
  question: string;
  answer: string;
  path?: string;
  score: number;
  similarity: number;
};

type QaPair = {
  question: string;
  answer: string;
};

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function tokenize(input: string): Set<string> {
  const tokens = normalizeWhitespace(input)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  return new Set(tokens);
}

function jaccardSimilarity(left: string, right: string): number {
  const a = tokenize(left);
  const b = tokenize(right);
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) {
      overlap += 1;
    }
  }
  const union = a.size + b.size - overlap;
  return union > 0 ? overlap / union : 0;
}

function extractQaPairs(snippet: string): QaPair[] {
  const pairs: QaPair[] = [];
  const regex =
    /\*\*Q:\*\*\s*([\s\S]*?)\n\s*\n\*\*A:\*\*\s*([\s\S]*?)(?=\n\s*\n\*\*Insight:\*\*|\n\s*\n---|\n\s*\n\*\*Q:\*\*|$)/gi;
  for (const match of snippet.matchAll(regex)) {
    const question = normalizeWhitespace(match[1] ?? "");
    const answer = normalizeWhitespace(match[2] ?? "");
    if (!question || !answer) {
      continue;
    }
    pairs.push({ question, answer });
  }
  return pairs;
}

export function selectTrainedAnswerCandidate(params: {
  query: string;
  results: MemorySearchResultLike[];
  minScore?: number;
  minSimilarity?: number;
}): TrainedAnswerCandidate | undefined {
  const minScore = params.minScore ?? 0.2;
  const minSimilarity = params.minSimilarity ?? 0.25;
  let best: TrainedAnswerCandidate | undefined;
  let bestCombined = -1;

  for (const result of params.results) {
    const snippet = typeof result.snippet === "string" ? result.snippet : "";
    const score = typeof result.score === "number" ? result.score : 0;
    if (!snippet || score < minScore) {
      continue;
    }
    const pairs = extractQaPairs(snippet);
    for (const pair of pairs) {
      const similarity = jaccardSimilarity(params.query, pair.question);
      if (similarity < minSimilarity) {
        continue;
      }
      const combined = score + similarity * 0.4;
      if (combined <= bestCombined) {
        continue;
      }
      bestCombined = combined;
      best = {
        question: pair.question,
        answer: pair.answer,
        path: result.path,
        score,
        similarity,
      };
    }
  }

  return best;
}

export function isLikelyClarifyingQuestion(reply: string): boolean {
  const text = normalizeWhitespace(reply).toLowerCase();
  if (!text.endsWith("?")) {
    return false;
  }
  return [
    "what type of project",
    "what kind of project",
    "new deployment",
    "migration from another platform",
    "something else",
    "can you clarify",
  ].some((pattern) => text.includes(pattern));
}
