import {rmSync} from 'node:fs';
// Fixed paths in the owned evaluation clone; keep dependency and MongoDB caches.
for(const path of ['/work/unstorage/node_modules/.vite','/work/unstorage/node_modules/.cache/vitest'])rmSync(path,{recursive:true,force:true});
