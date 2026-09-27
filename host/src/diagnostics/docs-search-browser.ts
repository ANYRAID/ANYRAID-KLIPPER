import type { DocsLabels } from './docs-labels.ts';
import type { searchDocs, highlightDocs, DocsSearchEntry } from './docs-search.ts';

// Serialized as a self-contained browser function by the site builder.
export function startDocsSearch(labels: DocsLabels, searchEntries: typeof searchDocs, highlight: typeof highlightDocs): void {
  const form = document.querySelector<HTMLFormElement>('#search')!;
  const input = form.querySelector<HTMLInputElement>('input')!;
  const results = document.querySelector<HTMLElement>('#results')!;
  const root = new URL(form.dataset.root!, location.href);
  let indexPromise: Promise<DocsSearchEntry[]> | undefined;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function marked(target: HTMLElement, text: string, query: string): void {
    for (const part of highlight(text, query)) {
      if (part.match) {
        const mark = document.createElement('mark');
        mark.textContent = part.text;
        target.append(mark);
      } else target.append(document.createTextNode(part.text));
    }
  }
  async function search(): Promise<void> {
    const current = ++generation;
    const query = input.value.trim().slice(0, 512);
    results.replaceChildren();
    const url = new URL(location.href);
    if (query) url.searchParams.set('q', query);
    else url.searchParams.delete('q');
    history.replaceState(null, '', url);
    if (!query) return;
    try {
      indexPromise ??= fetch(new URL('search.json', root)).then((response) => {
        if (!response.ok) throw new Error('Search unavailable');
        return response.json();
      });
      const entries = await indexPromise;
      if (current !== generation) return;
      const matches = searchEntries(entries, query);
      const list = document.createElement('ol');
      const firstTerm = query.toLowerCase().split(/\s+/u)[0];
      for (const entry of matches) {
        const li = document.createElement('li'), link = document.createElement('a');
        link.href = new URL(entry.url, root).href;
        marked(link, entry.title, query);
        li.append(link);
        const p = document.createElement('p');
        const start = Math.max(0, entry.text.toLowerCase().indexOf(firstTerm) - 70);
        marked(p, entry.text.slice(start, start + 240), query);
        li.append(p);
        list.append(li);
      }
      results.textContent = matches.length ? labels.results : labels.empty;
      results.append(list);
    } catch {
      indexPromise = undefined;
      if (current === generation) results.textContent = labels.failed;
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearTimeout(timer);
    void search();
  });
  input.addEventListener('input', () => {
    // Invalidate in-flight results immediately, before the debounce expires.
    generation++;
    clearTimeout(timer);
    timer = setTimeout(() => { void search(); }, 150);
  });
  input.maxLength = 512;
  input.value = new URL(location.href).searchParams.get('q')?.slice(0, 512) ?? '';
  if (input.value) void search();
}
