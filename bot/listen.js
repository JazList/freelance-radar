'use strict';
// Слушатель MAX-бота: "/kwork", "заказы" или kwork_now -> радар kwork; "/hh" или "вакансии" -> радар hh за сутки, карточки 🟢🟡🔵 владельцу (runHh);
// кнопки draft:<id> / redraft:<id> -> черновик отклика. Команды отвечают только владельцу (state/owner.json радара kwork, пишется по /start).
// Команды в меню «/» регистрирует set-commands.js (PATCH /me/commands); постоянной клавиатуры под полем ввода у MAX нет.
// Ровно один опросчик /updates на бота: два опросчика делят события, и кнопка срабатывает дважды или теряется. Токен и сертификат - из .env (run-listener.ps1).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_API = 'https://platform-api2.max.ru';
const STATE = path.join(__dirname, 'state');
const MARKER = path.join(STATE, 'marker.txt');
const OWNER_ID = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'kwork-radar', 'state', 'owner.json'), 'utf8')).userId;
const MAX_AGE_MS = 5 * 60 * 1000; // старые события (накопились, пока слушатель не работал) игнорируем
const log = m => console.log(`${new Date().toISOString()} ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, url, body) {
  const r = await fetch(MAX_API + url, { method, headers: { Authorization: process.env.MAX_BOT_TOKEN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`MAX ${url.split('?')[0]} → ${r.status} ${j.message || ''}`);
  return j;
}

// Радар hh по "/hh" или "вакансии": новые за сутки (уже оцененные пропускает seen.json), оценка Claude, отчет из state/max-report.json.
const HH = path.join(__dirname, '..', 'hh-radar');
let hhBusy = false;
function runHh() {
  if (hhBusy) { log('радар hh уже работает, пропуск'); return; }
  hhBusy = true;
  const report = path.join(HH, 'state', 'max-report.json');
  try { fs.unlinkSync(report); } catch {}
  const p = spawn('pwsh', ['-NoProfile', '-File', path.join(HH, 'run.ps1'), '-Period', '1', '-Max'], { stdio: 'ignore', windowsHide: true });
  p.on('exit', async c => {
    log(`радар hh завершен, код ${c}`);
    try {
      let r;
      try { r = JSON.parse(fs.readFileSync(report, 'utf8')); } catch { r = { error: `радар hh завершился без отчета, код ${c}` }; }
      if (r.loginLost) await say('⚠️ Вход в hh слетел: поиск идет без входа соискателя. Нужно обновить HH_COOKIE в .env.');
      if (r.failed) await say(`⚠️ Радар hh: не удалось оценить ${r.failed} из ${r.failed + r.evaluated} вакансий — ${r.failReason}`);
      if (r.error) await say(`Радар hh: ошибка — ${r.error}`);
      else if (!r.cards.length) { if (r.evaluated || !r.failed) await say(`hh.ru: новых подходящих вакансий нет (оценено ${r.evaluated})`); }
      else {
        await say(`hh.ru: подходящих ${r.cards.length} из ${r.evaluated} новых`);
        for (const card of r.cards) await say(card);
      }
    } finally { hhBusy = false; }
  });
  p.on('error', e => { hhBusy = false; log(`радар hh не запустился: ${e.message}`); });
}

// Радар kwork по кнопке kwork_now или слову "заказы": сбор и оценка Claude, 2-10 минут; карточки шлет сам радар.
const RADAR = path.join(__dirname, '..', 'kwork-radar', 'run.ps1');
let radarBusy = false;
function runRadar() {
  if (radarBusy) { log('радар уже работает, пропуск'); return; }
  radarBusy = true;
  const p = spawn('pwsh', ['-NoProfile', '-File', RADAR, '-Now'], { stdio: 'ignore', windowsHide: true });
  p.on('exit', c => { radarBusy = false; log(`радар по запросу завершен, код ${c}`); });
  p.on('error', e => { radarBusy = false; log(`радар не запустился: ${e.message}`); });
}

// Черновик отклика по кнопке draft:<id> / redraft:<id>: kwork-radar/draft.ps1, Claude пишет текст, владельцу уходит в MAX; на kwork ничего не отправляется.
const DRAFT = path.join(__dirname, '..', 'kwork-radar', 'draft.ps1');
const drafting = new Set();
function runDraft(id, again, comment) {
  if (drafting.has(id)) { log(`черновик ${id} уже готовится`); return; }
  drafting.add(id);
  const args = ['-NoProfile', '-File', DRAFT, '-Id', id];
  if (again) args.push('-Again');
  if (comment) args.push('-Comment:' + comment); // одним элементом массива, без склейки строки; форма с двоеточием - чтобы текст с дефисом не приняли за параметр
  const p = spawn('pwsh', args, { stdio: 'ignore', windowsHide: true });
  p.on('exit', c => { drafting.delete(id); log(`черновик ${id} завершен, код ${c}`); });
  p.on('error', e => { drafting.delete(id); log(`черновик не запустился: ${e.message}`); });
}

// Правка отклика: по redraft:<id> ждем следующий текст владельца (30 минут), он уходит в draft.ps1 как -Comment.
const AWAIT = path.join(__dirname, '..', 'kwork-radar', 'state', 'await-comment.json');
const AWAIT_MS = 30 * 60 * 1000;
let awaiting = null; // { id, until }
function setAwait(id) {
  awaiting = { id, until: Date.now() + AWAIT_MS };
  try { fs.mkdirSync(path.dirname(AWAIT), { recursive: true }); fs.writeFileSync(AWAIT, JSON.stringify(awaiting)); } catch (e) { log(`await-comment не записан: ${e.message}`); }
}
function takeAwait() {
  let a = awaiting;
  if (!a) { try { a = JSON.parse(fs.readFileSync(AWAIT, 'utf8')); } catch { a = null; } } // после перезапуска слушателя
  awaiting = null;
  try { fs.rmSync(AWAIT, { force: true }); } catch {}
  return a && a.until > Date.now() ? a : null;
}
const ref = id => `[${id}](https://kwork.ru/projects/${id}/view)`; // номер заказа ссылкой: голое число MAX принимает за телефон
const say = text => api('POST', `/messages?user_id=${OWNER_ID}`, { text, format: 'markdown' }).catch(e => log(e.message));

async function main() {
  fs.mkdirSync(STATE, { recursive: true });
  let marker = fs.existsSync(MARKER) ? fs.readFileSync(MARKER, 'utf8').trim() : '';
  log('слушатель запущен');
  for (;;) {
    try {
      const q = `/updates?timeout=30&limit=50&types=message_created,message_callback,bot_started${marker ? `&marker=${marker}` : ''}`;
      const j = await api('GET', q);
      for (const u of j.updates || []) {
        const fresh = !u.timestamp || Date.now() - u.timestamp < MAX_AGE_MS;
        if (u.update_type === 'message_callback') {
          const cb = u.callback || {};
          if (cb.user?.user_id === OWNER_ID && cb.payload === 'kwork_now' && fresh) {
            if (cb.callback_id) await api('POST', `/answers?callback_id=${encodeURIComponent(cb.callback_id)}`, { notification: 'Ищу заказы, это 2–10 минут' }).catch(e => log(e.message));
            log('кнопка kwork_now'); runRadar();
          } else if (cb.user?.user_id === OWNER_ID && /^(re)?draft:\d{1,12}$/.test(String(cb.payload)) && fresh) {
            const again = cb.payload.startsWith('re'), id = cb.payload.split(':')[1];
            if (again) {
              if (cb.callback_id) await api('POST', `/answers?callback_id=${encodeURIComponent(cb.callback_id)}`, { notification: 'Жду комментарий' }).catch(e => log(e.message));
              log(`кнопка ${cb.payload}: жду комментарий`); setAwait(id);
              await say(`Напишите, что поменять в отклике на заказ ${ref(id)}`);
            } else {
              if (cb.callback_id) await api('POST', `/answers?callback_id=${encodeURIComponent(cb.callback_id)}`, { notification: 'Готовлю ответ' }).catch(e => log(e.message));
              log(`кнопка ${cb.payload}`); runDraft(id, false);
            }
          }
        } else if (u.update_type === 'message_created') {
          const m = u.message || {};
          const t = String(m.body?.text || '').trim().toLowerCase();
          const cmd = t.replace(/^\//, '').replace(/@\S+$/, ''); // из меню «/» приходит "/kwork", в группе может прийти "/kwork@бот"
          if (m.sender?.user_id === OWNER_ID && fresh && ['kwork', 'заказы'].includes(cmd)) { log('команда заказов'); await say(radarBusy ? 'Поиск заказов уже идет' : 'Ищу заказы, это 2–10 минут'); runRadar(); }
          else if (m.sender?.user_id === OWNER_ID && fresh && ['hh', 'вакансии'].includes(cmd)) { log('команда вакансий hh'); await say(hhBusy ? 'Подборка hh уже собирается' : 'Ищу вакансии hh.ru за сутки, это 2–15 минут'); runHh(); }
          else if (m.sender?.user_id === OWNER_ID && fresh && t) {
            const a = takeAwait();
            if (a) {
              log(`комментарий к отклику ${a.id}`);
              if (drafting.has(a.id)) { setAwait(a.id); await say(`Отклик ${ref(a.id)} еще готовится, повторите комментарий чуть позже`); }
              else { await say('Готовлю исправленный вариант'); runDraft(a.id, true, String(m.body.text).trim()); }
            }
          }
        }
      }
      if (j.marker != null) { marker = String(j.marker); fs.writeFileSync(MARKER, marker); }
    } catch (e) { log(`ошибка опроса: ${e.message}`); await sleep(10000); }
  }
}
main();
