'use strict';
// Меню команд MAX-бота (видно по «/» в диалоге с ботом): PATCH /me/commands. Разово, после смены списка.
// Токен и сертификат - из окружения, из .env: MAX_BOT_TOKEN, NODE_EXTRA_CA_CERTS.
const COMMANDS = [
  { name: 'kwork', description: 'Новая подборка заказов kwork' },
  { name: 'hh', description: 'Подборка вакансий hh.ru' },
];
(async () => {
  const r = await fetch('https://platform-api2.max.ru/me/commands', {
    method: 'PATCH', headers: { Authorization: process.env.MAX_BOT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands: COMMANDS }), signal: AbortSignal.timeout(60000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`PATCH /me/commands → ${r.status} ${j.message || ''}`);
  console.log('OK, команды:', (j.commands || []).map(c => '/' + c.name).join(' '));
})().catch(e => { console.error('ошибка:', e.message); process.exit(1); });
