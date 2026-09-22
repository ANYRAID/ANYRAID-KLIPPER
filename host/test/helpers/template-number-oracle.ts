import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export function templateNumberOracle():string{
 const reference=JSON.parse(readFileSync(new URL('../../contracts/jinja-numeric-filters.json',import.meta.url),'utf8'));
 if(createHash('sha256').update(reference.source).digest('hex')!==reference.sourceSha256)throw new Error('Jinja numeric filter source hash mismatch');
 return 'from __future__ import annotations\nimport json,math,struct,sys,typing as t\nFilterArgumentError=ValueError\n'+reference.source+'\n';
}
