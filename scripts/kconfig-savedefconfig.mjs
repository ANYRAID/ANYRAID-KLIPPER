#!/usr/bin/env node
import {enableCompileCache} from 'node:module';
try {
    if (Number(process.versions.node.split('.')[0]) !== 26)
        throw new Error('Node.js 26 is required');
    // Enable before loading TypeScript; unavailable caches only affect speed.
    enableCompileCache();
    const {generateKconfigOutput} = await import('../host/src/kconfig/genconfig-cli.ts');
    await generateKconfigOutput('minimal');
} catch (error) {
    console.error('Kconfig generation failed: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
}
