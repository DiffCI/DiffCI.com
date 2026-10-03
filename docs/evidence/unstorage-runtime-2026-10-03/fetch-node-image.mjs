import {mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const dir=new URL('./node-image/',import.meta.url);mkdirSync(dir,{recursive:true});
const auth=await fetch('https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull').then(r=>r.json());
const headers={Authorization:`Bearer ${auth.token}`,Accept:'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json'};
async function get(path){const r=await fetch(`https://registry-1.docker.io/v2/library/node/${path}`,{headers});if(!r.ok)throw Error(`${r.status} ${path}`);return r;}
const index=await (await get('manifests/24.16.0-bookworm-slim')).json();
const desc=index.manifests.find(x=>x.platform.os==='linux'&&x.platform.architecture==='amd64');
const manifest=await (await get(`manifests/${desc.digest}`)).json();
writeFileSync(new URL('manifest.json',dir),JSON.stringify({digest:desc.digest,manifest},null,2));
for(let i=0;i<manifest.layers.length;i++){const layer=manifest.layers[i];const bytes=Buffer.from(await (await get(`blobs/${layer.digest}`)).arrayBuffer());if(`sha256:${createHash('sha256').update(bytes).digest('hex')}`!==layer.digest)throw Error('digest mismatch');writeFileSync(new URL(`layer-${i}.tar.gz`,dir),bytes);console.log(`Verified layer ${i}: ${bytes.length} bytes`);}
