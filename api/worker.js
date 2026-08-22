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

import { CATALOG, priceCart } from './catalog.js';
import { notifyAll, now } from './notify.js';

const MAX_FILES = 6;
const MAX_FILE_BYTES = 9 * 1024 * 1024;   // Telegram sendPhoto не берёт больше 10 МБ

const LABELS = {
  date: 'Дата свадьбы', place: 'Место проведения', guests: 'Количество гостей',
  filling: 'Начинка', service: 'Презентация и нарезка', channel: 'Способ связи',
  name: 'Имя', phone: 'Телефон', email: 'Почта', time: 'Удобное время',
  more: 'Дополнительно', people: 'Количество человек',
};

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
    rows.push([LABELS[key] || key, humanDate(key, v.trim()).slice(0, 2000)]);
  }
  if (kind === 'order' && form.get('decor_later')) {
    rows.push(['Декор', 'референса нет — обсудить индивидуально']);
  }

  const files = form.getAll('refs')
    .filter(f => f && typeof f === 'object' && f.size > 0 && f.size <= MAX_FILE_BYTES)
    .slice(0, MAX_FILES);
  if (files.length) rows.push(['Референсы', `${files.length} шт. — ниже`]);

  const result = await notifyAll(env, {
    title: TITLES[kind], rows, footer: `Сайт «Торт по любви» · ${now()}`,
  }, files);

  // Хоть один канал доставил — заявка принята
  if (!result.delivered.length && result.failed.length) {
    return json({ ok: false, error: result.errors[0] || 'Не удалось доставить заявку' }, 502, headers);
  }
  return json({ ok: true, delivered: result.delivered }, 200, headers);
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
    priced = priceCart(body.items);
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
    rows.push([LABELS[key] || key, humanDate(key, v.trim()).slice(0, 2000)]);
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
      return json({ ok: true, catalog: CATALOG }, 200, headers);
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
