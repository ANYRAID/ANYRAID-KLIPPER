import type { Token } from 'markdown-it';

// The legacy documentation dialect uses a two-space child-list indentation,
// even after ordered markers whose CommonMark content column is wider.
// CommonMark parses such children as a following list. Reattach only when
// source indentation proves that it belongs to the preceding final item.
export function restoreDocsListNesting(tokens: Token[], source: string): void {
  const lines = source.split('\n');
  const indentation = (line: number) => /^ */.exec(lines[line] ?? '')![0].length;
  for (const token of tokens) {
    if (token.type === 'ordered_list_open' && token.attrs) {
      token.attrs = token.attrs.filter(([name]) => name !== 'start');
    }
  }
  for (let index = 0; index < tokens.length; index++) {
    const child = tokens[index];
    if (!['bullet_list_open', 'ordered_list_open'].includes(child.type) || !child.map) continue;
    if (tokens[index - 1]?.type !== 'ordered_list_close'
      || tokens[index - 2]?.type !== 'list_item_close') continue;
    let depth = 1, parentIndex = index - 2;
    for (; parentIndex >= 0; parentIndex--) {
      if (tokens[parentIndex].type === 'ordered_list_close') depth++;
      if (tokens[parentIndex].type === 'ordered_list_open') {
        depth--;
        if (depth === 0) break;
      }
    }
    const parent = tokens[parentIndex];
    if (!parent?.map || indentation(child.map[0]) < indentation(parent.map[0]) + 2) continue;
    let end = index, childDepth = 0;
    for (; end < tokens.length; end++) {
      if (['bullet_list_open', 'ordered_list_open'].includes(tokens[end].type)) childDepth++;
      if (['bullet_list_close', 'ordered_list_close'].includes(tokens[end].type)) childDepth--;
      if (childDepth === 0) break;
    }
    if (end === tokens.length) continue;
    for (let cursor = index; cursor <= end; cursor++) tokens[cursor].level += 2;
    parent.map[1] = child.map[1];
    const closing = tokens.splice(index - 2, 2);
    tokens.splice(end - 1, 0, ...closing);
    index -= 2;
  }
  // The legacy ordered-list processor resumes a list across adjacent blocks.
  for (let index = 1; index < tokens.length; index++) {
    if (tokens[index - 1].type === 'ordered_list_close'
      && tokens[index].type === 'ordered_list_open') {
      tokens.splice(index - 1, 2);
      index--;
    }
  }

}
