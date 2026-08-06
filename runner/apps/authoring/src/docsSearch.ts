// Browser-side retrieval from the Handsontable docs assistant (DEV-2047).
//
// This runs in the page, not in our Worker, and that is deliberate: the
// docs-assistant lives on `workers.dev`, and Cloudflare blocks Worker →
// workers.dev fetches with error 1042, so the API worker cannot call it at
// all. Its `/api/search` route answers `Access-Control-Allow-Origin: *` and
// accepts no credentials, which makes the browser the supported caller.
//
// The endpoint costs no LLM tokens, but it is a real vector query (~2–4s) with
// a 40 req/min per-IP limit, so results are cached per question for the
// lifetime of the page.

const DEFAULT_SEARCH_URL = "https://hot-docs-assistant.handsontable-sandbox.workers.dev/api/search";

/** Configurable, as the docs-assistant README asks integrations to be. */
const SEARCH_URL = (import.meta.env.VITE_DOCS_SEARCH_URL as string | undefined) || DEFAULT_SEARCH_URL;

export interface DocSnippet {
  title: string;
  content: string;
  url: string | null;
  score: number;
  source?: { framework?: string; kind?: string; htVersion?: string };
}

const cache = new Map<string, DocSnippet[]>();

/** Map a runner framework key onto the four flavours the knowledge base uses. */
function flavourOf(framework: string): string {
  const key = framework.toLowerCase();
  if (key.includes("angular")) return "angular";
  if (key.includes("vue") || key.includes("nuxt")) return "vue";
  if (key.includes("react") || key.includes("next") || key.includes("remix") || key.includes("astro")) return "react";
  return "javascript";
}

/**
 * Fetch grounding chunks for a question.
 *
 * Over-requests and filters, as the endpoint's README advises: the knowledge
 * base stores each guide once per framework and has no framework filter, so a
 * naive `topK: 8` comes back as eight near-copies of three documents. Failure
 * returns an empty array — an ungrounded answer is much better than no answer.
 */
export async function searchDocs(question: string, framework: string, limit = 6): Promise<DocSnippet[]> {
  const query = question.trim().slice(0, 1000);
  if (!query) return [];
  const cacheKey = `${framework}|${query.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, topK: 20 }),
    });
    // 429 and 502 are both "try again later"; the caller carries on unaided
    // rather than making the user wait out a Retry-After.
    if (!res.ok) return [];

    const { snippets } = (await res.json()) as { snippets?: DocSnippet[] };
    const flavour = flavourOf(framework);
    const seen = new Set<string>();
    const picked: DocSnippet[] = [];

    // Same-framework chunks first, then anything framework-agnostic (blog,
    // releases) or from another flavour — the API surface is shared, so a
    // JavaScript guide still answers a React question when nothing better
    // exists.
    for (const pass of [true, false]) {
      for (const snippet of snippets ?? []) {
        if (picked.length >= limit) break;
        const sameFlavour = (snippet.source?.framework ?? "") === flavour;
        if (pass !== sameFlavour) continue;
        const key = snippet.url ?? `${snippet.title}|${snippet.content.slice(0, 80)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        picked.push(snippet);
      }
    }

    cache.set(cacheKey, picked);
    return picked;
  } catch {
    return [];
  }
}
