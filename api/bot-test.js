/**
 * Проверка бота-редактора.
 *
 * Изображает нажатия кнопок и присланные сообщения, как это делает
 * Telegram, и смотрит, что бот отвечает и что попадает в хранилище.
 *
 * Запуск (в трёх окнах):
 *   node fake-telegram.js 8787
 *   npx wrangler dev --config wrangler.dev.toml --port 8788 --local
 *   node bot-test.js
 */

const TG = 'http://localhost:8787';
const API = 'http://localhost:8788';
const OWNER = 111222333;
const STRANGER = 999999999;
const HOOK = 'test-hook-secret';

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + String(detail).slice(0, 300) : '')); }
}

const j = r => r.json();
const reset = () => fetch(TG + '/_reset').then(j);
const inbox = () => fetch(TG + '/_inbox').then(j);
const contentNow = () => fetch(API + '/content').then(j);

let updId = 1000;

function post(update, secret) {
  return fetch(API + '/telegram-webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret === undefined ? HOOK : secret,
    },
    body: JSON.stringify(update),
  });
}

const message = (text, from = OWNER) => post({
  update_id: updId++,
  message: { message_id: updId, chat: { id: from }, from: { id: from }, text },
});

const tap = (data, from = OWNER) => post({
  update_id: updId++,
  callback_query: {
    id: String(updId), data,
    from: { id: from },
    message: { message_id: 555, chat: { id: from } },
  },
});

/** Последний текст, который бот отправил или которым заменил экран. */
async function lastText() {
  const box = await inbox();
  const m = box.messages.filter(x => x.method === 'sendMessage' || x.method === 'editMessageText');
  return m.length ? m[m.length - 1].text : '';
}

(async () => {
  console.log('\n═══ 1. Посторонний не получает доступ ═══');
  await reset();
  await message('/start', STRANGER);
  let t = await lastText();
  check('чужому отказано', /служебный/i.test(t) && /vk\.me/.test(t), t);
  check('меню чужому не показано', !/Редактор сайта/.test(t), t);

  console.log('\n═══ 2. Без секрета Telegram-хук не отвечает ═══');
  const noSecret = await post({ update_id: 1, message: { chat: { id: OWNER }, text: '/start' } }, 'wrong-secret');
  check('чужой запрос отбит 404', noSecret.status === 404, 'HTTP ' + noSecret.status);

  console.log('\n═══ 3. Владельцу открывается меню ═══');
  await reset();
  await message('/start');
  t = await lastText();
  check('заголовок редактора', /Редактор сайта/.test(t), t);
  const box = await inbox();
  const kb = box.messages[box.messages.length - 1];
  check('есть кнопки разделов', Boolean(kb), 'нет сообщения');

  console.log('\n═══ 4. Правка телефона ═══');
  await reset();
  await tap('g:contacts');
  t = await lastText();
  check('открылся раздел контактов', /Контакты/.test(t), t);

  await tap('f:contact.phone');
  t = await lastText();
  check('бот просит новое значение', /Пришлите новое значение/.test(t), t);

  await message('+7 846 111-22-33');
  t = await lastText();
  check('бот подтвердил сохранение', /Сохранено/.test(t), t);

  let c = await contentNow();
  check('телефон записан в хранилище',
        c.content['contact.phone'] === '+7 846 111-22-33', JSON.stringify(c.content));

  console.log('\n═══ 5. Правка цены влияет на оплату ═══');
  await reset();
  await tap('g:prices');
  t = await lastText();
  check('открылся список товаров', /Выберите товар/.test(t), t);

  await tap('p:tier-m');
  t = await lastText();
  check('открылась карточка товара', /Ярус «Средний»/.test(t), t);

  await tap('f:price.tier-m.value');
  await message('13500');
  t = await lastText();
  check('цена сохранена', /Сохранено/.test(t), t);

  const cat = await fetch(API + '/catalog').then(j);
  check('каталог отдаёт новую цену', cat.catalog['tier-m'].price === 13500,
        JSON.stringify(cat.catalog['tier-m']));

  const pay = await fetch(API + '/create-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:4455' },
    body: JSON.stringify({
      items: [{ id: 'tier-m', qty: 2 }],
      customer: { name: 'Проверка', phone: '+70000000000', email: 'a@b.ru' },
      returnUrl: 'http://localhost:4455/success/',
    }),
  }).then(j);
  check('оплата считает по новой цене', pay.amount === 27000,
        'сумма=' + pay.amount + ' ожидалось 27000');

  console.log('\n═══ 6. Проверка введённого ═══');
  await reset();
  await tap('f:price.tier-m.value');
  await message('дорого');
  t = await lastText();
  check('текст вместо числа отклонён', /Нужно число/.test(t), t);

  await tap('f:contact.vk_dm');
  await message('просто слова');
  t = await lastText();
  check('не-ссылка отклонена', /ссылка целиком/.test(t), t);

  console.log('\n═══ 7. Возврат к исходному ═══');
  await reset();
  await tap('del:contact.phone');
  t = await lastText();
  check('бот подтвердил возврат', /Вернули как было/.test(t), t);
  c = await contentNow();
  check('правка удалена из хранилища',
        c.content['contact.phone'] === undefined, JSON.stringify(c.content));

  console.log('\n═══ 8. Отзывы ═══');
  await reset();
  await tap('g:reviews');
  t = await lastText();
  check('список отзывов открылся', /Выберите, какой поправить/.test(t), t);
  await tap('r:2');
  await tap('f:review.2.author');
  await message('Анна и Сергей · август');
  c = await contentNow();
  check('отзыв подписан заново',
        c.content['review.2.author'] === 'Анна и Сергей · август', JSON.stringify(c.content));

  console.log('\n═══ 9. Фотослоты ═══');
  await reset();
  await tap('g:photos');
  t = await lastText();
  check('список слотов открылся', /Фотографии/.test(t), t);
  await tap('f:photo.gal-1');
  t = await lastText();
  check('бот ждёт именно фото', /Пришлите фотографию/.test(t), t);
  await message('это текст, а не фото');
  t = await lastText();
  check('текст вместо фото отклонён', /Жду именно фотографию/.test(t), t);

  console.log('\n' + '─'.repeat(46));
  console.log(`Пройдено: ${passed}   Провалено: ${failed}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('\nтест упал:', e); process.exit(1); });
