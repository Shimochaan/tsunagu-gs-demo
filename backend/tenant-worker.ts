// 企業ごとに配布する小さなD1アクセスWorker。管理APIのトークンは一切持たない。
// DB名・テナントはブラウザーから選ばせず、認証済みAPIサーバーだけが呼び出す。
export const tenantWorkerSource = `
export default {
 async fetch(req, env) {
  const deny = () => new Response('Not found', {status:404});
  if(req.method !== 'POST' || new URL(req.url).pathname !== '/query') return deny();
  const token = req.headers.get('Authorization') || '';
  const enc = new TextEncoder();
  const [a,b] = await Promise.all([crypto.subtle.digest('SHA-256',enc.encode(token)),crypto.subtle.digest('SHA-256',enc.encode('Bearer '+env.RUNTIME_TOKEN))]);
  let diff=0; const aa=new Uint8Array(a), bb=new Uint8Array(b); for(let i=0;i<aa.length;i++) diff|=aa[i]^bb[i];
  if(diff) return deny();
  try {
   const raw=await req.text(); if(raw.length>1000000) return new Response('Too large',{status:413});
   const body=JSON.parse(raw); const registry=JSON.parse(env.DB_MAP);
   const binding=registry[body.key]; if(!binding || !env[binding]) return deny();
   if(!Array.isArray(body.queries)||body.queries.length<1||body.queries.length>100) return new Response('Invalid request',{status:400});
   const queries=body.queries.map(q=>env[binding].prepare(q.sql).bind(...(q.params||[])));
   const result=await env[binding].batch(queries);
   return Response.json(result.map(r=>({rows:r.results,changes:r.meta.changes})),{headers:{'Cache-Control':'no-store'}});
  } catch { return new Response('Database operation failed',{status:500}); }
 }
};`;
