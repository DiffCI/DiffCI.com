export function diagnosticPage(): Response {
  const nonce = crypto.randomUUID();
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Public repository diagnostic · DiffCI</title>
<style>body{font:16px/1.6 system-ui;max-width:760px;margin:50px auto;padding:0 20px;color:#17212b;background:#f8fafc}input[type=text]{width:90%;padding:12px}button{padding:10px 16px;margin:12px 8px 12px 0;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:20px;background:white;border:1px solid #ddd}label{display:block;margin:18px 0}.note{color:#526170}</style>
<h1>Public repository diagnostic</h1><p>Check whether a public GitHub repository has a recognizable starting point for DiffCI.</p>
<p class="note">This reads root metadata and up to three manifests at one pinned commit. It does not build a dependency graph, execute tests, install dependencies or measure savings. No private repositories or GitHub credentials.</p>
<form id="form"><label>Public GitHub repository<input type="text" id="repo" required maxlength="180" placeholder="https://github.com/owner/repository"></label>
<label><input type="checkbox" id="consent" required> I request this public metadata check and consent to DiffCI fetching these files from GitHub. Access expires after 24 hours; stored results are removed by the next cleanup run. This does not enroll the repository in monitoring.</label>
<button id="start">Run diagnostic</button></form><button id="refresh" hidden>Check status</button><button id="remove" hidden>Delete result</button>
<p id="status" role="status"></p><pre id="result" hidden></pre>
<p class="note">Results require a private access token kept only in this page's memory. Refreshing or closing the page loses access. The result expires within 24 hours. Rate-limit counters contain a rotating keyed identifier, not your raw IP address.</p>
<script nonce="${nonce}">
const el=id=>document.getElementById(id);let job;
async function read(){if(!job)return;const r=await fetch('/v1/public-analyzer/jobs/'+job.id,{headers:{Authorization:'Bearer '+job.token}});const d=await r.json();el('status').textContent=d.status||d.error; if(d.result){el('result').hidden=false;el('result').textContent=JSON.stringify(d.result,null,2);}}
el('form').addEventListener('submit',async e=>{e.preventDefault();el('start').disabled=true;el('status').textContent='Requesting diagnostic…';try{const r=await fetch('/v1/public-analyzer/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({repository:el('repo').value,consent:el('consent').checked,consentVersion:'public-metadata-v1'})});const d=await r.json();if(!r.ok)throw new Error(d.error);job=d;el('refresh').hidden=false;el('remove').hidden=false;el('status').textContent='Queued. Check status shortly; recovery runs every ten minutes.';}catch(e){el('status').textContent=e.message;el('start').disabled=false;}});
el('refresh').onclick=()=>read().catch(()=>el('status').textContent='Could not load status. Retry shortly.');
el('remove').onclick=async()=>{try{const r=await fetch('/v1/public-analyzer/jobs/'+job.id,{method:'DELETE',headers:{Authorization:'Bearer '+job.token}});if(!r.ok)throw new Error();job=null;el('result').textContent='';el('result').hidden=true;el('remove').hidden=true;el('refresh').hidden=true;el('start').disabled=false;el('status').textContent='Deleted.';}catch{el('status').textContent='Deletion could not be confirmed. Retry.'}};
</script></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` } });
}
