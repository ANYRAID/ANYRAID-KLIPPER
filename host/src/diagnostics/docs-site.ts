import { mkdir, readdir, readFile, writeFile, copyFile, realpath } from 'node:fs/promises';
import { resolve, dirname, join, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { searchDocs } from './docs-search.ts';
import { renderDocsPage, docsLink, type DocsPage } from './docs-render.ts';

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export interface SiteBuildOptions { docs: string; output: string; config: string }

function navigation(value: unknown, pages: Map<string, DocsPage>, prefix: string): string {
  if (!Array.isArray(value)) throw new Error('Site navigation must be an array');
  return '<ul>' + value.map((item) => {
    if (typeof item === 'string') {
      const page = pages.get(item);
      if (!page) throw new Error(`Navigation page missing: ${item}`);
      return `<li><a href="${escape(prefix + docsLink(item))}">${escape(page.title)}</a></li>`;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid navigation entry');
    return Object.entries(item).map(([label, children]) => `<li><span>${escape(label)}</span>${navigation(children, pages, prefix)}</li>`).join('');
  }).join('') + '</ul>';
}

const stylesheet = `:root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif}*{box-sizing:border-box}body{margin:0}a{color:light-dark(#175c9c,#80bfff)}header{padding:1rem 2rem;border-bottom:1px solid #8885;display:flex;gap:1rem;align-items:center;flex-wrap:wrap}header a{font-weight:700}input{font:inherit;padding:.4rem}#layout{display:grid;grid-template-columns:19rem minmax(0,1fr) 15rem;gap:2rem;max-width:100rem;margin:auto;padding:2rem}nav,aside{font-size:.9rem;overflow-wrap:anywhere}nav ul{list-style:none;padding-left:1rem}nav>ul{padding:0}main{min-width:0}pre{overflow:auto;padding:1rem;background:light-dark(#f1f3f5,#20272e)}code{font-family:monospace}table{display:block;overflow:auto;border-collapse:collapse}td,th{padding:.4rem .8rem;border:1px solid #8886}img{max-width:100%;height:auto;background:white}.center-image{display:block;margin:auto}h1,h2,h3,h4{scroll-margin-top:1rem}#results{padding:0 2rem;max-width:70rem;margin:auto}#results:empty{display:none}#results li{margin:1rem 0}#results p{margin:0}.skip{position:absolute;left:-9999px}.skip:focus{left:1rem;top:1rem;background:Canvas;padding:1rem}@media(max-width:1000px){#layout{grid-template-columns:15rem minmax(0,1fr)}aside{display:none}}@media(max-width:700px){#layout{display:block;padding:1rem}nav{max-height:14rem;overflow:auto;border-bottom:1px solid #8885;margin-bottom:2rem}header{padding:1rem}input{max-width:100%}}`;

const searchScript = `const searchDocs=${searchDocs.toString()};const form=document.querySelector('#search');const input=form.querySelector('input');const results=document.querySelector('#results');let indexPromise;let generation=0;async function search(){const current=++generation;const query=input.value.trim();results.replaceChildren();const url=new URL(location.href);if(query)url.searchParams.set('q',query);else url.searchParams.delete('q');history.replaceState(null,'',url);if(!query)return;try{indexPromise??=fetch(new URL('search.json',document.currentScript?.src||new URL(form.dataset.root,location.href))).then(r=>{if(!r.ok)throw Error('Search unavailable');return r.json()});const entries=await indexPromise;if(current!==generation)return;const terms=query.toLocaleLowerCase().split(/\\s+/u);let count=0;const list=document.createElement('ol');for(const entry of searchDocs(entries,query)){const li=document.createElement('li');const a=document.createElement('a');a.href=form.dataset.root+entry.url;a.textContent=entry.title;li.append(a);const p=document.createElement('p');const at=entry.text.toLocaleLowerCase().indexOf(terms[0]);p.textContent=entry.text.slice(Math.max(0,at-70),Math.max(0,at-70)+240);li.append(p);list.append(li);if(++count===50)break}results.textContent=count?'Search results':'No results';results.append(list)}catch{indexPromise=undefined;if(current===generation)results.textContent='Search unavailable; please retry.'}}form.addEventListener('submit',event=>{event.preventDefault();search()});input.value=new URL(location.href).searchParams.get('q')||'';if(input.value)search();`;

export async function buildDocsSite(options: SiteBuildOptions): Promise<{ pages: number; assets: number }> {
  const docs = await realpath(options.docs);
  const requested = resolve(options.output);
  const output = join(await realpath(dirname(requested)), requested.slice(dirname(requested).length + 1));
  // Refuse existing destinations, including symlinks. A failed build stays
  // inspectable; it cannot overwrite a previously published site or sources.
  if (output === docs || output.startsWith(docs + sep)) throw new Error('Output must be outside documentation sources');
  const configDoc = parseDocument(await readFile(options.config, 'utf8'));
  if (configDoc.errors.length) throw new Error(configDoc.errors[0].message);
  const config = configDoc.toJS({ maxAliasCount: 50 });
  if (!config || typeof config.site_name !== 'string' || typeof config.repo_url !== 'string') throw new Error('Invalid site configuration');
  const pages = new Map<string, DocsPage>(), assets: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(join(docs, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symlink in documentation: ${path}`);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== '_klipper3d') await visit(path);
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.md')) {
          if (entry.name !== 'README.md') pages.set(path, renderDocsPage(await readFile(join(docs, path), 'utf8'), config.repo_url));
        } else if (!entry.name.startsWith('.')) assets.push(path);
      }
    }
  }
  await visit('');
  if (!pages.has('index.md')) throw new Error('Missing documentation index.md');
  navigation(config.nav, pages, '');
  const generated = new Set(['site.css', 'site.js', 'search.json', ...[...pages.keys()].map(docsLink)]);
  for (const asset of assets) if (generated.has(asset)) throw new Error(`Output collision: ${asset}`);
  await mkdir(output);
  const search: { title: string; url: string; text: string }[] = [];
  for (const [path, page] of pages) {
    const prefix = '../'.repeat(path.split('/').length - 1);
    const nav = navigation(config.nav, pages, prefix);
    const toc = page.hideToc ? '' : '<ul>' + page.headings.map((heading) => `<li><a href="#${escape(heading.id)}">${escape(heading.text)}</a></li>`).join('') + '</ul>';
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(page.title)} — ${escape(config.site_name)}</title><link rel="stylesheet" href="${prefix}site.css"><link rel="icon" href="${prefix}img/favicon.ico"><script src="${prefix}site.js" defer></script></head><body><a class="skip" href="#content">Skip to content</a><header><a href="${prefix}index.html">${escape(config.site_name)}</a><form id="search" data-root="${prefix || './'}" role="search"><label>Search <input name="q" type="search"></label><button>Search</button></form><a href="${escape(config.repo_url)}">Repository</a></header><section id="results" aria-live="polite"></section><div id="layout"><nav aria-label="Documentation">${nav}</nav><main id="content">${page.html}</main><aside aria-label="On this page">${toc}</aside></div></body></html>`;
    const destination = join(output, docsLink(path));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, html);
    search.push({ title: page.title, url: docsLink(path), text: page.text });
  }
  for (const path of assets) {
    const destination = join(output, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(docs, path), destination);
  }
  await writeFile(join(output, 'site.css'), stylesheet);
  await writeFile(join(output, 'site.js'), searchScript);
  await writeFile(join(output, 'search.json'), JSON.stringify(search));
  return { pages: pages.size, assets: assets.length };
}
