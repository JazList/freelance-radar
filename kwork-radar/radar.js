// Радар заказов kwork: сбор рубрик без входа → грубый фильтр → оценка Claude (каждый заказ отдельным вызовом) → карточки 🟢/🟡 в MAX.
// Запуск — run.ps1 (Планировщик раз в час). Флаги: --dry (карточки в консоль, без отправки и без записи seen.json),
// --limit N (оценить не больше N), --ids 1,2 (переоценить эти), --seen <файл> (другой seen.json; с ним --dry его тоже обновляет — для проверки на копии).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const files = require('./files');

const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const STATE_DIR = path.join(DIR, 'state');
const SEEN_ARG = (process.argv.join(' ').match(/--seen (\S+)/) || [])[1];
const SEEN = SEEN_ARG ? path.resolve(SEEN_ARG) : path.join(STATE_DIR, 'seen.json');
const OWNER = path.join(STATE_DIR, 'owner.json');
const MAX_API = 'https://platform-api2.max.ru';
const TOKEN = (process.env.MAX_BOT_TOKEN || '').trim();
const DRY = process.argv.includes('--dry');
const LIMIT = Number((process.argv.join(' ').match(/--limit (\d+)/) || [])[1] || 0);
const NOW = process.argv.includes('--now'); // по кнопке в боте: без тихих часов, ответ даже если новых нет
const IDS = ((process.argv.join(' ').match(/--ids ([\d,]+)/) || [])[1] || '').split(',').filter(Boolean).map(Number); // переоценить эти заказы
const UA ='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

// Заведомо не наше: чужие программы и железо, личное присутствие, серые схемы, игры и магазины приложений.
const STOP = [
  /lonati|дессинатор|фрезер|станок|прошивк[аиу] (контроллер|плат)/i,
  /ios|xcode|swift|app ?store|google play|android studio|kotlin/i,
  /unity|unreal|\bue[45]\b|blender|3d[- ]?модел/i,
  /звон(ить|ки)|обзвон|выезд|приехать|офлайн|курьер/i,
  /майнинг|накрутк|взлом|обход (капч|защит)|ddos/i,
  /altium|kicad|arduino|stm32|esp32|плис|fpga|verilog|плат[аыу] управлени/i,
  /(обход|решени\w*|разгад\w*|распозна\w*) ?(капч|captcha)|(bypass|solv\w*) captcha|cloudflare|клаудфлар|антидетект|взаимн\w* (просмотр|обмен)|слот\w* на виз/i,
  /zennoposter|зеннопостер|browser automation studio|\bbas\b/i,
  /переустанов|ос ?7|windows ?7/i,
  /gta|fivem|sa-?mp|pawno|\bmta\b|construct ?3|roblox|minecraft/i,
];

const log = (...a) => console.log(new Date().toLocaleString('sv-SE').slice(0, 16), ...a);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const sha1 = t => require('crypto').createHash('sha1').update(String(t)).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ru' } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.text();
}

// Заказы лежат в JSON страницы: "wantsListData":{"pagination":{"data":[...]}}; вырезаем объект по скобкам.
function extractWants(html) {
  const key = '"wantsListData":';
  const start = html.indexOf(key) + key.length;
  if (start < key.length) throw new Error('на странице нет wantsListData — kwork сменил разметку');
  let depth = 0, inStr = false, esc = false, i = start;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  const lp = JSON.parse(html.slice(start, i + 1)).pagination || {};
  return { data: lp.data || [], last: lp.last_page || 1 };
}

const decode = s => String(s || '')
  .replace(/&laquo;|&raquo;|&quot;/g, '"').replace(/&mdash;|&ndash;/g, '—').replace(/&bull;/g, '•')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function collect() {
  const raw = [];
  for (const c of CFG.categories) {
    const url = p => `https://kwork.ru/projects?c=${c}${p > 1 ? `&page=${p}` : ''}`;
    const first = extractWants(await get(url(1)));
    log(`рубрика ${c}: страниц ${first.last}, на первой ${first.data.length}`);
    raw.push(...first.data);
    for (let p = 2; p <= first.last; p++) { await sleep(1500); raw.push(...extractWants(await get(url(p))).data); }
    await sleep(1500);
  }
  const byId = new Map();
  for (const w of raw) {
    const text = decode(w.name + '. ' + w.description);
    byId.set(w.id, {
      id: w.id,
      url: `https://kwork.ru/projects/${w.id}/view`,
      name: decode(w.name),
      price: Number(w.priceLimit || 0),
      maxPrice: Number(w.possiblePriceLimit || 0),
      offers: Number(w.kwork_count || 0),
      timeLeft: w.timeLeft || '',
      hired: Number(w.user?.data?.wants_hired_percent || 0),
      buyerWants: Number(w.user?.data?.wants_count || 0),
      text,
      fp: sha1(text),
      files: (w.files || []).map(f => ({ name: f.fname, url: f.url, size: Number(f.size || 0) })),
      stop: STOP.some(r => r.test(text)),
    });
  }
  return [...byId.values()];
}

// Вложения: docx/xlsx/txt читаем сами в текст, pdf и картинки кладем в папку — их читает Claude инструментом Read.
const WORK = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'kwork-radar'); // вне репозитория: claude -p не подхватывает правила проекта
const ATT = path.join(WORK, 'att');

// Cookie входа держим в банке: kwork меняет токены входа, новые значения из Set-Cookie
// сохраняем (state/kwork-cookie.new → run.ps1 шифрует в секрет), иначе вход протухает.
const JAR = new Map((process.env.KWORK_COOKIE || '').trim().replace(/^cookie:\s*/i, '').split(/;\s*/)
  .filter(Boolean).map(s => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]).filter(([k]) => k));
let jarChanged = false;
const jarHeader = () => [...JAR].map(([k, v]) => `${k}=${v}`).join('; ');
function takeCookies(r) {
  for (const sc of r.headers.getSetCookie()) {
    const [pair, ...attrs] = sc.split(/;\s*/), eq = pair.indexOf('=');
    if (eq < 1) continue;
    const k = pair.slice(0, eq), v = pair.slice(eq + 1), a = attrs.join(';').toLowerCase();
    const exp = a.match(/expires=([^;]+)/), age = a.match(/max-age=(-?\d+)/);
    const gone = v === '' || v === 'deleted' || (age && +age[1] <= 0) || (!age && exp && Date.parse(exp[1]) < Date.now());
    if (gone ? JAR.delete(k) : JAR.get(k) !== v && JAR.set(k, v)) jarChanged = true;
  }
}
// Запрос к kwork с cookie: редиректы вручную, чтобы не потерять Set-Cookie промежуточных ответов.
async function kworkFetch(url, hops = 5) {
  const own = /(^|\.)kwork\.ru$/.test(new URL(url).hostname); // cookie — только своему сайту
  const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA, 'Accept-Language': 'ru', ...(own && JAR.size && { Cookie: jarHeader() }) } });
  if (own) takeCookies(r);
  const loc = r.headers.get('location');
  return r.status >= 300 && r.status < 400 && loc && hops ? kworkFetch(new URL(loc, url).href, hops - 1) : r;
}
// Каждый прогон (и в тихие часы) держит вход живым, даже без вложений: одно обращение к kwork с cookie.
async function keepLogin() {
  if (JAR.size) await kworkFetch('https://kwork.ru/projects').then(r => r.arrayBuffer()).catch(e => log('kwork: обновление входа не удалось', e.message));
  if (jarChanged && JAR.size) { fs.writeFileSync(path.join(STATE_DIR, 'kwork-cookie.new'), jarHeader()); log('cookie kwork обновлены'); }
}
let loginLost = false; // kwork вместо файла отдал страницу — вход устарел или cookie нет
async function download(url) {
  const r = await kworkFetch(url);
  if (/text\/html/.test(r.headers.get('content-type') || '')) { loginLost = true; throw new Error('нужен вход'); }
  return Buffer.from(await r.arrayBuffer());
}

const readFiles = w => files.readFiles(w.id, w.files, { download, dir: ATT, rel: f => path.relative(WORK, f).replace(/\\/g, '/'), log });

// Ссылки из описания: Google Docs/Sheets — выгрузка текстом, Figma и закрытое — отмечаем, остальное — текст страницы.
async function readLinks(w) {
  const urls = [...new Set((w.text.match(/https?:\/\/[^\s"<>)\]]+/g) || []).map(u => u.replace(/[.,;]+$/, '')))].filter(u => !/kwork\.ru/.test(u)).slice(0, 3);
  const out = { text: '', failed: [] };
  for (const u of urls) {
    try {
      let url = u;
      const g = u.match(/docs\.google\.com\/(document|spreadsheets)\/d\/([\w-]+)/);
      if (g) url = `https://docs.google.com/${g[1]}/d/${g[2]}/export?format=${g[1] === 'document' ? 'txt' : 'csv'}`;
      else if (/figma\.com/.test(u)) { out.failed.push(`${u} (Figma: макет без входа не читается)`); continue; }
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ru' }, signal: AbortSignal.timeout(CFG.linkTimeoutMs || 12000) });
      if (!r.ok) throw new Error(String(r.status));
      let t = await r.text();
      if (!g) t = decode(t.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' '));
      if (g && /<html/i.test(t.slice(0, 500))) throw new Error('нужен вход');
      out.text += `\n[${u}]\n${t.slice(0, CFG.linkLimit || 4000)}`;
    } catch (e) { out.failed.push(`${u} (${e.message})`); }
  }
  return out;
}

// Промпт собирается при каждом запуске: правила — из criteria/kwork.md, списки сервисов — из config.json.
const criteria = name => [`${name}.md`, `${name}.example.md`].map(f => path.join(DIR, '..', 'criteria', f)).find(p => fs.existsSync(p));
const SELECTION = criteria('kwork');
function buildPrompt() {
  const sv = CFG.services || {};
  const list = a => (a || []).join(', ');
  return `Ты отбираешь заказы с фриланс-биржи kwork для исполнителя: владелец + ИИ-агент Claude Code (код, сайты, интеграции по API, настройка облачных сервисов; без личного присутствия, звонков, платных программ, серых схем).
Ниже инструкция отбора владельца — следуй ей буквально. Заказы с рекламой, продвижением и текстами по смыслу не наши, кроме технической настройки.

${fs.readFileSync(SELECTION, 'utf8')}

Списки сервисов (из настроек радара, они приоритетнее текста выше):
- берем: ${list(sv.white)};
- не берем (verdict "skip"): ${list(sv.black)};
- уточнять (не выше "ask"): ${list(sv.ask)}.

Ограничения радара: официальную документацию ты не открываешь (глубокую проверку камней позже делает человек с Claude в чате). "go" — если заказ понятен, шаги типовые и хорошо тебе известны (камни всё равно перечисли); "ask" — если есть реальное сомнение по шагу, доступу или ТЗ: вопрос заказчику и названный камень. Не занижай до "ask" только из-за отсутствия проверки по документации.
Дано описание одного заказа в JSON: price — бюджет, maxPrice — потолок торга (если равен бюджету — торга нет), offers — отклики, hired — процент найма заказчика, buyerWants — число его заказов, text — описание, attachments — текст всех вложений (docx, xlsx по листам, txt), files — пути pdf/картинок (прочитай каждый инструментом Read до вердикта), links — текст страниц по ссылкам из описания, unavailable — вложения и ссылки, которые не удалось прочитать, с причиной (если без них суть неясна — не выше "ask", и скажи чего не хватило). Вердикт, объем работы, часы и камни выводи из вложений, а не только из описания: в них обычно настоящий объем (число страниц, правок, позиций); в why или stones назови, что именно нашел во вложениях.

Ответ — ТОЛЬКО один JSON-объект без пояснений и без markdown, ключи:
{"id":число,"verdict":"go"|"ask"|"skip","hours":целое>=1,"title":"Что: конкретно, до 60 символов","why":"главная причина, до 80 символов","stones":["подводный камень, до 80 символов", ...],"question":"что уточнить и у кого (для ask, иначе пустая строка)","buyer":"коротко о заказчике: найм, число заказов, ясность ТЗ, до 80 символов"}
"go" и "ask" — карточка уйдет владельцу, поэтому stones заполни всегда (для go хотя бы один камень или «нет, шаги типовые»); "skip" — карточки не будет.

Заказ:
`;
}

// Ответ модели: допускаем обертку в ```json и текст вокруг; одинарные кавычки не чиним — сырой ответ остается в логе.
function parseVerdict(raw) {
  const s = String(raw).replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('нет JSON-объекта: ' + s.slice(0, 200));
  const o = JSON.parse(s.slice(a, b + 1));
  if (!['go', 'ask', 'skip'].includes(o.verdict)) throw new Error('неизвестный verdict: ' + o.verdict);
  return o;
}

let modelCalls = 0;
async function evaluate(w) {
  const it = { id: w.id, price: w.price, maxPrice: w.maxPrice, offers: w.offers, hired: w.hired, buyerWants: w.buyerWants, text: w.text.slice(0, 20000) };
  const unavailable = [];
  if (w.files.length) {
    const f = await readFiles(w);
    if (f.text) it.attachments = f.text;
    if (f.paths.length) it.files = f.paths;
    unavailable.push(...f.skipped);
  }
  const l = await readLinks(w);
  if (l.text) it.links = l.text;
  unavailable.push(...l.failed);
  if (unavailable.length) it.unavailable = unavailable;
  // claude — npm-обёртка (.cmd), поэтому через оболочку; из инструментов только Read — для pdf и картинок в att/.
  const cmd = `claude -p --model ${CFG.model} --effort ${CFG.effort} --setting-sources project --tools Read --allowedTools Read --no-session-persistence --output-format json`;
  modelCalls++;
  const out = execSync(cmd, { cwd: WORK, input: buildPrompt() + JSON.stringify(it, null, 1), encoding: 'utf8', timeout: 600000, maxBuffer: 20 * 1024 * 1024 });
  const res = JSON.parse(out);
  if (res.is_error) throw new Error('claude: ' + String(res.result).slice(0, 200));
  try { return parseVerdict(res.result); }
  catch (e) { throw new Error(`${e.message} | raw: ${String(res.result).slice(0, 300).replace(/\s+/g, ' ')}`); }
}

async function max(method, url, body) {
  const r = await fetch(MAX_API + url, { method, headers: { Authorization: TOKEN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`MAX ${url} → ${r.status} ${j.message || ''}`);
  return j;
}

// user_id владельца берём из первого «/start» или сообщения боту и запоминаем.
async function ownerId() {
  if (CFG.userId) return CFG.userId;
  const saved = readJson(OWNER, null);
  if (saved?.userId) return saved.userId;
  const j = await max('GET', '/updates?limit=50&timeout=0');
  for (const u of j.updates || []) {
    const id = u.user?.user_id || u.message?.sender?.user_id;
    if (id) { fs.writeFileSync(OWNER, JSON.stringify({ userId: id, name: u.user?.name || u.message?.sender?.name || '' })); return id; }
  }
  return null;
}

const rub = n => n.toLocaleString('ru-RU').replace(/\u00a0/g, ' ');
function cardText(w, e) {
  const head = e.verdict === 'go' ? `🟢 ПОДХОДИТ · ~${e.hours} ч работы` : `🟡 УТОЧНИТЬ · ~${e.hours} ч работы`;
  const ceil = w.maxPrice && w.maxPrice !== w.price ? `можно предложить до ${rub(w.maxPrice)}` : 'торга нет';
  const lines = [head, `**${e.title || w.name}**`, `💰 ${rub(w.price)} ₽ (${ceil}) · откликов ${w.offers}`,
    `👤 Заказчик: найм ${w.hired}%, заказов ${w.buyerWants}${e.buyer ? ' — ' + e.buyer : ''}`];
  if (e.why) lines.push(`Почему: ${e.why}`);
  const stones = (Array.isArray(e.stones) ? e.stones : []).filter(Boolean);
  if (stones.length) lines.push('Камни:', ...stones.map(x => `• ${x}`));
  if (e.verdict === 'ask' && e.question) lines.push(`❓ ${e.question}`);
  return lines.join('\n');
}
function card(w, e) {
  return {
    text: cardText(w, e),
    format: 'markdown',
    attachments: [{ type: 'inline_keyboard', payload: { buttons: [[{ type: 'link', text: 'Открыть заказ', url: w.url }, { type: 'callback', text: 'Подготовить ответ', payload: `draft:${w.id}` }]] } }], // draft:<id> ловит bot/listen.js
  };
}
// Две короткие кнопки в один ряд под последней карточкой (постоянной клавиатуры у MAX нет); ловит bot/listen.js.
const MORE = [{ type: 'callback', text: 'Сводка', payload: 'summary_now' }, { type: 'callback', text: 'Kwork', payload: 'kwork_now' }];

(async () => {
  // Тишина 19:00–05:00 мск: если ПК проснулся и Планировщик догнал пропущенный запуск ночью — ничего не делаем.
  const mskHour = (new Date().getUTCHours() + 3) % 24;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!DRY && !IDS.length && !NOW && (mskHour >= CFG.quietFrom || mskHour < CFG.quietTo)) { log(`тихие часы (${mskHour}:00 мск) — пропуск`); await keepLogin(); return; }
  // Плановый запуск и кнопка не должны идти одновременно: общие seen.json и att/.
  const LOCK = path.join(STATE_DIR, 'run.lock');
  if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < 30 * 60e3) {
    log('радар уже работает — пропуск');
    if (NOW && !DRY) { const u = readJson(OWNER, {}).userId; if (u) await max('POST', `/messages?user_id=${u}`, { text: 'Поиск заказов уже идёт — карточки придут сами.' }); }
    return;
  }
  fs.writeFileSync(LOCK, String(process.pid));
  process.on('exit', () => fs.rmSync(LOCK, { force: true }));
  fs.rmSync(ATT, { recursive: true, force: true }); // вложения прошлого запуска не нужны
  fs.mkdirSync(ATT, { recursive: true });
  const uid = DRY ? null : await ownerId();
  if (!DRY && !uid) { log('нет user_id владельца: напишите боту /start — оценку пропускаю'); return; }
  const seen = readJson(SEEN, {});
  const all = await collect();
  // Показываем заново, только если заказа нет в памяти или изменились бюджет (price, maxPrice) либо описание (fp = sha1 текста).
  // Старый формат seen.json (без fp и maxPrice) читаем: недостающее поле не сравнивается и дописывается без повторной оценки.
  const changed = w => {
    const v = seen[w.id];
    if (!v || typeof v !== 'object') return true;
    if (v.price !== undefined && v.price !== w.price) return true;
    if (v.maxPrice !== undefined && v.maxPrice !== w.maxPrice) return true;
    if (v.fp !== undefined && v.fp !== w.fp) return true;
    return false;
  };
  for (const w of all) if (seen[w.id] && typeof seen[w.id] === 'object' && !changed(w)) Object.assign(seen[w.id], { price: w.price, maxPrice: w.maxPrice, fp: w.fp });
  const fresh = IDS.length ? all.filter(w => IDS.includes(w.id)) : all.filter(w => changed(w) && w.offers <= CFG.maxOffers && w.price >= CFG.minPrice && !w.stop);
  for (const w of all) if (w.stop && changed(w)) seen[w.id] = { at: Date.now(), verdict: 'stop', price: w.price, maxPrice: w.maxPrice, fp: w.fp };
  const todo = LIMIT ? fresh.slice(0, LIMIT) : fresh;
  log(`заказов ${all.length}, к оценке после фильтра ${fresh.length}, оцениваю ${todo.length}`);

  // Каждый заказ — отдельный вызов модели; параллельно не больше CFG.parallel.
  const evals = [];
  const t0 = Date.now();
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, CFG.parallel || 1) }, async () => {
    while (next < todo.length) {
      const w = todo[next++];
      try {
        const e = await evaluate(w);
        e.hours = Math.max(1, Math.round(Number(e.hours) || 1));
        evals.push({ w, e });
        seen[w.id] = { at: Date.now(), verdict: e.verdict, hours: e.hours, title: e.title, why: e.why, price: w.price, maxPrice: w.maxPrice, fp: w.fp, offers: w.offers };
      } catch (err) { log(`заказ ${w.id}: ошибка оценки, повторю в следующий раз — ${err.message}`.slice(0, 500)); }
    }
  }));
  // Только 🟢 и 🟡; сначала 🟢, внутри — меньше откликов. Лимит карточек: maxCards > 0, иначе без лимита.
  let send = evals.filter(x => x.e.verdict !== 'skip')
    .sort((a, b) => (a.e.verdict === 'go' ? 0 : 1) - (b.e.verdict === 'go' ? 0 : 1) || a.w.offers - b.w.offers);
  if (CFG.maxCards > 0) send = send.slice(0, CFG.maxCards);
  for (const { w, e } of evals) log(`${e.verdict.padEnd(4)} ~${e.hours}ч ${w.price}₽ ${w.offers}откл · ${e.title} · ${e.why} · ${w.url}`);
  if (DRY) for (const { w, e } of send) console.log(`
${'─'.repeat(40)}
${cardText(w, e)}
${w.url}`);

  if (send.length && !DRY) {
    for (const [i, { w, e }] of send.entries()) {
      const c = card(w, e);
      if (i === send.length - 1) c.attachments[0].payload.buttons.push(MORE); // повторный поиск — под последней карточкой
      await max('POST', `/messages?user_id=${uid}`, c); await sleep(700);
    }
  } else if (NOW && !DRY) {
    await max('POST', `/messages?user_id=${uid}`, { text: `Новых подходящих заказов нет (всего ${all.length}, к оценке ${fresh.length}).`, attachments: [{ type: 'inline_keyboard', payload: { buttons: [MORE] } }] });
  }
  log(`итог: оценено ${evals.length}, 🟢 ${evals.filter(x => x.e.verdict === 'go').length}, 🟡 ${evals.filter(x => x.e.verdict === 'ask').length}, вызовов модели ${modelCalls}, ${Math.round((Date.now() - t0) / 1000)} с`);
  // Вход на kwork устарел — предупредить раз в сутки, вложения до обновления не читаются.
  const WARN = path.join(STATE_DIR, 'login-warn.json');
  if (loginLost && !DRY && Date.now() - (readJson(WARN, {}).at || 0) > 864e5) {
    await max('POST', `/messages?user_id=${uid}`, { text: '⚠️ Вход на kwork устарел — вложения заказов не читаются. Обновите cookie (kwork-cookie).' });
    fs.writeFileSync(WARN, JSON.stringify({ at: Date.now() }));
  }
  if (loginLost) log('вложения не скачаны: нужен вход на kwork (секрет kwork-cookie)');
  await keepLogin();
  // Старше 7 дней из памяти убираем: заказ на kwork живёт около трёх суток.
  for (const [id, v] of Object.entries(seen)) if (Date.now() - (v.at || 0) > 7 * 864e5) delete seen[id];
  if (!DRY || SEEN_ARG) fs.writeFileSync(SEEN, JSON.stringify(seen)); // пробный прогон память не трогает, кроме явного --seen <копия>
  log(`отправлено ${DRY ? 0 : send.length} из ${send.length}${DRY ? ' (dry)' : ''}`);
})().catch(e => { log('FAIL', e.message); process.exit(1); });
