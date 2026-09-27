import MarkdownIt from 'markdown-it';
import attrs from 'markdown-it-attrs';
import { parseDocument } from 'yaml';
import { transformDocsMarkdown } from './docs-markdown.ts';

export interface DocsHeading { level: number; id: string; text: string }
export interface DocsPage {
  title: string;
  html: string;
  headings: DocsHeading[];
  text: string;
  hideToc: boolean;
}

// Match the original site's ASCII heading IDs, including underscores and
// duplicate suffixes, so existing external deep links continue to work.
function slug(text: string): string {
  return text.normalize('NFKD').replace(/[^\x00-\x7f]/g, '')
    .replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[-\s]+/g, '-');
}

export function docsLink(href: string): string {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return href;
  return href.replace(/\.md(?=[?#]|$)/i, '.html');
}

export function renderDocsPage(source: string, repoUrl: string): DocsPage {
  let title: string | undefined, hideToc = false;
  const front = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (front) {
    const document = parseDocument(front[1]);
    if (document.errors.length) throw new Error(`Invalid documentation metadata: ${document.errors[0].message}`);
    const metadata: unknown = document.toJS({ maxAliasCount: 50 });
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error('Documentation metadata must be a mapping');
    }
    const values = metadata as Record<string, unknown>;
    if (values.title !== undefined && typeof values.title !== 'string') throw new Error('Page title must be text');
    title = values.title as string | undefined;
    if (values.hide !== undefined && (!Array.isArray(values.hide)
      || values.hide.some((value: unknown) => typeof value !== 'string'))) throw new Error('Page hide must be a list of text');
    hideToc = Array.isArray(values.hide) && values.hide.includes('toc');
    source = source.slice(front[0].length);
  }
  const parser = new MarkdownIt({ html: true, linkify: true }).use(attrs);
  parser.renderer.rules.s_open = () => '<del>';
  parser.renderer.rules.s_close = () => '</del>';
  const tokens = parser.parse(transformDocsMarkdown(source, `${repoUrl.replace(/\/+$/, '')}/`), {});
  const headings: DocsHeading[] = [], text: string[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'inline') {
      const first = token.children?.[0];
      if (tokens[index - 1]?.type === 'paragraph_open'
        && tokens[index - 2]?.type === 'list_item_open' && first?.type === 'text') {
        const checkbox = /^\[([ xX])\](?=\s)/u.exec(first.content);
        if (checkbox) {
          const input = new MarkdownIt.Token('html_inline', '', 0);
          input.content = '<input disabled="disabled" type="checkbox"'
            + (checkbox[1].toLowerCase() === 'x' ? ' checked="checked"' : '') + ' />';
          first.content = first.content.slice(3);
          token.children!.unshift(input);
        }
      }
      const plain = (token.children ?? []).map((child) =>
        ['text', 'code_inline', 'image'].includes(child.type) ? child.content
          : ['softbreak', 'hardbreak'].includes(child.type) ? ' ' : '').join('');
      text.push(plain);
      for (const child of token.children ?? []) {
        if (child.type === 'link_open') {
          const href = child.attrGet('href');
          if (href !== null) child.attrSet('href', docsLink(String(href)));
        }
      }
      const previous = tokens[index - 1];
      if (previous?.type === 'heading_open') {
        const base = String(previous.attrGet('id') ?? slug(plain));
        let id = base, suffix = 0;
        while (ids.has(id) || id === '') id = `${base}_${++suffix}`;
        ids.add(id);
        previous.attrSet('id', id);
        headings.push({ level: Number(previous.tag.slice(1)), id, text: plain });
      }
    } else if (['fence', 'code_block'].includes(token.type)) text.push(token.content);
  }
  return { title: title ?? headings[0]?.text ?? 'Documentation',
    html: parser.renderer.render(tokens, parser.options, {}), headings,
    text: text.join('\n'), hideToc };
}
