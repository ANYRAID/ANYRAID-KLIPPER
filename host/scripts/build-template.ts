import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,copyFileSync,renameSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const host=fileURLToPath(new URL('..',import.meta.url));
if(process.platform!=='linux')throw new Error('Native template candidate is currently validated on Linux only');
const local=resolve(host,'node_modules/.cache/cargo/bin/cargo'),cargo=process.env.CARGO??(existsSync(local)?local:'cargo');
const env={...process.env,CARGO_TARGET_DIR:process.env.CARGO_TARGET_DIR??resolve(host,'node_modules/.cache/template-target'),...(cargo===local?{CARGO_HOME:process.env.CARGO_HOME??resolve(host,'node_modules/.cache/cargo'),RUSTUP_HOME:process.env.RUSTUP_HOME??resolve(host,'node_modules/.cache/rustup')}:{})};
const build=spawnSync(cargo,['build','--release','--locked','--manifest-path',resolve(host,'native/template/Cargo.toml')],{env,stdio:'inherit',timeout:300000});if(build.status!==0)throw new Error('Native template build failed: '+(build.error??build.status));
const output=resolve(host,'build/template.node'),temporary=output+'.tmp';mkdirSync(dirname(output),{recursive:true});try{copyFileSync(resolve(env.CARGO_TARGET_DIR,'release/libanyraid_template.so'),temporary);renameSync(temporary,output);}finally{rmSync(temporary,{force:true});}
