import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
/** Matches make_version.py's version-only use of util.get_git_version(False). */
export async function packageVersion(repository:string,distro:string,git='git'):Promise<string> {
 if(/[\x00-\x1f\x7f]/.test(distro))throw new RangeError('Distribution name contains control characters');
 let version='?';
 try {
  const {stdout}=await execute(git,['-C',repository,'describe','--always','--tags','--long','--dirty'],{encoding:'utf8',timeout:10000,maxBuffer:1048576});
  version=stdout.trim();
 }catch{/* Source archives and unavailable Git retain the original '?' fallback. */}
 return version+'-'+distro.replaceAll(' ','');
}
