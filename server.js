const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3333;

const USERS = { 'admin': 'admin123', 'tony': 'crautos2024' };
const sessions = {};
function generateToken() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function getSession(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return null;
  const s = sessions[match[1]];
  if (!s || s.expires < Date.now()) return null;
  return s;
}
function requireAuth(req, res) {
  if (getSession(req)) return true;
  res.writeHead(302, { Location: '/login.html' });
  res.end();
  return false;
}

// ── PostgreSQL ──
let db = null;
async function initDb() {
  if (!process.env.DATABASE_URL) { console.log('No DATABASE_URL — using in-memory store'); return; }
  try {
    const { Pool } = require('pg');
    db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await db.query(`
      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY,
        make TEXT, model TEXT, year INT, trans TEXT, fuel TEXT,
        style TEXT, drive TEXT, color TEXT, province TEXT, engine TEXT,
        km INT DEFAULT 0, km_unit TEXT DEFAULT 'km',
        price_c BIGINT DEFAULT 0, price_u INT DEFAULT 0,
        negotiable BOOLEAN DEFAULT FALSE, description TEXT, url TEXT,
        first_seen TIMESTAMPTZ DEFAULT NOW(),
        last_seen TIMESTAMPTZ DEFAULT NOW(),
        times_seen INT DEFAULT 1,
        price_history JSONB DEFAULT '[]',
        days_listed INT DEFAULT 0,
        is_sold BOOLEAN DEFAULT FALSE
      )`);
    console.log('PostgreSQL connected');
  } catch(e) { console.error('DB error:', e.message); db = null; }
}

// ── in-memory fallback ──
const mem = {};

async function upsertListing(car) {
  const price = car.priceC || (car.priceU * 482) || 0;
  const now = new Date().toISOString();
  if (db) {
    try {
      const ex = await db.query('SELECT price_c,price_history,first_seen,times_seen FROM listings WHERE id=$1', [car.id]);
      let ph = [], firstSeen = now, timesSeen = 1;
      if (ex.rows.length) {
        const r = ex.rows[0];
        ph = r.price_history || [];
        firstSeen = r.first_seen;
        timesSeen = r.times_seen + 1;
        if (parseInt(r.price_c) !== price && price > 0)
          ph = [...ph.slice(-19), { price: parseInt(r.price_c), date: now }];
      }
      const days = Math.floor((Date.now() - new Date(firstSeen).getTime()) / 86400000);
      await db.query(`
        INSERT INTO listings (id,make,model,year,trans,fuel,style,drive,color,province,engine,km,km_unit,price_c,price_u,negotiable,description,url,first_seen,last_seen,times_seen,price_history,days_listed)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
        ON CONFLICT (id) DO UPDATE SET last_seen=$20,times_seen=$21,price_history=$22,price_c=$14,price_u=$15,negotiable=$16,description=$17,km=$12,days_listed=$23,is_sold=FALSE`,
        [car.id,car.make,car.model,car.year,car.trans,car.fuel,car.style,car.drive||'',
         car.color,car.province,car.engine||'',car.km,car.kmUnit||'km',price,car.priceU||0,
         car.negotiable||false,car.desc||'',car.url,firstSeen,now,timesSeen,JSON.stringify(ph),days]);
      car.daysListed = days; car.priceHistory = ph; car.firstSeen = firstSeen;
    } catch(e) { console.error('upsert:', e.message); }
  } else {
    const ex = mem[car.id];
    car.firstSeen = ex ? ex.firstSeen : now;
    car.daysListed = Math.floor((Date.now() - new Date(car.firstSeen).getTime()) / 86400000);
    car.priceHistory = ex ? ex.priceHistory || [] : [];
    if (ex && ex.priceC !== price && price > 0)
      car.priceHistory = [...car.priceHistory.slice(-19), { price: ex.priceC, date: now }];
    mem[car.id] = { ...car, lastSeen: now };
  }
}

async function getMarketStats(make, model, year) {
  let prices = [];
  if (db) {
    try {
      const r = await db.query(
        `SELECT price_c FROM listings WHERE LOWER(make)=$1 AND LOWER(model) LIKE $2 AND ($3=0 OR ABS(year-$3)<=3) AND price_c>100000 AND last_seen>NOW()-INTERVAL '90 days'`,
        [make.toLowerCase(), '%'+model.toLowerCase().split(' ')[0]+'%', year||0]);
      prices = r.rows.map(x=>parseInt(x.price_c)).filter(p=>p>0);
    } catch(e) {}
  } else {
    prices = Object.values(mem)
      .filter(c=>c.make?.toLowerCase()===make.toLowerCase()&&c.model?.toLowerCase().includes(model.toLowerCase().split(' ')[0]))
      .map(c=>c.priceC||(c.priceU*482)).filter(p=>p>100000);
  }
  if (prices.length < 2) return null;
  prices.sort((a,b)=>a-b);
  // trim top 10% outliers
  const trimmed = prices.slice(0, Math.max(2, Math.floor(prices.length*0.9)));
  const avg = Math.round(trimmed.reduce((a,b)=>a+b,0)/trimmed.length);
  const median = trimmed[Math.floor(trimmed.length/2)];
  return { avg, median, min: prices[0], max: prices[prices.length-1], count: prices.length };
}

function decodeEntities(str) {
  return str.replace(/&cent;/g,'¢').replace(/&aacute;/g,'á').replace(/&eacute;/g,'é')
    .replace(/&iacute;/g,'í').replace(/&oacute;/g,'ó').replace(/&uacute;/g,'ú')
    .replace(/&ntilde;/g,'ñ').replace(/&Aacute;/g,'Á').replace(/&Eacute;/g,'É')
    .replace(/&Iacute;/g,'Í').replace(/&Oacute;/g,'Ó').replace(/&Uacute;/g,'Ú')
    .replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/&#[0-9]+;/g,'').trim();
}

function fetchUrl(targetUrl) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept':'text/html,*/*;q=0.8','Accept-Language':'es-CR,es;q=0.9','Accept-Encoding':'identity','Connection':'keep-alive' } };
    const lib = targetUrl.startsWith('https') ? https : http;
    const req = lib.get(targetUrl, opts, (r) => {
      if (r.statusCode>=300&&r.statusCode<400&&r.headers.location) return fetchUrl(r.headers.location).then(resolve).catch(reject);
      let d=''; r.setEncoding('latin1');
      r.on('data',c=>d+=c); r.on('end',()=>resolve(d));
    });
    req.on('error',reject);
    req.setTimeout(12000,()=>{req.destroy();reject(new Error('Timeout'));});
  });
}

function extractIds(html) {
  const ids=[], seen=new Set(), re=/cardetail\.cfm\?c=(\d+)/gi; let m;
  while((m=re.exec(html))!==null) if(!seen.has(m[1])){seen.add(m[1]);ids.push(m[1]);}
  return ids;
}

function parseExtract(html, id) {
  const d = decodeEntities(html);
  const tM = d.match(/<title[^>]*>\s*(?:crautos\.com\s+)?([^<]+?)\s*<\/title>/i);
  const raw = tM ? tM[1].replace(/\s+/g,' ').trim() : '';
  let make='',model='',year=0;
  const tp = raw.match(/^([A-Za-záéíóúñÁÉÍÓÚÑ\-]+)\s+([A-Za-z0-9áéíóúñ\s\-\/\.]+?)\s+(\d{4})\s*[¢\$]/);
  if (tp) { make=tp[1].trim(); model=tp[2].trim(); year=parseInt(tp[3]); }
  else {
    const ws=raw.replace(/[¢\$].*/,'').trim().split(/\s+/); make=ws[0]||'';
    const yi=ws.map(w=>/^\d{4}$/.test(w)).lastIndexOf(true);
    if(yi>0){model=ws.slice(1,yi).join(' ');year=parseInt(ws[yi]);}else model=ws.slice(1).join(' ');
  }
  let priceC=0,priceU=0;
  const cM=d.match(/¢\s*\r?\n?\s*(\d[\d,\.]+)/);
  if(cM){const v=parseInt(cM[1].replace(/[,\.]/g,'').slice(0,9));if(v>=200000&&v<=999999999)priceC=v;}
  const uM=d.match(/\$\s*([\d,]+)\s*\(/); if(uM)priceU=parseInt(uM[1].replace(/,/g,''))||0;
  let km=0,kmUnit='km';
  const kM=d.match(/Kilometraje[\s\S]{1,80}?([\d][\d,\.]+)\s*(kms?|millas?)/i);
  if(kM){const v=parseInt(kM[1].replace(/[,\.]/g,''));const u=kM[2].toLowerCase();if(v>0&&v<1000000){kmUnit=u.startsWith('mill')?'miles':'km';km=u.startsWith('mill')?Math.round(v*1.60934):v;}}
  const td=(f)=>{const m=d.match(new RegExp(f+'<\\/td>[\\s\\S]{1,40}?<td[^>]*>\\s*([^<\\n]{1,60}?)\\s*<\\/td>','i'));return m?m[1].trim():'';}
  const trans=td('Transmisi[oó]n'),style=td('Estilo'),fuel=td('Combustible');
  const color=td('Color exterior'),province=td('Provincia'),engine=td('Cilindrada');
  const driveRaw=td('Tracci[oó]n');
  const drive=driveRaw||(style.includes('4WD')||style.includes('AWD')||style.includes('4x4')?'4x4':'');
  const nM=d.match(/Precio negociable<\/td>[\s\S]{1,40}?<td[^>]*>\s*([^<\n]{1,5}?)\s*<\/td>/i);
  const negotiable=nM?nM[1].trim().toUpperCase()==='SI':false;
  const deM=d.match(/Equipamiento<\/td>[\s\S]{1,40}?<td[^>]*>\s*([^<]{10,500}?)\s*<\/td>/i);
  const desc=deM?deM[1].replace(/\s+/g,' ').trim().slice(0,300):'';
  if(!make)return null;
  return {id,make,model,year,trans,fuel,style,drive,color,province,engine,km,kmUnit,priceC,priceU,negotiable,desc,url:'https://crautos.com/autosusados/cardetail.cfm?c='+id};
}

function analyzeDescription(desc, car) {
  const txt=(desc||'').toLowerCase(); const ins=[]; let adj=0;
  if(['urgente','viaje','traslado','necesito vender','emigro','me voy','liquidación'].some(k=>txt.includes(k))){adj+=8;ins.push({t:'Seller urgency',pos:true});}
  if(txt.includes('negociable')||car.negotiable){adj+=4;ins.push({t:'Negotiable',pos:true});}
  const issues=['falla','problema','golpe','choque','accidente','inyector','no arranca','no prende','humo','vibra','necesita reparación','daño'];
  const fi=issues.filter(k=>txt.includes(k));
  if(fi.length>0){adj-=(fi.length*8);ins.push({t:'Mechanical issues mentioned',pos:false});}
  if(txt.includes('full extras')||txt.includes('full equipo')){adj+=5;ins.push({t:'Full extras',pos:true});}
  if(txt.includes('único dueño')||txt.includes('un dueño')){adj+=4;ins.push({t:'Single owner',pos:true});}
  if(txt.includes('poco kilometraje')||txt.includes('bajo kilometraje')){adj+=4;ins.push({t:'Low mileage noted',pos:true});}
  if(car.kmUnit==='miles'){adj-=6;ins.push({t:'Listed in miles (penalty)',pos:false});}
  return {adj,ins};
}

function calcFlipScore(car, market) {
  if(!market||market.count<2)return null;
  const price=car.priceC||(car.priceU*482)||0; if(!price)return null;
  let score=50; const ins=[];
  const pctBelow=(market.avg-price)/market.avg;
  score+=Math.max(-40,Math.min(40,Math.round(pctBelow*130)));
  if(pctBelow>=0.2)ins.push({t:`${Math.round(pctBelow*100)}% below avg`,pos:true});
  else if(pctBelow<-0.1)ins.push({t:'Above market avg',pos:false});
  const age=new Date().getFullYear()-(car.year||2000);
  if(age<=3){score+=14;ins.push({t:`${car.year} — recent`,pos:true});}
  else if(age<=6)score+=8; else if(age<=10)score+=3; else if(age>15){score-=8;ins.push({t:'15+ years old',pos:false});}
  if(car.km>0){
    if(car.km<30000){score+=14;ins.push({t:`${car.km.toLocaleString()} km — very low`,pos:true});}
    else if(car.km<60000){score+=9;ins.push({t:`${car.km.toLocaleString()} km — low`,pos:true});}
    else if(car.km<100000)score+=4; else if(car.km<150000)score-=3;
    else{score-=10;ins.push({t:`${car.km.toLocaleString()} km — high`,pos:false});}
  }
  if(car.priceHistory&&car.priceHistory.length>0){score+=10;ins.push({t:'Price dropped since listed',pos:true});}
  const days=car.daysListed||0;
  if(days>30){score+=8;ins.push({t:`${days} days listed — motivated seller`,pos:true});}
  else if(days>15){score+=5;ins.push({t:`${days} days — room to negotiate`,pos:true});}
  const drv=(car.drive||car.style||'').toLowerCase();
  if(drv.includes('4wd')||drv.includes('awd')||drv.includes('4x4')){score+=5;ins.push({t:'4WD/AWD',pos:true});}
  const ai=analyzeDescription(car.desc||'',car);
  score+=ai.adj; ins.push(...ai.ins);
  if(market.min>0&&price<=market.min*1.05){score+=7;ins.push({t:'Near lowest market price',pos:true});}
  if(market.count<4)score-=5;
  if((car.trans||'').toLowerCase().includes('auto'))score+=3;
  score=Math.max(0,Math.min(100,Math.round(score)));
  const savings=Math.max(0,market.avg-price);
  const estProfit=Math.round(savings*0.75);
  return {score,insights:ins,market,savings,estProfit,profitMin:Math.round(estProfit*0.7),profitMax:Math.round(estProfit*1.3),pctBelow:Math.round(pctBelow*100)};
}

function matchesFilters(car, f) {
  if(f.make&&!car.make.toLowerCase().includes(f.make)&&!car.model.toLowerCase().includes(f.make))return false;
  if(f.model){const h=(car.make+' '+car.model).toLowerCase();if(!f.model.toLowerCase().split(/\s+/).every(w=>h.includes(w)))return false;}
  if(f.trans&&car.trans&&!car.trans.toLowerCase().includes(f.trans.toLowerCase()))return false;
  if(f.fuel&&car.fuel&&!car.fuel.toLowerCase().includes(f.fuel.toLowerCase()))return false;
  if(car.year){if(f.ymin&&car.year<parseInt(f.ymin))return false;if(f.ymax&&car.year>parseInt(f.ymax))return false;}
  const p=car.priceC||(car.priceU*482);
  if(p>0){if(f.pmin&&p<parseInt(f.pmin))return false;if(f.pmax&&p>parseInt(f.pmax))return false;}
  if(f.kmmax&&car.km>0&&car.km>parseInt(f.kmmax))return false;
  return true;
}

async function scanOnePage(pageNum, filters) {
  const html = await fetchUrl(`https://crautos.com/autosusados/index.cfm?page=${pageNum}`);
  const ids = extractIds(html);
  if(!ids.length)return{cars:[],ids:0,done:true};
  const cars=[];
  for(let i=0;i<ids.length;i+=8){
    const batch=ids.slice(i,i+8);
    const results=await Promise.allSettled(batch.map(async id=>{
      const h=await fetchUrl(`https://crautos.com/autosusados/extract.cfm?c=${id}`);
      return parseExtract(h,id);
    }));
    for(const r of results){
      if(r.status==='fulfilled'&&r.value){
        const car=r.value;
        await upsertListing(car);
        if(matchesFilters(car,filters)){
          const market=await getMarketStats(car.make,car.model,car.year);
          car.flipScore=calcFlipScore(car,market);
          cars.push(car);
        }
      }
    }
    if(i+8<ids.length)await new Promise(r=>setTimeout(r,300));
  }
  return{cars,ids:ids.length,done:false};
}

let isFullScanRunning=false, lastFullScan=null, fullScanProgress={page:0,total:0};
async function runFullScan() {
  if(isFullScanRunning)return;
  isFullScanRunning=true;
  console.log('Full scan started — scanning ALL pages');
  let page=1,total=0,emptyStreak=0;
  try {
    while(true){
      fullScanProgress={page,total};
      const {ids,done}=await scanOnePage(page,{});
      total+=ids;
      if(done||ids===0){ emptyStreak++; if(emptyStreak>=3)break; }
      else emptyStreak=0;
      page++;
      // log progress every 10 pages
      if(page%10===0) console.log(`Full scan progress: page ${page}, ${total} listings so far`);
      await new Promise(r=>setTimeout(r,500));
    }
    lastFullScan=new Date().toISOString();
    console.log(`Full scan done: ${total} listings across ${page} pages`);
  } catch(e){console.error('Full scan error:',e.message);}
  isFullScanRunning=false;
}
// run full scan every hour
setInterval(runFullScan,3600000);
// first scan 15s after startup
setTimeout(runFullScan,15000);

function setCORS(res){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');}

const server = http.createServer(async (req,res)=>{
  setCORS(res);
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  const ru=new URL(req.url,`http://localhost:${PORT}`);
  const pn=ru.pathname; const q=Object.fromEntries(ru.searchParams.entries());

  if(pn==='/api/login'&&req.method==='POST'){
    let body=''; req.on('data',c=>body+=c);
    req.on('end',()=>{
      try{
        const {username,password}=JSON.parse(body);
        if(USERS[username]&&USERS[username]===password){
          const t=generateToken(); sessions[t]={user:username,expires:Date.now()+86400000};
          res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':`session=${t}; Path=/; HttpOnly; Max-Age=86400`});
          res.end(JSON.stringify({ok:true,user:username}));
        }else{res.writeHead(401);res.end(JSON.stringify({ok:false,error:'Invalid credentials'}));}
      }catch(e){res.writeHead(400);res.end(JSON.stringify({ok:false,error:'Bad request'}));}
    }); return;
  }
  if(pn==='/api/logout'){
    const cm=req.headers.cookie?.match(/session=([^;]+)/); if(cm)delete sessions[cm[1]];
    res.writeHead(302,{'Set-Cookie':'session=; Path=/; Max-Age=0',Location:'/login.html'});res.end();return;
  }
  if(pn==='/login.html'||pn==='/login'){
    const fp=path.join(__dirname,'public','login.html');
    if(fs.existsSync(fp)){res.writeHead(200,{'Content-Type':'text/html'});return res.end(fs.readFileSync(fp));}
  }
  if(pn==='/'&&!getSession(req)){res.writeHead(302,{Location:'/login.html'});res.end();return;}
  if(pn!=='/'&&pn!=='/login.html'&&!requireAuth(req,res))return;

  if(pn==='/health'){
    const s=getSession(req);
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({ok:true,uptime:process.uptime().toFixed(0)+'s',dbConnected:!!db,lastFullScan,isScanning:isFullScanRunning,scanProgress:fullScanProgress,totalInMemory:Object.keys(mem).length,user:s?s.user:null}));
  }

  if(pn==='/scan'){
    const filters={make:(q.make||'').toLowerCase().trim(),model:(q.model||'').toLowerCase().trim(),trans:q.trans||'',fuel:q.fuel||'',ymin:q.ymin,ymax:q.ymax,pmin:q.pmin,pmax:q.pmax,kmmax:q.kmmax};
    const totalPages=parseInt(q.totalPages)||3, page=parseInt(q.page)||1;
    try{
      const allCars=[];let totalIds=0;
      for(let pg=page;pg<page+totalPages;pg++){
        const {cars,ids,done}=await scanOnePage(pg,filters);
        allCars.push(...cars);totalIds+=ids;
        if(done)break;
        if(pg<page+totalPages-1)await new Promise(r=>setTimeout(r,400));
      }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,count:allCars.length,totalIds,cars:allCars}));
    }catch(e){res.writeHead(500);res.end(JSON.stringify({ok:false,error:e.message}));}
    return;
  }

  if(pn==='/hotflips'){
    try{
      let cars=[];
      if(db){
        const r=await db.query(`SELECT * FROM listings WHERE price_c>100000 AND last_seen>NOW()-INTERVAL '48 hours' ORDER BY last_seen DESC LIMIT 300`);
        cars=r.rows.map(r=>({id:r.id,make:r.make,model:r.model,year:r.year,trans:r.trans,fuel:r.fuel,style:r.style,drive:r.drive,province:r.province,engine:r.engine,km:r.km,kmUnit:r.km_unit,priceC:parseInt(r.price_c),priceU:r.price_u,negotiable:r.negotiable,desc:r.description,url:r.url,daysListed:r.days_listed,priceHistory:r.price_history||[],firstSeen:r.first_seen}));
      }else{
        cars=Object.values(mem).filter(c=>(c.priceC||(c.priceU*482))>100000);
      }
      const scored=[];
      for(const car of cars){
        const market=await getMarketStats(car.make,car.model,car.year);
        const flip=calcFlipScore(car,market);
        if(flip&&flip.score>=55)scored.push({...car,flipScore:flip});
      }
      scored.sort((a,b)=>b.flipScore.score-a.flipScore.score);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,count:scored.length,cars:scored.slice(0,60)}));
    }catch(e){res.writeHead(500);res.end(JSON.stringify({ok:false,error:e.message}));}
    return;
  }

  if(pn==='/debug'){
    try{
      if(q.type==='extract'&&q.id){
        const h=await fetchUrl(`https://crautos.com/autosusados/extract.cfm?c=${q.id}`);
        const car=parseExtract(h,q.id);
        res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({ok:true,parsed:car},null,2));
      }
      const pg=parseInt(q.page)||1;
      const h=await fetchUrl(`https://crautos.com/autosusados/index.cfm?page=${pg}`);
      const ids=extractIds(h);
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({ok:true,idsFound:ids.length,ids:ids.slice(0,10)},null,2));
    }catch(e){res.writeHead(500);res.end(JSON.stringify({ok:false,error:e.message}));}
    return;
  }

  // static files
  let sn=pn==='/'||pn===''?'/index.html':pn;
  const fp=path.join(__dirname,'public',sn.replace(/^\//,''));
  if(fs.existsSync(fp)){
    const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css'}[path.extname(fp)]||'text/plain';
    res.writeHead(200,{'Content-Type':mime});return res.end(fs.readFileSync(fp));
  }
  res.writeHead(404);res.end('Not found');
});

server.listen(PORT,'0.0.0.0',async()=>{
  console.log(`\n✅ CRautos Bot running at http://localhost:${PORT}\n`);
  await initDb();
});
