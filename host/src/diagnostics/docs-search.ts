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

export function highlightDocs(text: string, query: string): { text: string; match: boolean }[] {
  const terms = [...new Set(query.trim().slice(0, 512).split(/\s+/u).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length) return [{ text, match: false }];
  const pattern = new RegExp(terms.join('|'), 'giu');
  const parts: { text: string; match: boolean }[] = [];
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > position) parts.push({ text: text.slice(position, match.index), match: false });
    parts.push({ text: match[0], match: true });
    position = match.index + match[0].length;
  }
  if (position < text.length) parts.push({ text: text.slice(position), match: false });
  return parts;
}
