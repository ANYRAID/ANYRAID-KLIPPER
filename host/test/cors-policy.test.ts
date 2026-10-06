import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {CorsPolicy} from '../src/moonraker/cors-policy.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {readAuthorizationOptions} from '../src/moonraker/authorization-config.ts';
const bytes=readFileSync(new URL('../contracts/moonraker-cors-reference.json',import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),'a1d13f275b648203e36e6ec4a4d723e763c7fefbefaa3d707282862e20756742');
const reference=JSON.parse(bytes.toString());
for(const [i,c] of reference.cases.entries())test('pinned CORS patterns and numeric fallback '+i,()=>{
 const warnings:string[]=[],policy=new CorsPolicy(c.domains,c.trusted,message=>warnings.push(message));
 for(const [index,origin] of c.origins.entries()){
  let canonical=false;try{const url=new URL(origin);canonical=['http:','https:'].includes(url.protocol)&&url.origin===origin;}catch{}
  assert.equal(policy.matches(origin),canonical&&c.expected[index],JSON.stringify({origin,domains:c.domains}));
 }
 assert.equal(warnings.length,c.warnings.length);
 warnings.forEach((warning,index)=>assert.equal(warning.includes('top level domain'),c.warnings[index].includes('top level domain')));
});
test('CORS configuration consumes origins without granting client trust or ignoring bad patterns',()=>{
 const reader=new ConfigurationReader(new ConfigurationSource('/config/main.conf',{DEFAULT:{},server:{},authorization:{cors_domains:'https://*.example.com\nhttps://example.*\nhttps://front.example/' }},[]));
 const options=readAuthorizationOptions(reader,'http://printer.test');assert.ok(options.cors?.matches('https://fluidd.example.com'));assert.equal(options.trustedClients,undefined);assert.equal(reader.warnings().length,2);assert.equal(reader.validate().length,2);
 for(const patterns of [['['],['http://(?=x)'],['https://front.example\n'],Array(129).fill('*')])assert.throws(()=>new CorsPolicy(patterns));
 const policy=new CorsPolicy(['*']);for(const origin of ['null','file:///tmp/a','http://user:pass@front.example','https://front.example/path','https://front.example#hash','https://front.example?query','https://front.example:443','https://front.example/','https://FRONT.example','x'.repeat(1025)])assert.equal(policy.matches(origin),false,origin);
});
