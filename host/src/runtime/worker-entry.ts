/** Resolve a colocated worker in either the TypeScript checkout or JS build.
 * Runtime URLs are not rewritten by TypeScript's import extension rewriting. */
export function workerEntry(name:`./${string}.ts`,parent:string):URL{
 return new URL(new URL(parent).pathname.endsWith('.js')?name.slice(0,-3)+'.js':name,parent);
}
