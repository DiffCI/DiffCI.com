import S3rver from '/work/s3/node_modules/s3rver/lib/s3rver.js';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
const start=performance.now();
const path='/evidence/linux-safe-prebuild-observation.json';
const observation=JSON.parse(readFileSync(path,'utf8'));
const expected=['test/driver-dependencies.test.ts','test/driver-types.test.ts','test/drivers/db0.test.ts','test/drivers/s3-list.test.ts','test/drivers/s3.test.ts'];
if(observation.status!=='OBSERVED'||observation.result.mode!=='SELECTIVE'||observation.result.graph.confidence!=='COMPLETE'||JSON.stringify(observation.result.selectedTests)!==JSON.stringify(expected))throw Error('Unexpected selection');
const pkg=JSON.parse(readFileSync('/work/unstorage/package.json','utf8'));
if(pkg.scripts.test!=='pnpm lint && pnpm test:types && vitest run --coverage'||pkg.scripts.pretest||pkg.scripts.posttest)throw Error('Unexpected validation scope');
const pnpm='corepack pnpm@11.21.0';
const full=`${pnpm} build && ${pnpm} test --maxWorkers=1`;
const selected=`${pnpm} build && ${pnpm} lint && ${pnpm} test:types && ${pnpm} exec vitest run --typecheck.only --maxWorkers=1 && ${pnpm} exec vitest run --coverage --maxWorkers=1 ${expected.join(' ')}`;
const planningMs=performance.now()-start;
mkdirSync('/work/s3/comparison-data',{recursive:true});
const server=new S3rver({address:'127.0.0.1',port:4569,silent:true,vhostBuckets:false,directory:'/work/s3/comparison-data',configureBuckets:[{name:'diffci-test'}]});
const deleteObject=server.store.deleteObject.bind(server.store);let deletion=Promise.resolve();
server.store.deleteObject=(...args)=>{const next=deletion.then(()=>deleteObject(...args));deletion=next.catch(()=>{});return next;};
await server.run();
Object.assign(process.env,{CI:'true',VITE_S3_ACCESS_KEY_ID:'S3RVER',VITE_S3_SECRET_ACCESS_KEY:'S3RVER',VITE_S3_BUCKET:'diffci-test',VITE_S3_ENDPOINT:'http://s3.us-east-1.amazonaws.com:4569',VITE_S3_REGION:'us-east-1'});
writeFileSync('/evidence/safe-command-scope.json',JSON.stringify({full,selected,planningMs,auxiliaryTypeTests:4,s3Tests:34,alwaysRunGuards:expected.slice(0,3),fixturePatch:'Avoid reopening ephemeral databases after their test driver has disposed them; keep persistent MySQL cleanup',emulator:'s3rver@3.7.1; serialized filesystem cleanup',preBuildAnalysis:true,maxWorkers:1,cacheReset:['node_modules/.vite','node_modules/.cache/vitest']},null,2));
// Run the synchronous measurement in a child so the emulator keeps serving requests.
const {spawn}=await import('node:child_process');
const options={full,selectedFromReport:path,selectedCommandOverride:selected,out:'/evidence/linux-safe-savings.json',markdown:'/evidence/linux-safe-savings.md',label:'Unstorage: unpublished DiffCI, Linux, local S3 emulator, one worker, full source and declaration guards',cwd:'/work/unstorage',timeoutMs:180000,tailBytes:20000,repetitions:3,alternateOrder:true,cacheState:'cold',cachePreparationCommand:'node /evidence/reset-vitest-cache.mjs',analysisOverheadMs:observation.timings.totalMs+(observation.timings.preObserveMs??0)+planningMs};
writeFileSync('/evidence/comparison-options.json',JSON.stringify(options));
const code="import {readFileSync} from 'node:fs';import {runVerifySavings,writeVerifySavingsReport} from '/work/diffci/node_modules/@diffci.com/diffci/dist-client/src/client/verify-savings.js';const o=JSON.parse(readFileSync('/evidence/comparison-options.json','utf8'));const r=runVerifySavings(o);writeVerifySavingsReport(r,o);console.log(JSON.stringify(r.comparison,null,2));process.exitCode=r.comparison.evidenceValid?0:1;";
try{const child=spawn(process.execPath,['--input-type=module','-e',code],{env:process.env,stdio:'inherit'});process.exitCode=await new Promise(resolve=>child.on('exit',resolve));}finally{await server.close();}
