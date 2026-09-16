const http=require('http'),fs=require('fs'),path=require('path');
const {Pool}=require('pg');
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const root=path.join(__dirname,'public');
const ADMIN_TOKEN=process.env.ADMIN_TOKEN||'change-me';
const DISCORD_WEBHOOK_URL=process.env.DISCORD_WEBHOOK_URL||'';
const YOUTUBE_API_KEY=process.env.YOUTUBE_API_KEY||'';
const TWITCH_CLIENT_ID=process.env.TWITCH_CLIENT_ID||'';
const TWITCH_CLIENT_SECRET=process.env.TWITCH_CLIENT_SECRET||'';
const POLL_MS=Math.max(15000,Number(process.env.LIVE_CHECK_INTERVAL_MS||30000));
let twitchToken='',twitchTokenExpires=0;

async function init(){
 await pool.query("CREATE TABLE IF NOT EXISTS creators(id SERIAL PRIMARY KEY,name TEXT NOT NULL,username TEXT NOT NULL,platform TEXT NOT NULL DEFAULT 'Other',avatar_url TEXT DEFAULT '',profile_url TEXT DEFAULT '',live_url TEXT DEFAULT '',bio TEXT DEFAULT '',is_live BOOLEAN NOT NULL DEFAULT FALSE,live_title TEXT DEFAULT '',viewers INTEGER NOT NULL DEFAULT 0,last_checked_at TIMESTAMPTZ,last_live_at TIMESTAMPTZ,last_offline_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 await pool.query("ALTER TABLE creators ADD COLUMN IF NOT EXISTS last_live_at TIMESTAMPTZ");
 await pool.query("ALTER TABLE creators ADD COLUMN IF NOT EXISTS last_offline_at TIMESTAMPTZ");
 await pool.query("ALTER TABLE creators ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ");
}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(data))}
function auth(req){return req.headers.authorization==='Bearer '+ADMIN_TOKEN}
function body(req){return new Promise((resolve,reject)=>{let b='';req.on('data',x=>{b+=x;if(b.length>2e6)req.destroy()});req.on('end',()=>{try{resolve(JSON.parse(b||'{}'))}catch(e){reject(e)}})})}
function urlValue(u){try{return new URL(u)}catch{return null}}
async function ytLive(c){
 if(!YOUTUBE_API_KEY)return null;
 const u=urlValue(c.live_url||c.profile_url); if(!u)return null;
 let channelId=u.searchParams.get('channel_id');
 let handle=(u.pathname.match(/@([^/]+)/)||[])[1];
 if(!channelId&&u.pathname.includes('/channel/'))channelId=u.pathname.split('/channel/')[1].split('/')[0];
 if(!channelId&&handle){
  const cr=await fetch('https://www.googleapis.com/youtube/v3/channels?part=id&forHandle='+encodeURIComponent(handle)+'&key='+encodeURIComponent(YOUTUBE_API_KEY));
  if(cr.ok){const j=await cr.json();channelId=j.items?.[0]?.id}
 }
 if(!channelId)return null;
 const sr=await fetch('https://www.googleapis.com/youtube/v3/search?part=snippet&channelId='+encodeURIComponent(channelId)+'&eventType=live&type=video&maxResults=1&key='+encodeURIComponent(YOUTUBE_API_KEY));
 if(!sr.ok)return null; const j=await sr.json(); const x=j.items?.[0]; if(!x)return {is_live:false};
 return {is_live:true,live_title:x.snippet?.title||'Live sekarang',live_url:'https://www.youtube.com/watch?v='+x.id.videoId};
}
async function twitchAuth(){
 if(twitchToken&&Date.now()<twitchTokenExpires)return twitchToken;
 if(!TWITCH_CLIENT_ID||!TWITCH_CLIENT_SECRET)return null;
 const r=await fetch('https://id.twitch.tv/oauth2/token?client_id='+encodeURIComponent(TWITCH_CLIENT_ID)+'&client_secret='+encodeURIComponent(TWITCH_CLIENT_SECRET)+'&grant_type=client_credentials',{method:'POST'});
 if(!r.ok)return null; const j=await r.json(); twitchToken=j.access_token;twitchTokenExpires=Date.now()+(j.expires_in-60)*1000;return twitchToken;
}
async function twitchLive(c){
 const token=await twitchAuth(); if(!token)return null;
 const u=urlValue(c.profile_url||c.live_url); let login=c.username;
 if(u){const m=u.pathname.split('/').filter(Boolean);if(m[0]&&m[0]!=='videos')login=m[0]}
 const r=await fetch('https://api.twitch.tv/helix/streams?user_login='+encodeURIComponent(login),{headers:{'Client-ID':TWITCH_CLIENT_ID,Authorization:'Bearer '+token}});
 if(!r.ok)return null; const j=await r.json(),x=j.data?.[0]; return x?{is_live:true,live_title:x.title||'Live sekarang',live_url:'https://www.twitch.tv/'+login,viewers:x.viewer_count||0}:{is_live:false};
}
async function checkCreator(c){
 const p=String(c.platform||'').toLowerCase();
 try{
  if(p==='youtube')return await ytLive(c);
  if(p==='twitch')return await twitchLive(c);
  return null;
 }catch(e){console.error('live check',c.id,e.message);return null}
}
async function notifyDiscord(c,info){
 if(!DISCORD_WEBHOOK_URL)return;
 const content='🔴 **'+c.name+' sedang LIVE!**';
 const embed={title:c.name+' is LIVE',description:info.live_title||'Sedang live sekarang',url:info.live_url||c.live_url||c.profile_url||undefined,color:16722072,fields:[{name:'Platform',value:c.platform||'Other',inline:true},{name:'Creator',value:'@'+c.username,inline:true}]};
 try{await fetch(DISCORD_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content,embeds:[embed],allowed_mentions:{parse:[]}})})}catch(e){console.error('discord webhook',e.message)}
}
async function checkAll(){
 const q=await pool.query('SELECT * FROM creators ORDER BY id'); 
 for(const c of q.rows){
  const info=await checkCreator(c); if(!info)continue;
  const was=!!c.is_live, now=!!info.is_live;
  await pool.query('UPDATE creators SET is_live=$1,live_title=$2,live_url=COALESCE($3,live_url),viewers=$4,last_checked_at=NOW(),last_live_at=CASE WHEN $1 AND NOT is_live THEN NOW() ELSE last_live_at END,last_offline_at=CASE WHEN NOT $1 AND is_live THEN NOW() ELSE last_offline_at END,updated_at=NOW() WHERE id=$5',[now,info.live_title||'',info.live_url||null,info.viewers||0,c.id]);
  if(now&&!was)await notifyDiscord(c,info);
 }
}
function artwork(res,name){
 try{const files=name==='cassano-bg.webp'?['cassano-bg.txt']:['chunk1.txt','chunk2.txt','chunk3.txt','chunk4.txt'];const b64=files.map(x=>fs.readFileSync(path.join(root,'artwork',x),'utf8').trim()).join('');res.writeHead(200,{'Content-Type':'image/webp','Cache-Control':'public,max-age=3600'});res.end(Buffer.from(b64,'base64'))}catch(e){res.writeHead(404);res.end('Artwork not found')}}
const server=http.createServer(async(req,res)=>{
 try{
  if(req.url==='/cassano-bg.webp')return artwork(res,'cassano-bg.webp');
  if(req.url==='/cassano-group.webp')return artwork(res,'cassano-group.webp');
  if(req.url==='/api/health')return json(res,200,{ok:true,liveDetection:{youtube:!!YOUTUBE_API_KEY,twitch:!!TWITCH_CLIENT_ID&&!!TWITCH_CLIENT_SECRET,discord:!!DISCORD_WEBHOOK_URL},interval_ms:POLL_MS});
  if(req.url==='/api/creators'&&req.method==='GET'){const q=await pool.query('SELECT * FROM creators ORDER BY is_live DESC,name ASC');return json(res,200,q.rows)}
  if(req.url==='/api/stats'&&req.method==='GET'){const q=await pool.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE is_live)::int AS live,COUNT(*) FILTER(WHERE NOT is_live)::int AS offline,COUNT(*) FILTER(WHERE last_live_at IS NOT NULL)::int AS ever_live FROM creators`);const recent=await pool.query(`SELECT * FROM creators WHERE last_live_at IS NOT NULL ORDER BY last_live_at DESC LIMIT 8`);return json(res,200,{...q.rows[0],recent:recent.rows})}
  if(req.url==='/api/admin/discord-test'&&req.method==='POST'){if(!auth(req))return json(res,401,{error:'Unauthorized'});if(!DISCORD_WEBHOOK_URL)return json(res,400,{error:'DISCORD_WEBHOOK_URL belum diatur'});const r=await fetch(DISCORD_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:'🟢 **Cassano Live Hub — Test Notification**',embeds:[{title:'Discord terhubung!',description:'Notifikasi Cassano Live Hub siap digunakan.',color:5763719,footer:{text:'Cassano Live Hub'}}],allowed_mentions:{parse:[]}})});if(!r.ok)return json(res,502,{error:'Discord menolak webhook'});return json(res,200,{ok:true})}
  if(req.url==='/api/admin/login'&&req.method==='POST'){const d=await body(req);const ok=d.token===ADMIN_TOKEN;return json(res,ok?200:401,{ok})}
  if(req.url.startsWith('/api/creators')&&['POST','PUT','DELETE'].includes(req.method)){
   if(!auth(req))return json(res,401,{error:'Unauthorized'});
   const d=await body(req);
   if(req.method==='POST'){if(!d.name||!d.username)return json(res,400,{error:'name and username are required'});const q=await pool.query('INSERT INTO creators(name,username,platform,avatar_url,profile_url,live_url,bio) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[d.name,d.username,d.platform||'Other',d.avatar_url||'',d.profile_url||'',d.live_url||'',d.bio||'']);return json(res,201,q.rows[0])}
   const id=req.url.split('/').pop();
   if(req.method==='DELETE'){await pool.query('DELETE FROM creators WHERE id=$1',[id]);return json(res,200,{ok:true})}
   const q=await pool.query('UPDATE creators SET name=COALESCE($1,name),username=COALESCE($2,username),platform=COALESCE($3,platform),avatar_url=COALESCE($4,avatar_url),profile_url=COALESCE($5,profile_url),live_url=COALESCE($6,live_url),bio=COALESCE($7,bio),updated_at=NOW() WHERE id=$8 RETURNING *',[d.name,d.username,d.platform,d.avatar_url,d.profile_url,d.live_url,d.bio,id]);return json(res,200,q.rows[0]||{})
  }
  let f=req.url==='/'?'/index.html':req.url.split('?')[0];f=path.normalize(f).replace(/^\.\.(\/|\\)/,'');const file=path.join(root,f);
  fs.readFile(file,(e,data)=>{if(e){res.writeHead(404);return res.end('Not found')}const ext=path.extname(file);const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.webp':'image/webp','.png':'image/png'};res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream'});res.end(data)})
 }catch(e){console.error(e);json(res,500,{error:e.message})}
});
init().then(()=>{server.listen(process.env.PORT||10000);setTimeout(checkAll,5000);setInterval(checkAll,POLL_MS)}).catch(e=>{console.error(e);process.exit(1)});
