export interface DocsSearchEntry { title: string; url: string; text: string }

// This self-contained function is emitted into the static browser bundle.
// It uses no Node APIs and has the same behavior in tests and in the site.
export function searchDocs(entries: DocsSearchEntry[], query: string): DocsSearchEntry[] {
  const normalized = query.trim().toLowerCase().replace(/\s+/gu, ' ');
  if (!normalized) return [];
  const terms = normalized.split(' ');
  const matches: { entry: DocsSearchEntry; score: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    const title = entry.title.toLowerCase();
    const body = entry.text.toLowerCase();
    if (!terms.every((term) => title.includes(term) || body.includes(term))) return;
    const score = (title === normalized ? 10000 : 0)
      + (title.includes(normalized) ? 1000 : 0)
      + terms.filter((term) => title.includes(term)).length * 100
      + (body.includes(normalized) ? 10 : 0);
    matches.push({ entry, score, index });
  });
  return matches.sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 50).map((match) => match.entry);
}
