// Радар вакансий hh.ru: поиск по России с фильтрами владельца (с входом соискателя по cookie) → отсев чужих рубрик и
// грубый фильтр по полям → полный текст вакансии → оценка Claude по criteria/hh.md (каждая вакансия отдельным вызовом).
// Итог — в консоль; с --max еще в state/max-report.json для команды /hh MAX-бота (bot/listen.js). Запуск — run.ps1.
// Флаги: --period N (дней поиска, по умолчанию periodDays), --count (только подсчет, без оценки), --ids 1,2 (оценить только эти),
// --all (оценить заново все найденные, не глядя в seen.json — после смены правил отбора), --max (отчет для MAX: карточки без 🔴, потеря входа).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const STATE_DIR = path.join(DIR, 'state');
const ARGS = process.argv.join(' ');
const PERIOD = Number((ARGS.match(/--period (\d+)/) || [])[1] || CFG.periodDays);
const COUNT_ONLY = /--count\b/.test(ARGS);
const ALL = /--all\b/.test(ARGS);
const MAX = /--max\b/.test(ARGS);
const MAX_REPORT = path.join(STATE_DIR, 'max-report.json');
let loginLost = false;
const IDS = ((ARGS.match(/--ids ([\d,]+)/) || [])[1] || '').split(',').filter(Boolean).map(Number);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const WORK = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'hh-radar'); // вне репозитория: claude -p не подхватывает правила проекта

const log = (...a) => console.log(new Date().toLocaleString('sv-SE').slice(0, 16), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Cookie входа: hh присылает обновленные значения в Set-Cookie — копим их и отдаем run.ps1 (state/hh-cookie.new → .env).
const JAR = new Map((process.env.HH_COOKIE || '').trim().replace(/^cookie:\s*/i, '').split(/;\s*/)
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
async function hhFetch(url, hops = 5) {
  const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { 'User-Agent': UA, 'Accept-Language': 'ru', Cookie: jarHeader() } });
  takeCookies(r);
  const loc = r.headers.get('location');
  if (r.status >= 300 && r.status < 400 && loc && hops) return hhFetch(new URL(loc, url).href, hops - 1);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.text();
}

// Данные страницы hh лежат в <template id="HH-Lux-InitialState"> — JSON с HTML-сущностями.
const decode = s => s.replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
function pageState(html) {
  const m = html.match(/<template[^>]*id="HH-Lux-InitialState"[^>]*>([\s\S]*?)<\/template>/);
  if (!m) throw new Error('нет HH-Lux-InitialState (капча или смена верстки)');
  return JSON.parse(decode(m[1]));
}
const flat = (arr, key) => (arr || []).flatMap(x => (x && x[key]) || []);
const htmlText = s => decode(String(s || '').replace(/<\/(p|li|h\d)>|<br\s*\/?>/gi, '\n').replace(/<li>/gi, '• ').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

// Грубый фильтр по полям, без модели: полная занятость, вахта и рабочий день от 8 часов — сразу мимо.
const LONG = /^HOURS_(8|9|1\d|2\d)$/;
function prefilter(v) {
  if (['FULL', 'FLY_IN_FLY_OUT'].includes(v.employmentForm)) return 'полная занятость/вахта';
  const hours = flat(v.workingHours, 'workingHoursElement');
  if (hours.length && hours.every(h => LONG.test(h))) return `рабочий день ${hours.join(',')}`;
  const formats = flat(v.workFormats, 'workFormatsElement');
  if (!formats.includes('REMOTE') && !(CFG.homeAreas || []).includes(Number(v.area?.['@id']))) return `на месте вне своего города (${v.area?.name})`;
  return null;
}

// Стоп-слова в названии вакансии (config.stopTitles, регулярные выражения без учета регистра).
const STOP = new RegExp(CFG.stopTitles.join('|'), 'i');

// Поиск по всей выдаче hh с фильтрами владельца (config.query), без подборки под резюме.
// Чужие рубрики (professionalRoleIds из config.cutRoles) отсекаются до модели; рубрика не из списка — к оценке.
// hh листает выдачу не дальше ~40 страниц (~800 вакансий): если найдено больше, поиск идет сразу по своим рубрикам
// (professional_role из кластера выдачи, кроме cutRoles) группами, в каждой из которых не больше ~700 вакансий.
const PAGE_CAP = 700;
async function collect() {
  const byId = new Map(), dropped = [], cut = {};
  const base = `${CFG.host}/search/vacancy?${CFG.query}&search_period=${PERIOD}&order_by=publication_time&items_on_page=50`;
  let seen = 0, stopped = 0, twinCount = 0;
  const twins = new Set(), taken = new Set();
  const first = pageState(await hhFetch(base));
  // С живым входом hh отдает userType "applicant"; "anonymous" — cookie протухли, поиск идет без фильтров соискателя.
  if (first.userType === 'anonymous') { loginLost = true; log('вход hh слетел: страница поиска открыта анонимно'); }
  const total = first.vacancySearchResult.totalResults;
  let parts = [''];
  if (total > PAGE_CAP) {
    const groups = Object.values(first.searchClusters?.professional_role?.groups || {})
      .filter(g => !CFG.cutRoles.includes(Number(g.id))).sort((a, b) => b.count - a.count);
    parts = [];
    let cur = [], sum = 0;
    for (const g of groups) {
      if (cur.length && sum + g.count > PAGE_CAP) { parts.push(cur); cur = []; sum = 0; }
      cur.push(g.id); sum += g.count;
    }
    if (cur.length) parts.push(cur);
    parts = parts.map(ids => ids.map(id => `&professional_role=${id}`).join(''));
    log(`найдено ${total} — больше, чем отдает hh; ищу по своим рубрикам (${groups.length}) в ${parts.length} запр.`);
  }
  for (const part of parts) for (let p = 0, got = 0; p < (CFG.maxPages || 40); p++) {
    await sleep(CFG.pauseMs);
    const res = pageState(await hhFetch(`${base}${part}&page=${p}`)).vacancySearchResult;
    got += res.vacancies.length;
    for (const v of res.vacancies) {
      if (taken.has(v.vacancyId)) continue;
      taken.add(v.vacancyId);
      seen++;
      const roles = flat(v.professionalRoleIds, 'professionalRoleId');
      if (roles.length && roles.every(r => CFG.cutRoles.includes(r))) { cut[roles[0]] = (cut[roles[0]] || 0) + 1; continue; }
      if (STOP.test(v.name)) { stopped++; continue; }
      // одна вакансия, размещенная в нескольких городах, — оценивать один раз
      const twin = `${v.company?.id || v.company?.name}|${v.name.trim().toLowerCase()}`;
      if (twins.has(twin)) { twinCount++; continue; }
      twins.add(twin);
      const why = prefilter(v);
      if (why) { dropped.push(`${v.vacancyId} ${v.name} — ${why}`); continue; }
      byId.set(v.vacancyId, { id: v.vacancyId, name: v.name, url: `${CFG.host}/vacancy/${v.vacancyId}`, twin, resumes: new Set(), responses: v.totalResponsesCount });
    }
    if (!res.vacancies.length || got >= res.totalResults) break;
  }
  const nCut = Object.values(cut).reduce((a, b) => a + b, 0);
  log(`поиск за ${PERIOD} дн.: найдено ${total}, собрано ${seen}, чужие рубрики ${nCut}, стоп-слова ${stopped}, дубли ${twinCount}, фильтр по полям ${dropped.length}, к оценке ${byId.size}`);
  return { list: [...byId.values()], dropped };
}

const criteria = name => [`${name}.md`, `${name}.example.md`].map(f => path.join(DIR, '..', 'criteria', f)).find(p => fs.existsSync(p));
const SELECTION = criteria('hh');
const PROMPT = () => `Ты отбираешь вакансии hh.ru для владельца. Ниже его инструкция отбора — следуй ей буквально, главное в ней — время.

${fs.readFileSync(SELECTION, 'utf8')}

Дана одна вакансия в JSON: поля hh (employmentForm, workFormats, workingHours, workScheduleByDays, civilLawContracts — договоры ГПХ, acceptLaborContract — трудовой договор), description — полный текст. Читай текст целиком: заголовок «удаленно» не гарантирует свободный график.

Ответ — ТОЛЬКО один JSON-объект без пояснений и без markdown, ключи:
{"id":число,"verdict":"go"|"ask"|"offer"|"skip","resume":"какому резюме подходит лучше всего, коротко","why":"главная причина вердикта, до 100 символов","schedule":"что известно о графике, часах и связи, до 100 символов","risks":["риск, до 80 символов", ...],"question":"что спросить у работодателя (для ask, иначе пустая строка)","pitch":"для offer — первая фраза отклика с предложением автоматизации, словами задач из вакансии, до 250 символов; иначе пустая строка"}

Вакансия:
`;

function parseVerdict(raw) {
  const s = String(raw).replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('нет JSON-объекта: ' + s.slice(0, 200));
  const o = JSON.parse(s.slice(a, b + 1));
  if (!['go', 'ask', 'offer', 'skip'].includes(o.verdict)) throw new Error('неизвестный verdict: ' + o.verdict);
  return o;
}

async function evaluate(w) {
  const V = pageState(await hhFetch(w.url)).vacancyView.vacancyFull.vacancy;
  const c = V.compensation || {};
  w.salary = c.from || c.to ? `${c.from || ''}–${c.to || ''} ${c.currencyCode || ''}${c.gross ? ' до вычета' : ''}`.trim() : 'не указана';
  w.company = V.company?.visibleName || V.company?.name || '';
  w.area = V.area?.name || '';
  const it = {
    id: w.id, name: V.name, company: w.company, area: w.area, salary: w.salary,
    employmentForm: V.employmentForm, workFormats: flat(V.workFormats, 'workFormatsElement'),
    workingHours: flat(V.workingHours, 'workingHoursElement'), workScheduleByDays: flat(V.workScheduleByDays, 'workScheduleByDaysElement'),
    workExperience: V.workExperience, civilLawContracts: flat(V.civilLawContracts, 'civilLawContractsElement'), acceptLaborContract: V.acceptLaborContract,
    keySkills: (V.keySkills?.keySkill || V.keySkills || []).map?.(k => k.name || k) || [], responses: w.responses,
    description: htmlText(V.description).slice(0, 6000),
  };
  fs.mkdirSync(WORK, { recursive: true });
  const cmd = `claude -p --model ${CFG.model} --effort ${CFG.effort} --setting-sources project --tools "" --no-session-persistence --output-format json`;
  let out;
  // claude при ошибке (например, вышел из аккаунта) завершается с кодом 1, а причину пишет в JSON на stdout.
  try { out = execSync(cmd, { cwd: WORK, input: PROMPT() + JSON.stringify(it, null, 1), encoding: 'utf8', timeout: 600000, maxBuffer: 20 * 1024 * 1024 }); }
  catch (err) { try { out = err.stdout; JSON.parse(out); } catch { throw err; } }
  const res = JSON.parse(out);
  if (res.is_error) throw new Error('claude: ' + String(res.result).slice(0, 200));
  try { return parseVerdict(res.result); }
  catch (e) { throw new Error(`${e.message} | raw: ${String(res.result).slice(0, 300).replace(/\s+/g, ' ')}`); }
}

const ICON = { go: '🟢 ПОДХОДИТ', ask: '🟡 УТОЧНИТЬ', offer: '🔵 МОЖЕМ АВТОМАТИЗИРОВАТЬ', skip: '🔴 МИМО' };
function cardText(w, e) {
  const lines = [ICON[e.verdict], `**${w.name}** — ${w.company} (${w.area})`, `💰 ${w.salary} · откликов ${w.responses ?? '?'} · резюме: ${e.resume || [...w.resumes].join('; ')}`,
    `🕒 ${e.schedule}`, `Почему: ${e.why}`];
  const risks = (Array.isArray(e.risks) ? e.risks : []).filter(Boolean);
  if (risks.length) lines.push('Риски:', ...risks.map(x => `• ${x}`));
  if (e.verdict === 'ask' && e.question) lines.push(`❓ ${e.question}`);
  if (e.verdict === 'offer' && e.pitch) lines.push(`✉️ ${e.pitch}`);
  return lines.join('\n');
}

(async () => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!JAR.size) throw new Error('нет cookie входа (секрет hh-cookie)');
  const { list, dropped } = await collect();
  // state/seen.json: уже оцененные вакансии (по id и по паре «работодатель|название») повторно не оцениваются; --ids — оценить заново.
  const SEEN_FILE = path.join(STATE_DIR, 'seen.json');
  const seenDb = fs.existsSync(SEEN_FILE) ? JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')) : {};
  const todo = IDS.length ? list.filter(w => IDS.includes(w.id)) : ALL ? list : list.filter(w => !seenDb[w.id] && !seenDb[w.twin]);
  if (!IDS.length && !ALL) log(`уже оценены раньше: ${list.length - todo.length}, новых к оценке: ${todo.length}`);
  for (const d of dropped) log('  фильтр:', d);
  if (COUNT_ONLY) { for (const w of todo) log('  к оценке:', w.id, w.name); return; }
  const evals = [], failed = [];
  const t0 = Date.now();
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, CFG.parallel || 1) }, async () => {
    while (next < todo.length) {
      const w = todo[next++];
      try {
        const e = await evaluate(w);
        evals.push({ w, e });
        seenDb[w.id] = seenDb[w.twin] = { v: e.verdict, d: new Date().toISOString().slice(0, 10) };
        fs.writeFileSync(SEEN_FILE, JSON.stringify(seenDb));
      }
      catch (err) { failed.push(err.message.slice(0, 200)); log(`вакансия ${w.id}: ошибка оценки — ${err.message}`.slice(0, 500)); }
      await sleep(CFG.pauseMs);
    }
  }));
  const rank = { go: 0, ask: 1, offer: 2, skip: 3 };
  evals.sort((a, b) => rank[a.e.verdict] - rank[b.e.verdict]);
  for (const { w, e } of evals) console.log(`\n${'─'.repeat(40)}\n${cardText(w, e)}\n${w.url}`);
  log(`итог: оценено ${evals.length}, 🟢 ${evals.filter(x => x.e.verdict === 'go').length}, 🟡 ${evals.filter(x => x.e.verdict === 'ask').length}, 🔵 ${evals.filter(x => x.e.verdict === 'offer').length}, 🔴 ${evals.filter(x => x.e.verdict === 'skip').length}, ${Math.round((Date.now() - t0) / 1000)} с`);
  if (failed.length) log(`ошибок оценки: ${failed.length}`);
  if (MAX) fs.writeFileSync(MAX_REPORT, JSON.stringify({ loginLost, evaluated: evals.length, failed: failed.length, failReason: failed[0],
    cards: evals.filter(x => x.e.verdict !== 'skip').map(({ w, e }) => `${cardText(w, e)}
${w.url}`) }));
  if (jarChanged) { fs.writeFileSync(path.join(STATE_DIR, 'hh-cookie.new'), jarHeader()); log('cookie hh обновлены'); }
})().catch(e => {
  log('FAIL', e.message);
  if (MAX) fs.writeFileSync(MAX_REPORT, JSON.stringify({ loginLost, error: e.message.slice(0, 300) }));
  process.exit(1);
});
