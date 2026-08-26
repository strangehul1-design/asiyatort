/* ═══════════════════════════════════════════
   Серверная часть сайта «Торт по любви».

   Маршруты:
     POST /submit               — заявки с форм сайта → Telegram + VK
     POST /create-payment       — создание платежа (сейчас демо, схема ЮKassa)
     POST /payment-notification — вебхук ЮKassa о статусе платежа
     ANY  /vk-callback          — Callback API сообщества: подтверждение + входящие
     GET  /catalog              — цены, которыми считает сервер (для сверки)

   Секретов в коде нет и быть не должно. Все ключи —
   через `wrangler secret put`, см. README-deploy.md.
   ═══════════════════════════════════════════ */

import { CATALOG, priceCart, effectiveCatalog } from './catalog.js';
import { notifyAll, now } from './notify.js';
import * as store from './store.js';
import * as content from './content.js';
import { handleUpdate } from './bot.js';

const MAX_FILES = 6;
const MAX_FILE_BYTES = 9 * 1024 * 1024;   // Telegram sendPhoto не берёт больше 10 МБ

const LABELS = {
  date: 'Дата свадьбы', place: 'Место проведения', guests: 'Количество гостей',
  filling: 'Начинка', service: 'Презентация и нарезка', channel: 'Способ связи',
  name: 'Имя', phone: 'Телефон', email: 'Почта', time: 'Удобное время',
  more: 'Дополнительно', people: 'Количество человек',
};

/* У дегустации поле date значит не дату свадьбы, а желаемый день визита.
   Подписи должны совпадать с теми, что показывает сайт. */
const LABEL_OVERRIDE = {
  tasting: { date: 'Желаемая дата' },
};

const labelFor = (kind, key) =>
  (LABEL_OVERRIDE[kind] && LABEL_OVERRIDE[kind][key]) || LABELS[key] || key;

const ORDER = {
  order:    ['date', 'place', 'guests', 'filling', 'service', 'name', 'phone', 'channel', 'time', 'more'],
  tasting:  ['date', 'people', 'name', 'phone', 'channel'],
  checkout: ['name', 'phone', 'email', 'channel', 'date', 'more'],
};

const TITLES = {
  order:    '🎂 Заявка на торт',
  tasting:  '🍰 Запись на дегустацию',
  checkout: '🧾 Заказ с оплатой',
  vk:       '💬 Сообщение из ВКонтакте',
};

const money = v => new Intl.NumberFormat('ru-RU').format(v) + ' ₽';

function humanDate(key, value) {
  if (key === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-');
    return `${d}.${m}.${y}`;
  }
  return value;
}

/* ── CORS ── */
function cors(origin, allowed) {
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : (allowed[0] || ''),
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
const json = (data, status, headers) => new Response(JSON.stringify(data), {
  status: status || 200,
  headers: { ...(headers || {}), 'Content-Type': 'application/json; charset=utf-8' },
});

/** Короткий читаемый номер заказа: ТПЛ-МЯUЖ8К2 */
function orderId() {
  const rnd = crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  const d = new Date();
  return `ТПЛ-${String(d.getDate()).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}-${rnd}`;
}

/* ═══════════════════════════════════════════
   POST /submit — формы сайта
   ═══════════════════════════════════════════ */
/**
 * GET /pending  — заявки, которые не ушли в Telegram
 * GET /requests — все заявки за последние полгода
 *
 * Закрыто ключом ADMIN_KEY: без него отдаём 404, чтобы посторонний
 * не мог перебором найти чужие телефоны.
 * Вызов: /pending?key=ВАШ_КЛЮЧ
 */
async function handleList(request, env, headers, onlyPending) {
  const key = new URL(request.url).searchParams.get('key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return new Response('Not found', { status: 404, headers });
  }
  if (!store.ready(env)) {
    return json({ ok: false, error: 'Хранилище не подключено: нет привязки REQUESTS' }, 200, headers);
  }
  const items = onlyPending ? await store.listPending(env, 100) : await store.listAll(env, 200);
  return json({ ok: true, count: items.length, items }, 200, headers);
}

async function handleSubmit(request, env, headers) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'Не удалось прочитать форму' }, 400, headers);
  }

  // Ловушка для ботов: человек это поле не видит
  if (String(form.get('company') || '').trim()) return json({ ok: true }, 200, headers);

  const kindRaw = String(form.get('form_type') || 'order');
  const kind = ORDER[kindRaw] ? kindRaw : 'order';

  const rows = [];
  for (const key of ORDER[kind]) {
    const v = form.get(key);
    if (typeof v !== 'string' || !v.trim()) continue;
    rows.push([labelFor(kind, key), humanDate(key, v.trim()).slice(0, 2000)]);
  }
  if (kind === 'order' && form.get('decor_later')) {
    rows.push(['Декор', 'референса нет — обсудить индивидуально']);
  }

  /* Файл из формы — поток, и отдаётся он ровно один раз. Дальше его
     ждут двое: хранилище и отправка в Telegram, а получателей может
     быть несколько. Поэтому вычитываем содержимое здесь, один раз,
     и передаём всем уже готовые байты. */
  const incoming = form.getAll('refs')
    .filter(f => f && typeof f === 'object' && f.size > 0 && f.size <= MAX_FILE_BYTES)
    .slice(0, MAX_FILES);

  const files = [];
  for (const f of incoming) {
    try {
      files.push({ name: f.name, type: f.type || 'image/jpeg', size: f.size, bytes: await f.arrayBuffer() });
    } catch {
      /* нечитаемое вложение пропускаем — текст заявки важнее */
    }
  }
  if (files.length) rows.push(['Референсы', `${files.length} шт. — ниже`]);

  const letter = {
    title: TITLES[kind], rows, footer: `Сайт «Торт по любви» · ${now()}`,
  };

  /* Сначала в хранилище, потом в Telegram.
     Порядок важен: если отправка упадёт или воркер оборвётся,
     имя и телефон клиента уже записаны и заявка не потеряется. */
  const id = store.newId();
  const saved = await store.save(env, id, {
    kind,
    title: letter.title,
    rows,
    text: plainOf(letter),
    html: htmlOf(letter),
  }, files);

  const result = await notifyAll(env, letter, files);
  await store.markResult(env, id, result.delivered, result.errors);

  // Заодно пробуем добить то, что не ушло в прошлые разы
  const resent = await retryPending(env);

  if (result.delivered.length) {
    return json({ ok: true, id, delivered: result.delivered, resent }, 200, headers);
  }

  /* Ни один канал не принял. Если заявка записана — для клиента это
     всё равно успех: данные у нас, владелец увидит их в /pending. */
  if (saved) {
    return json({
      ok: true, id, delivered: [], saved: true,
      note: 'Заявка сохранена, уведомление отправим позже',
    }, 200, headers);
  }

  // Не доставлено и не сохранено — честно говорим о провале,
  // сайт покажет запасной путь через сообщество ВКонтакте.
  return json({ ok: false, error: result.errors[0] || 'Не удалось доставить заявку' }, 502, headers);
}

/** Текстовая версия письма — её же кладём в хранилище. */
function plainOf(letter) {
  return [letter.title, '']
    .concat(letter.rows.map(([k, v]) => `${k}: ${v}`))
    .concat(letter.footer ? ['', letter.footer] : [])
    .join('\n');
}

function htmlOf(letter) {
  const esc = x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [`<b>${esc(letter.title)}</b>`, '']
    .concat(letter.rows.map(([k, v]) => `<b>${esc(k)}:</b> ${esc(v)}`))
    .concat(letter.footer ? ['', `<i>${esc(letter.footer)}</i>`] : [])
    .join('\n');
}

/**
 * Досылает заявки, которые раньше не ушли.
 * Вызывается на каждой новой заявке — отдельного планировщика не нужно.
 */
async function retryPending(env) {
  if (!store.ready(env)) return 0;
  const pending = await store.listPending(env, 5);
  let done = 0;
  for (const rec of pending) {
    const letter = {
      title: rec.title,
      rows: rec.rows || [],
      footer: `Повторная отправка · заявка от ${rec.created}`,
    };
    try {
      const r = await notifyAll(env, letter, store.photosToFiles(rec));
      await store.markResult(env, rec.id, r.delivered, r.errors);
      if (r.delivered.length) done += 1;
    } catch {
      /* следующая попытка будет со следующей заявкой */
    }
  }
  return done;
}

/* ═══════════════════════════════════════════
   POST /create-payment

   ▓▓▓ ЗДЕСЬ ПОДКЛЮЧАЕТСЯ БОЕВАЯ ЮKASSA ▓▓▓
   Ниже помечен единственный блок, который нужно заменить.
   Всё остальное — расчёт суммы, номер заказа, уведомления,
   редирект — уже работает так, как будет в бою.
   ═══════════════════════════════════════════ */
async function handleCreatePayment(request, env, headers) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Некорректный запрос' }, 400, headers);
  }

  if (String(body?.customer?.company || '').trim()) {
    return json({ ok: true, confirmation_url: '/' }, 200, headers);
  }

  /* ── Сумма считается ЗДЕСЬ, по серверному каталогу ──
     Браузер прислал только id и количество. Даже если в запросе
     были поля price или amount, они игнорируются. */
  let priced;
  try {
    // Цены берём с учётом правок из бота: на карточке и при оплате
    // сумма обязана совпадать.
    const overrides = await content.getAll(env);
    priced = priceCart(body.items, overrides);
  } catch (e) {
    return json({ ok: false, error: e.message }, 400, headers);
  }

  const order = orderId();
  const amount = priced.amount;                      // рубли, целые
  const c = body.customer || {};
  const returnUrl = typeof body.return_url === 'string' ? body.return_url : '';

  let confirmationUrl;

  /* ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
     НАЧАЛО БЛОКА, КОТОРЫЙ МЕНЯЕТСЯ НА БОЕВУЮ ЮKASSA
     ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ */
  if (env.YOOKASSA_SHOP_ID && env.YOOKASSA_SECRET_KEY) {
    // ── БОЕВОЙ РЕЖИМ ──
    // Включается сам, как только заданы секреты:
    //   wrangler secret put YOOKASSA_SHOP_ID
    //   wrangler secret put YOOKASSA_SECRET_KEY
    const auth = btoa(`${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`);
    const res = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Idempotence-Key': crypto.randomUUID(),   // защищает от двойного списания
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: { value: amount.toFixed(2), currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: returnUrl },
        description: `Заказ ${order}`,
        metadata: { order, phone: String(c.phone || '') },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.confirmation?.confirmation_url) {
      return json({ ok: false, error: data?.description || 'ЮKassa отклонила платёж' }, 502, headers);
    }
    confirmationUrl = data.confirmation.confirmation_url;
  } else {
    // ── ДЕМО-РЕЖИМ ──
    // Наружу не ходим. Отдаём ссылку на собственную страницу,
    // которая изображает платёжный экран кассы.
    const base = returnUrl.replace(/success\/?$/, '');
    confirmationUrl = `${base}demo-checkout/?order=${encodeURIComponent(order)}&amount=${amount}`;
  }
  /* ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
     КОНЕЦ БЛОКА
     ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ */

  // Заявку шлём сразу: человек мог начать оплату и передумать,
  // но контакт и состав заказа у вас уже есть.
  const rows = [['Заказ', order]];
  for (const key of ORDER.checkout) {
    const v = c[key];
    if (typeof v !== 'string' || !v.trim()) continue;
    rows.push([labelFor('checkout', key), humanDate(key, v.trim()).slice(0, 2000)]);
  }
  rows.push(['Состав', priced.lines.map(l => `${l.name} × ${l.qty} — ${money(l.sum)}`).join('; ')]);
  rows.push(['Сумма', money(amount)]);
  rows.push(['Статус', env.YOOKASSA_SHOP_ID ? 'ожидает оплаты' : 'демо-оплата']);

  await notifyAll(env, { title: TITLES.checkout, rows, footer: `Сайт «Торт по любви» · ${now()}` });

  return json({ ok: true, order, amount, confirmation_url: confirmationUrl }, 200, headers);
}

/* ═══════════════════════════════════════════
   POST /payment-notification — вебхук ЮKassa

   Касса шлёт сюда статус платежа. Заглушка уже принимает
   и логирует событие, чтобы структура была готова.

   ЧТО ДОБАВИТЬ ПРИ БОЕВОМ ЗАПУСКЕ:
   1. Проверить, что запрос действительно от ЮKassa —
      сверить IP из их списка либо включить подпись в кабинете.
   2. Сверить сумму из уведомления с суммой заказа в вашей базе:
      уведомление менять нельзя, но проверка защищает от ошибок.
   3. Пометить заказ оплаченным ТОЛЬКО по этому уведомлению,
      а не по возврату человека на /success — на страницу успеха
      можно зайти вручную, а вебхук подделать нельзя.
   ═══════════════════════════════════════════ */
async function handlePaymentNotification(request, env, headers) {
  let event;
  try {
    event = await request.json();
  } catch {
    return json({ ok: false }, 400, headers);
  }

  const type = event?.event || 'unknown';
  const obj = event?.object || {};
  const order = obj?.metadata?.order || '—';
  const value = obj?.amount?.value ? `${obj.amount.value} ${obj.amount.currency || 'RUB'}` : '—';

  if (type === 'payment.succeeded') {
    await notifyAll(env, {
      title: '✅ Оплата прошла',
      rows: [['Заказ', order], ['Сумма', value], ['Платёж', String(obj.id || '—')]],
      footer: `Уведомление ЮKassa · ${now()}`,
    });
  } else if (type === 'payment.canceled') {
    await notifyAll(env, {
      title: '⚠️ Оплата отменена',
      rows: [['Заказ', order], ['Сумма', value],
             ['Причина', String(obj?.cancellation_details?.reason || '—')]],
      footer: `Уведомление ЮKassa · ${now()}`,
    });
  }

  // ЮKassa ждёт 200; иначе будет повторять доставку
  return json({ ok: true }, 200, headers);
}

/* ═══════════════════════════════════════════
   /vk-callback — Callback API сообщества

   Сюда VK шлёт события. Два вида запросов:
     type=confirmation — ответить строкой из настроек сообщества
     type=message_new  — новое сообщение от клиента
   ═══════════════════════════════════════════ */
async function handleVkCallback(request, env) {
  let event;
  try {
    event = await request.json();
  } catch {
    return new Response('ok');
  }

  // 1. Подтверждение адреса: VK ждёт ровно строку, без кавычек и JSON
  if (event.type === 'confirmation') {
    return new Response(env.VK_CONFIRMATION || 'VK_CONFIRMATION не задан', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // 2. Секрет из настроек Callback API — чужой запрос не пройдёт
  if (env.VK_SECRET && event.secret !== env.VK_SECRET) {
    return new Response('ok');   // VK всегда ждёт 'ok', молча игнорируем
  }

  // 3. Клиент написал сообществу — эта заявка идёт в тот же поток
  if (event.type === 'message_new') {
    const m = event.object?.message || event.object || {};
    const rows = [
      ['Отправитель', `id${m.from_id || '—'}`],
      ['Сообщение', String(m.text || '').slice(0, 2000) || '(без текста)'],
    ];
    if (m.attachments?.length) rows.push(['Вложения', String(m.attachments.length)]);
    rows.push(['Ответить', `https://vk.com/gim${event.group_id || ''}?sel=${m.from_id || ''}`]);

    await notifyAll(env, { title: TITLES.vk, rows, footer: `ВКонтакте · ${now()}` });
  }

  // VK требует ровно 'ok', иначе будет слать событие повторно
  return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
}

/* ═══════════════════════════════════════════ */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // VK ходит сюда сам, без браузера — CORS ему не нужен и мешать не должен
    if (path === '/vk-callback') {
      if (request.method !== 'POST') return new Response('ok');
      return handleVkCallback(request, env);
    }

    const allowed = String(env.ALLOWED_ORIGINS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin, allowed);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    // Цены, по которым считает сервер — чтобы сверить с сайтом
    if (path === '/catalog' && request.method === 'GET') {
      const overrides = await content.getAll(env);
      return json({ ok: true, catalog: effectiveCatalog(overrides) }, 200, headers);
    }

    /* Правки содержимого — сайт забирает их при загрузке.
       Отдаём всем: это то же, что видно на самой странице. */
    if (path === '/content' && request.method === 'GET') {
      const data = await content.getAll(env);
      return new Response(JSON.stringify({ ok: true, content: data }), {
        status: 200,
        headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8',
                   'Cache-Control': 'public, max-age=30' },
      });
    }

    // Фотографии, загруженные через бота
    if (path.startsWith('/media/') && request.method === 'GET') {
      const key = decodeURIComponent(path.slice('/media/'.length));
      const pic = await content.getPhoto(env, key);
      if (!pic) return new Response('Not found', { status: 404, headers });
      return new Response(pic.bytes, {
        status: 200,
        headers: { ...headers, 'Content-Type': pic.type,
                   'Cache-Control': 'public, max-age=300' },
      });
    }

    // Заявки: недоставленные и все. Только для владельца, по ключу.
    if (path === '/pending' && request.method === 'GET') {
      return handleList(request, env, headers, true);
    }
    if (path === '/requests' && request.method === 'GET') {
      return handleList(request, env, headers, false);
    }

    /* Бот-редактор. Telegram шлёт сюда события; свой секрет он кладёт
       в заголовок, по нему и проверяем, что это действительно Telegram. */
    if (path === '/telegram-webhook') {
      if (request.method !== 'POST') return new Response('ok');
      const given = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (!env.TELEGRAM_WEBHOOK_SECRET || given !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response('Not found', { status: 404 });
      }
      let update;
      try { update = await request.json(); } catch { return new Response('ok'); }
      // Telegram повторяет событие, если не ответить быстро, — отвечаем сразу
      try { await handleUpdate(env, update); } catch (e) { console.log('bot:', e); }
      return new Response('ok');
    }

    // Вебхук кассы приходит с серверов ЮKassa, Origin у него нет
    if (path === '/payment-notification') {
      if (request.method !== 'POST') return json({ ok: false }, 405, headers);
      return handlePaymentNotification(request, env, headers);
    }

    // Остальное — только со своего сайта
    if (allowed.length && origin && !allowed.includes(origin)) {
      return json({ ok: false, error: 'origin' }, 403, headers);
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'Метод не поддерживается' }, 405, headers);

    if (path === '/submit')         return handleSubmit(request, env, headers);
    if (path === '/create-payment') return handleCreatePayment(request, env, headers);

    return json({ ok: false, error: 'Неизвестный адрес' }, 404, headers);
  },
};
