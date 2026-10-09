import {parentPort,workerData} from 'node:worker_threads';
import {parseAnnouncementFeed} from './announcements-rss.ts';
try {parentPort!.postMessage({ok:true,value:parseAnnouncementFeed(workerData.xml,workerData.now)});}
catch {parentPort!.postMessage({ok:false});}
parentPort!.close();
