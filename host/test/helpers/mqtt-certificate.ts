import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
/** Ephemeral test identity. No private key is committed or logged. */
export async function mqttCertificate(subjectAltName='IP:127.0.0.1'){
 const directory=await mkdtemp(join(tmpdir(),'mqtt-tls-'));
 try{
  const key=join(directory,'key.pem'),cert=join(directory,'cert.pem');
  await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=MQTT test peer','-addext',`subjectAltName=${subjectAltName}`],{timeout:10000});
  return {key:await readFile(key,'utf8'),cert:await readFile(cert,'utf8')};
 }finally{await rm(directory,{recursive:true,force:true});}
}
