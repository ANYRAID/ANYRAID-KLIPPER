#!/usr/bin/env node
// Package version generator; replaces make_version.py (GPL-3.0-or-later).
// Original Copyright (C) 2018 Lucas Fink <software@lfcode.ca>.
import {fileURLToPath} from 'node:url';
import {packageVersion} from '../host/src/build/version.ts';
const usage='Usage: node scripts/make_version.mts [--] DISTRONAME';
let args=process.argv.slice(2);
if(args.length===1&&(args[0]==='-h'||args[0]==='--help'))console.log(usage);
else {
 if(args[0]==='--')args=args.slice(1);
 else if(args.some(a=>a.startsWith('-')&&a!=='-')){console.error(usage);process.exit(2);}
 if(args.length!==1){console.error(usage);process.exit(2);}
 try{console.log(await packageVersion(fileURLToPath(new URL('../',import.meta.url)),args[0]));}
 catch(error){console.error(error instanceof Error?error.message:'Unable to generate package version');process.exitCode=2;}
}
