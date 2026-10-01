import {publishedPath,gcodesDirectory} from '../storage/published-paths.ts';
import {ApiError} from './rpc.ts';
export function nativeFilename(value:unknown):string{try{return publishedPath(value);}catch{throw new ApiError(400,'Invalid native filename');}}
export function nativeDirectory(value:unknown='gcodes'):string{try{return gcodesDirectory(value);}catch{throw new ApiError(400,'Invalid gcodes directory');}}
export function nativeDownloadFilename(raw:string):string{
 if(!raw.startsWith('/server/files/gcodes/'))throw new ApiError(404,'Native download not found');
 let value:string;try{value=decodeURIComponent(raw.slice('/server/files/gcodes/'.length));}catch{throw new ApiError(400,'Invalid download path');}
 return nativeFilename(value);
}
