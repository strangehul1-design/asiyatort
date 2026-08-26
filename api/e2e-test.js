/**
 * Сквозная проверка приёма заявок.
 *
 * Поднимает заявку через настоящий воркер, ловит её поддельным
 * Telegram и проверяет весь путь: подписи полей, заголовок формы,
 * фото, поведение при сбое и досылку недоставленного.
 *
 * Запуск (в трёх окнах):
 *   node fake-telegram.js 8787
 *   npx wrangler dev --config wrangler.dev.toml --port 8788 --local
 *   node e2e-test.js
 */

const TG = 'http://localhost:8787';
const API = 'http://localhost:8788';
const ORIGIN = 'http://localhost:4455';
const ADMIN = 'test-admin-key';

let passed = 0, failed = 0;

function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const j = r => r.json();
const inbox = () => fetch(TG + '/_inbox').then(j);
const reset = () => fetch(TG + '/_reset').then(j);
const mode = m => fetch(TG + '/_mode?m=' + m).then(j);

/** Однопиксельный PNG — минимальное настоящее изображение. */
function tinyPng() {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const bin = Buffer.from(b64, 'base64');
  return new Blob([bin], { type: 'image/png' });
}

function orderForm(withPhoto) {
  const f = new FormData();
  f.append('form_type', 'order');
  f.append('company', '');                       // ловушка пустая — обычный человек
  f.append('date', '2026-09-12');
  f.append('place', 'Усадьба «Волга», Самара');
  f.append('guests', '90');
  f.append('filling', 'Шоколад · солёная карамель · пекан');
  f.append('service', 'Нужны');
  f.append('name', 'Ольга');
  f.append('phone', '+7 999 111-22-33');
  f.append('channel', 'ВКонтакте');
  f.append('time', 'будни после 18:00');
  f.append('more', 'Без орехов — аллергия у гостя');
  if (withPhoto) f.append('refs', tinyPng(), 'referens-dekora.png');
  return f;
}

function tastingForm() {
  const f = new FormData();
  f.append('form_type', 'tasting');
  f.append('company', '');
  f.append('date', '2026-07-04');
  f.append('people', '2');
  f.append('name', 'Мария');
  f.append('phone', '+7 999 444-55-66');
  f.append('channel', 'Звонок');
  return f;
}

const post = body => fetch(API + '/submit', {
  method: 'POST', body, headers: { Origin: ORIGIN },
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

(async () => {
  console.log('\n═══ 1. Заявка на торт с фото ═══');
  await mode('ok'); await reset();
  let r = await post(orderForm(true));
  check('сервер принял заявку', r.body.ok === true, JSON.stringify(r.body));
  check('доставлено в telegram', (r.body.delivered || []).includes('telegram'),
        'delivered=' + JSON.stringify(r.body.delivered));

  let box = await inbox();
  const msg = box.messages.find(m => m.method === 'sendMessage');
  const pic = box.messages.find(m => m.method === 'sendPhoto');

  check('пришло текстовое сообщение', Boolean(msg));
  check('заголовок помечает форму заказа',
        msg && /Заявка на торт/.test(msg.text) && !/дегустаци/i.test(msg.text), msg && msg.text);
  check('подписи полей, а не сырой JSON',
        msg && /Дата свадьбы:/.test(msg.text) && /Телефон:/.test(msg.text) && !/[{}]/.test(msg.text));
  check('дата по-человечески 12.09.2026', msg && /12\.09\.2026/.test(msg.text));
  check('телефон на месте', msg && /\+7 999 111-22-33/.test(msg.text));
  check('форматирование HTML', msg && msg.parse_mode === 'HTML' && /<b>/.test(msg.text));
  check('пришло фото', Boolean(pic), 'методы: ' + box.messages.map(m => m.method).join(', '));
  check('у фото есть подпись с именем файла',
        pic && /referens-dekora\.png/.test(pic.caption || ''), pic && pic.caption);
  check('фото непустое', pic && pic.photo && pic.photo.bytes > 0,
        pic && JSON.stringify(pic.photo));

  console.log('\n═══ 2. Дегустация помечается иначе ═══');
  await reset();
  r = await post(tastingForm());
  check('сервер принял', r.body.ok === true);
  box = await inbox();
  const t = box.messages.find(m => m.method === 'sendMessage');
  check('другой заголовок', t && /Запись на дегустацию/.test(t.text), t && t.text);
  check('поля дегустации', t && /Количество человек:<\/b> 2/.test(t.text), t && t.text);
  check('дата подписана как «Желаемая», а не «свадьбы»',
        t && /Желаемая дата/.test(t.text) && !/Дата свадьбы/.test(t.text), t && t.text);
  check('фото не слалось', !box.messages.some(m => m.method === 'sendPhoto'));

  console.log('\n═══ 3. Telegram недоступен — заявка не теряется ═══');
  await mode('fail'); await reset();
  r = await post(orderForm(false));
  check('клиент видит успех (данные сохранены)', r.body.ok === true, JSON.stringify(r.body));
  check('сервер признаёт, что не доставил', (r.body.delivered || []).length === 0);
  check('пометка «сохранено»', r.body.saved === true, JSON.stringify(r.body));
  check('выдан номер заявки', typeof r.body.id === 'string' && r.body.id.length > 5, r.body.id);
  const lostId = r.body.id;

  const pend = await fetch(API + '/pending?key=' + ADMIN, { headers: { Origin: ORIGIN } }).then(j);
  check('заявка видна в списке недоставленных',
        pend.ok && pend.items.some(i => i.id === lostId), JSON.stringify(pend).slice(0, 200));
  const saved = (pend.items || []).find(i => i.id === lostId);
  check('в хранилище лежит телефон клиента',
        saved && /\+7 999 111-22-33/.test(saved.text), saved && saved.text);

  console.log('\n═══ 4. Telegram починился — недоставленное досылается ═══');
  await mode('ok'); await reset();
  r = await post(tastingForm());
  check('новая заявка доставлена', (r.body.delivered || []).includes('telegram'));
  check('досланы старые', (r.body.resent || 0) >= 1, 'resent=' + r.body.resent);
  box = await inbox();
  check('в Telegram пришло больше одного сообщения', box.messages.length >= 2,
        'сообщений: ' + box.messages.length);
  check('среди них — повторная отправка',
        box.messages.some(m => /Повторная отправка/.test(m.text || '')),
        box.messages.map(m => (m.text || '').slice(0, 60)).join(' | '));

  const after = await fetch(API + '/pending?key=' + ADMIN, { headers: { Origin: ORIGIN } }).then(j);
  check('список недоставленных опустел',
        !(after.items || []).some(i => i.id === lostId), JSON.stringify(after.count));

  console.log('\n═══ 5. Чужие не видят заявки ═══');
  const noKey = await fetch(API + '/pending', { headers: { Origin: ORIGIN } });
  check('без ключа — 404', noKey.status === 404, 'HTTP ' + noKey.status);
  const badKey = await fetch(API + '/pending?key=подбор', { headers: { Origin: ORIGIN } });
  check('с неверным ключом — 404', badKey.status === 404, 'HTTP ' + badKey.status);

  console.log('\n═══ 6. Спам-ловушка ═══');
  await reset();
  const spam = orderForm(false);
  spam.set('company', 'ООО Ромашка');           // бот заполнил скрытое поле
  r = await post(spam);
  check('бот получает вежливый успех', r.body.ok === true);
  box = await inbox();
  check('но в Telegram ничего не ушло', box.messages.length === 0,
        'сообщений: ' + box.messages.length);

  console.log('\n' + '─'.repeat(46));
  console.log(`Пройдено: ${passed}   Провалено: ${failed}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('\nтест упал:', e); process.exit(1); });
