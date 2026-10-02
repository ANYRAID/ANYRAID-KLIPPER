// Compatibility preprocessing for the existing documentation dialect.
// Keep this separate from HTML rendering so code fences and list semantics
// can be checked against the original site's frozen input corpus.
const space = '[\\t-\\r \\x1c-\\x1f\\x85\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const fence = new RegExp(`${space}*\x60{3,}`, 'gu');
const trailingBreak = new RegExp(`\\\\${space}*$`, 'u');
const list = /^(?:\*|-|\p{Decimal_Number}+\.) /u;
const indentedList = new RegExp(`^${space}+(\\*|-|\\p{Decimal_Number}+\\.) `, 'u');

export interface MarkdownRewrite {
  line: number;
  before: string;
  after: string;
}

export function transformDocsMarkdown(
  markdown: string,
  repoUrl: string,
  onRewrite?: (rewrite: MarkdownRewrite) => void,
  protectedLines?: ReadonlySet<number>,
): string {
  // Python splitlines includes Unicode separators and drops one final empty
  // line. Do not use JS \s: it includes BOM but omits Python's U+001C..001F.
  const lines = markdown.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u);
  if (lines.at(-1) === '') lines.pop();
  let inCode = false, inList = false;
  for (let i = 0; i < lines.length; i++) {
    const before = lines[i];
    let after = before;
    if ([...after.matchAll(fence)].length % 2) inCode = !inCode;
    if (inCode || protectedLines?.has(i)) continue;
    // Preserve the caller-supplied repository prefix exactly, including slash
    // handling. URL policy belongs to the site configuration, not this port.
    after = after.replaceAll('](../', `](${repoUrl}blob/master/`);
    after = after.replace(trailingBreak, '<br>');
    if (/^[^-*0-9 ]/u.test(after)) inList = false;
    else if (list.test(after)) inList = true;
    if (!inList) after = after.replace(indentedList, '$1 ');
    if (after !== before) onRewrite?.({ line: i + 1, before, after });
    lines[i] = after;
  }
  return lines.join('\n');
}
