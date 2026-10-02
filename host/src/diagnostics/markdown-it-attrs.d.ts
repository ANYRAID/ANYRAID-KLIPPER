declare module 'markdown-it-attrs' {
  import type MarkdownIt from 'markdown-it';
  export default function attrs(parser: MarkdownIt): void;
}
