// Черновик отклика на заказ kwork: draft.js <id> [--dry] [--again]. Читает страницу заказа (с cookie, если есть), зовет Claude,
// присылает владельцу в MAX текст, цену, срок и кнопки. На kwork ничего не отправляет. --dry: ничего не шлет, печатает в stdout.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { readFiles } = require('./files');

const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const MAX_API = 'https://platform-api2.max.ru';
const TOKEN = (process.env.MAX_BOT_TOKEN || '').trim();
const COOKIE = (process.env.KWORK_COOKIE || '').trim().replace(/^cookie:\s*/i, '');
const ID = Number(process.argv[2]);
const DRY = process.argv.includes('--dry');
const AGAIN = process.argv.includes('--again');
const CI = process.argv.indexOf('--comment');
const COMMENT = CI > 0 ? String(process.argv[CI + 1] || '').trim() : '';
const STATE_DIR = process.env.KWORK_STATE_DIR || path.join(DIR, 'state');
const DRAFTS = path.join(STATE_DIR, 'drafts');
const DAYS = [1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 30, 60]; // сроки, которые принимает форма kwork
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const WORK = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'kwork-radar');
const log = (...a) => console.error(new Date().toLocaleString('sv-SE').slice(0, 16), ...a);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const decode = s => String(s || '').replace(/&laquo;|&raquo;|&quot;/g, '"').replace(/&mdash;|&ndash;/g, '—').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim();
// Критерии и профиль: criteria/<имя>.md, нет своего файла — criteria/<имя>.example.md.
const criteria = name => [`${name}.md`, `${name}.example.md`].map(f => path.join(DIR, '..', 'criteria', f)).find(p => fs.existsSync(p));
const ownerId = () => readJson(path.join(STATE_DIR, 'owner.json'), {}).userId || CFG.userId;

// Страница заказа: JSON "wantData" вырезаем по скобкам. Cookie нужна не всегда, но с ней видны вложения.
async function readOrder(id) {
  const r = await fetch(`https://kwork.ru/projects/${id}/view`, { headers: { 'User-Agent': UA, 'Accept-Language': 'ru', ...(COOKIE && { Cookie: COOKIE }) } });
  if (!r.ok) throw new Error(`заказ ${id} → ${r.status}`);
  const h = await r.text();
  const i = h.indexOf('"wantData"');
  if (i < 0) throw new Error('на странице нет wantData (заказ закрыт или нужен вход)');
  const st = h.indexOf('{', i);
  let d = 0, j = st, inStr = false;
  for (; j < h.length; j++) {
    const c = h[j];
    if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') d++; else if (c === '}' && --d === 0) break;
  }
  const w = JSON.parse(h.slice(st, j + 1));
  const text = decode(w.description);
  return {
    id: w.id, name: decode(w.name), status: w.status,
    price: Number(w.priceLimit || 0), maxPrice: Number(w.possiblePriceLimit || 0), maxDays: Number(w.max_days || 0),
    offers: Number(w.kwork_count || 0), timeLeft: w.timeLeft || '',
    text,
    buyer: { hiredPercent: Number(w.user?.data?.wants_hired_percent || 0), orders: Number(w.user?.data?.wants_count || 0) },
    rawFiles: (w.files || []).map(f => ({ name: f.fname, url: f.url, size: Number(f.size || 0) })),
    links: [...new Set((text.match(/https?:\/\/[^\s"<>)\]]+/g) || []).map(u => u.replace(/[.,;]+$/, '')))].filter(u => !/kwork\.ru/.test(u)).slice(0, 5),
  };
}

function buildPrompt() {
  const rd = f => { const p = criteria(f); return p ? fs.readFileSync(p, 'utf8') : ''; };
  return `${fs.readFileSync(path.join(DIR, 'reply-template.md'), 'utf8')}
Профиль исполнителя:
${rd('profile')}

Правила отбора и цен владельца:
${rd('kwork')}
${COMMENT ? `\nВладелец просит поправить прежний черновик. Что поменять: ${COMMENT}\nПрежний черновик (все, что просьба не затрагивает, оставь как есть):\n${JSON.stringify(readJson(path.join(DRAFTS, ID + '.json'), {}), null, 1)}\n` : ''}${AGAIN && !COMMENT ? '\nЭто повторная просьба: напиши другой вариант отклика - другие формулировки, другой заход в первой фразе и другой пример из опыта, если уместно; факты, цена и срок остаются в рамках правил.\n' : ''}
Заказ:
`;
}

function parseAnswer(raw) {
  const s = String(raw).replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('нет JSON-объекта: ' + s.slice(0, 200));
  const o = JSON.parse(s.slice(a, b + 1));
  if (!o.text || !Number(o.price) || !Number(o.days)) throw new Error('в ответе нет text, price или days');
  const price = Math.round(Number(o.price)), d = Number(o.days);
  if (price < 500) throw new Error('цена меньше минимума kwork 500 ₽');
  if (d > 60 || d <= 0) throw new Error('срок вне допустимого набора kwork (1-60 дней)');
  const days = DAYS.find(x => x >= d); // ближайший допустимый срок вверх
  let stages = o.stages == null ? [] : o.stages;
  if (!Array.isArray(stages)) throw new Error('stages должен быть массивом');
  if (stages.length) {
    if (stages.length < 2 || stages.length > 4) throw new Error('этапов должно быть 0 или 2-4, пришло ' + stages.length);
    stages = stages.map(st => ({ title: String(st?.title || '').trim().slice(0, 100), price: Math.round(Number(st?.price)) }));
    if (stages.some(st => !st.title || !(st.price > 0))) throw new Error('у каждого этапа нужны title и price');
    const sum = stages.reduce((a, st) => a + st.price, 0);
    if (sum !== price) throw new Error(`сумма этапов ${sum} не равна цене ${price}`);
  }
  return { ...o, price, days, stages };
}

function saveDraft(d) {
  fs.mkdirSync(DRAFTS, { recursive: true });
  fs.writeFileSync(path.join(DRAFTS, ID + '.json'), JSON.stringify(d, null, 1));
}

function askClaude(order) {
  const model = CFG.draftModel || CFG.model;
  const cmd = `claude -p --model ${model} --effort ${CFG.effort} --setting-sources project --tools Read --allowedTools Read --no-session-persistence --output-format json`;
  fs.mkdirSync(WORK, { recursive: true });
  const out = execSync(cmd, { cwd: WORK, input: buildPrompt() + JSON.stringify(order, null, 1), encoding: 'utf8', timeout: 600000, maxBuffer: 20 * 1024 * 1024 });
  const res = JSON.parse(out);
  if (res.is_error) throw new Error('claude: ' + String(res.result).slice(0, 200));
  try { return parseAnswer(res.result); }
  catch (e) { throw new Error(`${e.message} | raw: ${String(res.result).slice(0, 300).replace(/\s+/g, ' ')}`); }
}

async function max(method, url, body) {
  const r = await fetch(MAX_API + url, { method, headers: { Authorization: TOKEN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`MAX ${url.split('?')[0]} → ${r.status} ${j.message || ''}`);
  return j;
}

const ref = id => `[${id}](https://kwork.ru/projects/${id}/view)`; // номер заказа ссылкой: голое число MAX принимает за телефон
const rub = n => Number(n).toLocaleString('ru-RU').replace(/\u00a0/g, ' ');
(async () => {
  if (!ID) { console.error('Использование: draft.js <id заказа> [--dry] [--again] [--comment "текст"]'); process.exit(2); }
  const order = await readOrder(ID);
  // Все вложения: текст docx/xlsx/txt — в заказ, pdf и картинки — в att-draft/ для Read. Без cookie kwork вместо файла отдает страницу входа.
  const raw = order.rawFiles; delete order.rawFiles;
  if (raw.length) {
    const att = path.join(WORK, 'att-draft');
    fs.rmSync(att, { recursive: true, force: true });
    const download = async url => {
      const own = /(^|\.)kwork\.ru$/.test(new URL(url).hostname); // cookie — только своему сайту
      const r = await fetch(url, { headers: { 'User-Agent': UA, ...(own && COOKIE && { Cookie: COOKIE }) }, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (/text\/html/.test(r.headers.get('content-type') || '')) throw new Error('нужен вход на kwork');
      return Buffer.from(await r.arrayBuffer());
    };
    const f = await readFiles(ID, raw, { download, dir: att, rel: p => path.relative(WORK, p).replace(/\\/g, '/'), log, pause: 300 });
    if (f.text) order.attachments = f.text;
    if (f.paths.length) order.files = f.paths;
    if (f.skipped.length) order.unavailable = f.skipped;
    log(`вложения ${ID}: всего ${raw.length}, текст ${f.text.length} знаков, файлов для Read ${f.paths.length}, не прочитано ${f.skipped.length}`);
  }
  const d = askClaude(order);
  // Цена — от объема работы, но не выше потолка «можно предложить до» (правило владельца). Выше потолка — режем до него, этапы пересчитываем пропорционально.
  const budget = Math.max(500, order.maxPrice || order.price || 0);
  if (order.price && d.price > budget) {
    log(`цена модели ${d.price} выше потолка, заменена на ${budget}`);
    if (d.stages.length) {
      d.stages = d.stages.map(st => ({ ...st, price: Math.round(st.price * budget / d.price) }));
      d.stages[d.stages.length - 1].price += budget - d.stages.reduce((x, st) => x + st.price, 0);
      if (d.stages.some(st => st.price <= 0)) d.stages = [];
    }
    d.price = budget;
  }
  const title = String(d.title || order.name).slice(0, 70);
  const body = String(d.text).trim();
  const len = body.length;
  const price = d.price, days = d.days, stages = d.stages;
  const draft = { id: ID, title, text: body, price, days, stages, note: String(d.note || ''), url: `https://kwork.ru/projects/${ID}/view`, createdAt: new Date().toISOString() };
  const stageTxt = stages.length ? '\n\nЭтапы:\n' + stages.map((st, i) => `${i + 1}. ${st.title} - ${rub(st.price)} ₽`).join('\n') : '';
  const lenNote = len < 150 || len > 2000 ? `\n⚠️ Длина ${len} знаков, лимит kwork 150–2000 — поправьте перед отправкой.` : '';
  const head = `${COMMENT ? 'Исправленный вариант отклика' : AGAIN ? 'Другой вариант отклика' : 'Черновик отклика'} на заказ №${ref(ID)}\n**${title}**\n\n`;
  const tail = `${stageTxt}\n\n💰 Предлагаю: ${rub(price)} ₽ · ${days} дн. (бюджет ${rub(order.price)} ₽${order.maxPrice > order.price ? `, торг до ${rub(order.maxPrice)} ₽` : ', торга нет'})\n\n🔎 ${d.review ? d.review : 'Модель не дала рекомендацию: нажмите «Другой вариант» или решите сами.'}${order.unavailable ? `\n⚠️ Не прочитано: ${order.unavailable.join('; ')}` : ''}${d.note ? `\n📝 ${d.note}` : ''}${lenNote}\nЗнаков в отклике: ${len}`;
  if (DRY) { console.log(head.replace(/\*\*/g, '') + body + tail); return; }
  const uid = ownerId();
  if (!uid) throw new Error('нет user_id владельца (state/owner.json)');
  saveDraft(draft);
  const buttons = [[{ type: 'callback', text: 'Другой вариант', payload: `redraft:${ID}` }, { type: 'link', text: 'Открыть заказ', url: draft.url }]];
  // Лимит текста сообщения MAX - 4000 знаков; отклик до 2000, остальное короткое, но на всякий случай режем на два сообщения.
  const full = head + body + tail;
  if (full.length <= 3900) await max('POST', `/messages?user_id=${uid}`, { text: full, format: 'markdown', attachments: [{ type: 'inline_keyboard', payload: { buttons } }] });
  else {
    await max('POST', `/messages?user_id=${uid}`, { text: head + body, format: 'markdown' });
    await max('POST', `/messages?user_id=${uid}`, { text: tail.trim(), attachments: [{ type: 'inline_keyboard', payload: { buttons } }] });
  }
  log(`черновик ${ID} отправлен владельцу, ${len} знаков`);
})().catch(async e => {
  console.error('ошибка:', e.message);
  if (!DRY && TOKEN && ID) {
    const uid = ownerId();
    if (uid) await max('POST', `/messages?user_id=${uid}`, { text: `Не удалось подготовить ответ на заказ ${ref(ID)}: ${String(e.message).slice(0, 200)}`, format: 'markdown' }).catch(() => {});
  }
  process.exit(1);
});
