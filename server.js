const http=require('http'),fs=require('fs'),path=require('path');
const {Pool}=require('pg');
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const root=path.join(__dirname,'public');
const ADMIN_TOKEN=process.env.ADMIN_TOKEN||'change-me';

async function init(){
  await pool.query("CREATE TABLE IF NOT EXISTS creators(id SERIAL PRIMARY KEY,name TEXT NOT NULL,username TEXT NOT NULL,platform TEXT NOT NULL DEFAULT 'Other',avatar_url TEXT DEFAULT '',profile_url TEXT DEFAULT '',live_url TEXT DEFAULT '',bio TEXT DEFAULT '',is_live BOOLEAN NOT NULL DEFAULT FALSE,live_title TEXT DEFAULT '',viewers INTEGER NOT NULL DEFAULT 0,last_checked_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data))}
function auth(req){return req.headers.authorization==='Bearer '+ADMIN_TOKEN}
function body(req){return new Promise((resolve,reject)=>{let b='';req.on('data',x=>b+=x);req.on('end',()=>{try{resolve(JSON.parse(b||'{}'))}catch(e){reject(e)}})})}

const server=http.createServer(async(req,res)=>{
 try{
  if(req.url==='/api/creators'&&req.method==='GET'){
   const q=await pool.query('SELECT * FROM creators ORDER BY is_live DESC,name ASC');return json(res,200,q.rows)
  }
  if(req.url==='/api/admin/login'&&req.method==='POST'){
   const d=await body(req);const ok=d.token===ADMIN_TOKEN;return json(res,ok?200:401,{ok})
  }
  if(req.url.startsWith('/api/creators')&&['POST','PUT','DELETE'].includes(req.method)){
   if(!auth(req))return json(res,401,{error:'Unauthorized'});
   const d=await body(req);
   if(req.method==='POST'){
    if(!d.name||!d.username)return json(res,400,{error:'name and username are required'});
    const q=await pool.query('INSERT INTO creators(name,username,platform,avatar_url,profile_url,live_url,bio) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[d.name,d.username,d.platform||'Other',d.avatar_url||'',d.profile_url||'',d.live_url||'',d.bio||'']);
    return json(res,201,q.rows[0]);
   }
   const id=req.url.split('/').pop();
   if(req.method==='DELETE'){await pool.query('DELETE FROM creators WHERE id=$1',[id]);return json(res,200,{ok:true})}
   const q=await pool.query('UPDATE creators SET name=COALESCE($1,name),username=COALESCE($2,username),platform=COALESCE($3,platform),avatar_url=COALESCE($4,avatar_url),profile_url=COALESCE($5,profile_url),live_url=COALESCE($6,live_url),bio=COALESCE($7,bio),updated_at=NOW() WHERE id=$8 RETURNING *',[d.name,d.username,d.platform,d.avatar_url,d.profile_url,d.live_url,d.bio,id]);
   return json(res,200,q.rows[0]||{});
  }
  let f=req.url==='/'?'/index.html':req.url.split('?')[0];
  f=path.normalize(f).replace(/^\.\.(\/|\\)/,'');
  const file=path.join(root,f);
  fs.readFile(file,(e,data)=>{
   if(e){res.writeHead(404);return res.end('Not found')}
   const ext=path.extname(file);
   const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript'};
   res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream'});res.end(data)
  });
 }catch(e){console.error(e);json(res,500,{error:e.message})}
});
init().then(()=>server.listen(process.env.PORT||10000)).catch(e=>{console.error(e);process.exit(1)});