const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3333;

// ── users (add/remove users here) ──
const USERS = {
  'admin': 'admin123',
  'tony':  'crautos2024',
};

// ── active sessions: token -> { user, expires } ──
const sessions = {};
function generateToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
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
  // redirect to login
  res.writeHead(302, { Location: '/login.html' });
  res.end();
  return false;
}

// ── price history ──
let priceHistory = {};
const HISTORY_FILE = path.join(__dirname, 'price_history.json');
if (fs.existsSync(HISTORY_FILE)) {
  try { priceHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) {}
}
function saveHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(priceHistory, null, 2));
}

// ── fetch any URL ──
function fetchUrl(targetUrl) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'es-CR,es;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
      }
    };
    const lib = targetUrl.startsWith('https') ? https : http;
    const req = lib.get(targetUrl, options, (res) => {
      // follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('latin1');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── extract car IDs from listing page ──
function extractIds(html) {
  const ids = [];
  const seen = new Set();
  const re = /cardetail\.cfm\?c=(\d+)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
  }
  return ids;
}

// ── decode HTML entities ──
function decodeEntities(str) {
  return str
    .replace(/&cent;/g, '¢')
    .replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&ntilde;/g, 'ñ')
    .replace(/&Aacute;/g, 'Á').replace(/&Eacute;/g, 'É').replace(/&Iacute;/g, 'Í')
    .replace(/&Oacute;/g, 'Ó').replace(/&Uacute;/g, 'Ú').replace(/&Ntilde;/g, 'Ñ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/&#[0-9]+;/g, '').trim();
}

// ── parse a single extract.cfm page into a car object ──
function parseExtract(html, id) {
  // decode HTML entities in full page first
  const decoded = decodeEntities(html);

  // title: "crautos.com Kia RIO 2019 ¢ 6,000,000 ($ 12,448)*"
  const titleM = decoded.match(/<title[^>]*>\s*(?:crautos\.com\s+)?([^<]+?)\s*<\/title>/i);
  const rawTitle = titleM ? titleM[1].replace(/\s+/g, ' ').trim() : '';

  // extract make, model, year — stop before ¢ or $
  let make = '', model = '', year = 0;
  // pattern: "Make MODEL(S) YEAR ¢..." — capture up to the year
  const titleParts = rawTitle.match(/^([A-Za-záéíóúñÁÉÍÓÚÑ]+)\s+([A-Za-z0-9áéíóúñ\s\-\/\.]+?)\s+(\d{4})\s*[¢\$]/);
  if (titleParts) {
    make  = titleParts[1].trim();
    model = titleParts[2].trim();
    year  = parseInt(titleParts[3]);
  } else {
    // fallback: split words, last 4-digit number is year
    const words = rawTitle.replace(/[¢\$].*/,'').trim().split(/\s+/);
    make = words[0] || '';
    const yearIdx = words.map(w => /^\d{4}$/.test(w)).lastIndexOf(true);
    if (yearIdx > 0) {
      model = words.slice(1, yearIdx).join(' ');
      year  = parseInt(words[yearIdx]);
    } else {
      model = words.slice(1).join(' ');
    }
  }

  // price in colones — look for ¢ followed by digits (after entity decode)
  let priceC = 0, priceU = 0;
  const colM = decoded.match(/¢\s*\r?\n?\s*(\d[\d,\.]+)/);
  if (colM) {
    const v = parseInt(colM[1].replace(/[,\.]/g, '').slice(0, 9));
    if (v >= 200000 && v <= 999999999) priceC = v;
  }
  // USD price
  const usdM = decoded.match(/\$\s*([\d,]+)\s*\(/);
  if (usdM) priceU = parseInt(usdM[1].replace(/,/g, '')) || 0;

  // km — handle both "kms" and "millas" (miles), convert miles to km
  let km = 0;
  const kmM = decoded.match(/Kilometraje[\s\S]{1,80}?([\d][\d,\.]+)\s*(kms?|millas?)/i);
  if (kmM) {
    const v = parseInt(kmM[1].replace(/[,\.]/g, ''));
    const unit = kmM[2].toLowerCase();
    if (v > 0 && v < 1000000) {
      km = unit.startsWith('mill') ? Math.round(v * 1.60934) : v; // convert miles to km
    }
  }

  // transmission — decoded so no HTML entities
  let trans = '';
  const transM = decoded.match(/Transmisi[oó]n<\/td>[\s\S]{1,40}?<td[^>]*>\s*([^<\n]{3,40}?)\s*<\/td>/i);
  if (transM) trans = transM[1].trim();

  // style
  let style = '';
  const styleM = decoded.match(/Estilo<\/td>[\s\S]{1,40}?<td[^>]*>\s*([^<\n]{3,40}?)\s*<\/td>/i);
  if (styleM) style = styleM[1].trim();

  // fuel
  let fuel = '';
  const fuelM = decoded.match(/Combustible<\/td>[\s\S]{1,40}?<td[^>]*>\s*([^<\n]{3,30}?)\s*<\/td>/i);
  if (fuelM) fuel = fuelM[1].trim();

  // color
  let color = '';
  const colorM = decoded.match(/Color exterior<\/td>[\s\S]{1,40}?<td[^>]*>\s*([^<\n]{2,25}?)\s*<\/td>/i);
  if (colorM) color = colorM[1].trim();

  // province
  let province = '';
  const provM = decoded.match(/Provincia<\/td>[\s\S]{1,40}?<td[^>]*>\s*([^<\n]{3,30}?)\s*<\/td>/i);
  if (provM) province = provM[1].trim();

  // negotiable
  const negM = decoded.match(/Precio negociable<\/td>[\s\S]{1,40}?<td[^>]*>\s*([^<\n]{2,5}?)\s*<\/td>/i);
  const negotiable = negM ? negM[1].trim().toUpperCase() === 'SI' : false;

  // description
  const descM = decoded.match(/Equipamiento<\/td>[\s\S]{1,40}?<td[^>]*>\s*([^<]{10,300}?)\s*<\/td>/i);
  const desc = descM ? descM[1].replace(/\s+/g, ' ').trim().slice(0, 150) : '';

  if (!make) return null;

  return {
    id, make, model, year, trans, km, priceC, priceU,
    style, fuel, color, province, negotiable, desc,
    url: 'https://crautos.com/autosusados/cardetail.cfm?c=' + id,
    foundAt: Date.now(), isNew: true, isDrop: false, dropAmt: 0
  };
}

// ── detect price drops ──
function detectDrop(car, thresholdC, thresholdPct) {
  const price = car.priceC || (car.priceU * 482);
  if (!price) return false;
  const hist = priceHistory[car.id];
  if (hist && hist.price > 0 && price < hist.price) {
    const diff = hist.price - price;
    const pct = diff / hist.price;
    if (diff >= thresholdC || pct >= thresholdPct) {
      car.isDrop = true;
      car.dropAmt = diff;
      car.dropPct = Math.round(pct * 100);
      car.prevPrice = hist.price;
    }
  }
  priceHistory[car.id] = { price, make: car.make, model: car.model, year: car.year, url: car.url, ts: Date.now() };
  saveHistory();
  return car.isDrop || false;
}

// ── apply filters ──
function matchesFilters(car, f) {
  if (f.make && !car.make.toLowerCase().includes(f.make) && !car.model.toLowerCase().includes(f.make)) return false;
  // model: every word the user typed must appear somewhere in make+model string
  if (f.model) {
    const haystack = (car.make + ' ' + car.model).toLowerCase();
    const needles = f.model.toLowerCase().split(/\s+/);
    if (!needles.every(w => haystack.includes(w))) return false;
  }
  if (f.trans && car.trans && !car.trans.toLowerCase().includes(f.trans.toLowerCase())) return false;
  if (car.year) {
    if (f.ymin && car.year < parseInt(f.ymin)) return false;
    if (f.ymax && car.year > parseInt(f.ymax)) return false;
  }
  const p = car.priceC || (car.priceU * 482);
  if (p > 0) {
    if (f.pmin && p < parseInt(f.pmin)) return false;
    if (f.pmax && p > parseInt(f.pmax)) return false;
  }
  if (f.kmmax && car.km > 0 && car.km > parseInt(f.kmmax)) return false;
  return true;
}

// ── CORS ──
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── fetch + parse a single listing page, return matched cars ──
async function scanOnePage(pageNum, filters, threshC, threshPct) {
  const listUrl = `https://crautos.com/autosusados/index.cfm?page=${pageNum}`;
  const listHtml = await fetchUrl(listUrl);
  const ids = extractIds(listHtml);
  if (!ids.length) return { cars: [], ids: 0, done: true };

  const cars = [];
  const batchSize = 8;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (id) => {
        const html = await fetchUrl(`https://crautos.com/autosusados/extract.cfm?c=${id}`);
        return parseExtract(html, id);
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        const car = r.value;
        detectDrop(car, threshC, threshPct);
        if (matchesFilters(car, filters)) cars.push(car);
      }
    }
    if (i + batchSize < ids.length) await new Promise(r => setTimeout(r, 300));
  }
  return { cars, ids: ids.length, done: false };
}

// ── /scan handler ──
async function handleScan(query, res) {
  const page = parseInt(query.page) || 1;
  const totalPages = parseInt(query.totalPages) || 1;
  const threshC = parseInt(query.threshC) || 300000;
  const threshPct = (parseInt(query.threshPct) || 5) / 100;
  const filters = {
    make: (query.make || '').toLowerCase().trim(),
    model: (query.model || '').toLowerCase().trim(),
    trans: query.trans || '',
    ymin: query.ymin, ymax: query.ymax,
    pmin: query.pmin, pmax: query.pmax,
    kmmax: query.kmmax,
  };

  try {
    // scan the requested page range server-side
    const allCars = [];
    let totalIds = 0;
    for (let pg = page; pg < page + totalPages; pg++) {
      const { cars, ids, done } = await scanOnePage(pg, filters, threshC, threshPct);
      allCars.push(...cars);
      totalIds += ids;
      if (done) break;
      // small delay between pages
      if (pg < page + totalPages - 1) await new Promise(r => setTimeout(r, 400));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, page, totalPages, count: allCars.length, totalIds, cars: allCars }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}

// ── main server ──
const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = reqUrl.pathname;
  const query = Object.fromEntries(reqUrl.searchParams.entries());

  if (pathname === '/scan') return handleScan(query, res);

  // ── /api/login ──
  if (pathname === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { username, password } = JSON.parse(body);
        if (USERS[username] && USERS[username] === password) {
          const token = generateToken();
          sessions[token] = { user: username, expires: Date.now() + 24 * 60 * 60 * 1000 };
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `session=${token}; Path=/; HttpOnly; Max-Age=86400`
          });
          res.end(JSON.stringify({ ok: true, user: username }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid username or password' }));
        }
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Bad request' }));
      }
    });
    return;
  }

  // ── /api/logout ──
  if (pathname === '/api/logout') {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/session=([^;]+)/);
    if (match) delete sessions[match[1]];
    res.writeHead(302, {
      'Set-Cookie': 'session=; Path=/; Max-Age=0',
      Location: '/login.html'
    });
    res.end();
    return;
  }

  // ── /login.html — always public ──
  if (pathname === '/login.html') {
    const filePath = path.join(__dirname, 'public', 'login.html');
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(filePath));
    }
  }

  // ── all other routes require auth ──
  if (!requireAuth(req, res)) return;

  if (pathname === '/health') {
    const s = getSession(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, uptime: process.uptime().toFixed(0)+'s', historySize: Object.keys(priceHistory).length, user: s ? s.user : null }));
  }

  if (pathname === '/history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, count: Object.keys(priceHistory).length, history: priceHistory }));
  }


  // ── /debug — shows raw parsed data so we can verify the parser ──
  if (pathname === '/debug') {
    try {
      const type = query.type || 'list';
      if (type === 'extract' && query.id) {
        const html = await fetchUrl(`https://crautos.com/autosusados/extract.cfm?c=${query.id}`);
        const car = parseExtract(html, query.id);
        const kmSnippet = html.match(/Kilometraje[\s\S]{0,200}/i)?.[0]?.slice(0,200) || 'not found';
        const transSnippet = html.match(/Transmisi[\s\S]{0,200}/i)?.[0]?.slice(0,200) || 'not found';
        const titleSnippet = html.match(/<title[\s\S]{0,200}/i)?.[0]?.slice(0,200) || 'not found';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok:true, parsed:car, raw:{title:titleSnippet, km:kmSnippet, trans:transSnippet} }, null, 2));
      }
      if (type === 'list') {
        const page = parseInt(query.page) || 1;
        const html = await fetchUrl(`https://crautos.com/autosusados/index.cfm?page=${page}`);
        const ids = extractIds(html);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok:true, page, idsFound:ids.length, ids:ids.slice(0,10), rawSnippet:html.slice(0,3000) }, null, 2));
      }
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok:false, error:e.message }));
    }
  }

  // serve static files
  const filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  if (fs.existsSync(filePath)) {
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    return res.end(fs.readFileSync(filePath));
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ CRautos Bot server running at http://localhost:${PORT}`);
  console.log(`   Open http://localhost:${PORT} in your browser\n`);
});
