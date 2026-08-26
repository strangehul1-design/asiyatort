/**
 * Telegram-бот: редактор содержимого сайта.
 *
 * Управление кнопками, команд запоминать не нужно. Отправьте /start — и дальше
 * по меню: раздел → что менять → прислать новое значение.
 *
 * Доступ только у владельца: сравниваем chat id с TELEGRAM_CHAT_ID.
 * Чужой, нашедший бота, не увидит ни меню, ни данных.
 */

import * as content from './content.js';

const STATE = 'bot:state:';
const STATE_TTL = 60 * 60;                  // час на одну правку

/* ═══════════════════════════════════════════
   Обращения к Telegram
   ═══════════════════════════════════════════ */
function api(env, method) {
  const host = (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  return `${host}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function call(env, method, payload) {
  const res = await fetch(api(env, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({}));
}

const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function send(env, chat, text, keyboard) {
  return call(env, 'sendMessage', {
    chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
  });
}

function edit(env, chat, messageId, text, keyboard) {
  return call(env, 'editMessageText', {
    chat_id: chat, message_id: messageId, text, parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
  });
}

/* ═══════════════════════════════════════════
   Что бот сейчас ждёт от владельца
   ═══════════════════════════════════════════ */
async function getState(env, chat) {
  if (!content.ready(env)) return null;
  try {
    const raw = await env.REQUESTS.get(STATE + chat);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function setState(env, chat, state) {
  if (!content.ready(env)) return;
  try {
    if (!state) await env.REQUESTS.delete(STATE + chat);
    else await env.REQUESTS.put(STATE + chat, JSON.stringify(state), { expirationTtl: STATE_TTL });
  } catch { /* потеря состояния не страшна: меню всегда доступно */ }
}

/* ═══════════════════════════════════════════
   Экраны
   ═══════════════════════════════════════════ */
const HOME_TEXT =
  '<b>Редактор сайта</b>\n\n' +
  'Здесь меняется то, что видят посетители: контакты, цены, отзывы, ' +
  'фотографии и тексты.\n\n' +
  'Изменения появляются на сайте сразу — перезаливать ничего не нужно.\n\n' +
  'Выберите раздел:';

function homeKeyboard() {
  const rows = content.GROUPS.map(([id, title]) => [{ text: title, callback_data: 'g:' + id }]);
  rows.push([{ text: '🌐 Открыть сайт', url: 'https://strangehul1-design.github.io/asiyatort/' }]);
  return rows;
}

/** Список полей раздела. У цен — сначала выбор товара. */
async function groupScreen(env, group) {
  if (group === 'prices') {
    const rows = content.PRODUCTS.map(([id, title]) => [{ text: title, callback_data: 'p:' + id }]);
    rows.push([{ text: '‹ Назад', callback_data: 'home' }]);
    return { text: '<b>Цены</b>\n\nВыберите товар:', keyboard: rows };
  }

  if (group === 'reviews') {
    const overrides = await content.getAll(env);
    const rows = content.REVIEWS.map(n => {
      const who = overrides[`review.${n}.author`] || `Отзыв ${n}`;
      return [{ text: who, callback_data: 'r:' + n }];
    });
    rows.push([{ text: '‹ Назад', callback_data: 'home' }]);
    return { text: '<b>Отзывы</b>\n\nВыберите, какой поправить:', keyboard: rows };
  }

  const overrides = await content.getAll(env);
  const fields = content.fieldsOf(group);
  const rows = fields.map(([key, f]) => {
    const changed = overrides[key] ? ' ✏️' : '';
    return [{ text: f.label + changed, callback_data: 'f:' + key }];
  });
  rows.push([{ text: '‹ Назад', callback_data: 'home' }]);

  const title = (content.GROUPS.find(g => g[0] === group) || [, group])[1];
  const hint = group === 'photos'
    ? '\n\nГалочка — фото уже загружено. Нажмите на слот, чтобы заменить.'
    : '\n\nКарандаш — значение уже менялось.';
  return { text: `<b>${esc(title)}</b>${hint}`, keyboard: rows };
}

/** Поля одного товара. */
async function productScreen(env, id) {
  const overrides = await content.getAll(env);
  const title = (content.PRODUCTS.find(p => p[0] === id) || [, id])[1];
  const rows = ['name', 'desc', 'value', 'note'].map(part => {
    const key = `price.${id}.${part}`;
    const f = content.FIELDS[key];
    const now = overrides[key];
    const shown = now ? ` — ${String(now).slice(0, 24)}` : '';
    return [{ text: f.label + shown, callback_data: 'f:' + key }];
  });
  rows.push([{ text: '‹ К списку товаров', callback_data: 'g:prices' }]);
  return {
    text: `<b>${esc(title)}</b>\n\nЧто поправить?\n\n` +
          '<i>Цена меняется и на карточке, и при оплате — считает всегда сервер.</i>',
    keyboard: rows,
  };
}

/** Поля одного отзыва. */
async function reviewScreen(env, n) {
  const overrides = await content.getAll(env);
  const rows = ['text', 'author'].map(part => {
    const key = `review.${n}.${part}`;
    const f = content.FIELDS[key];
    const now = overrides[key];
    return [{ text: f.label + (now ? ' ✏️' : ''), callback_data: 'f:' + key }];
  });
  rows.push([{ text: '‹ К отзывам', callback_data: 'g:reviews' }]);
  const cur = overrides[`review.${n}.text`];
  return {
    text: `<b>Отзыв ${n}</b>\n\n` +
          (cur ? `Сейчас: <i>${esc(String(cur).slice(0, 300))}</i>\n\n` : '') +
          'Что поправить?',
    keyboard: rows,
  };
}

/** Экран одного поля: показать текущее и попросить новое. */
async function fieldScreen(env, key) {
  const f = content.FIELDS[key];
  if (!f) return { text: 'Такого поля нет.', keyboard: [[{ text: '‹ В меню', callback_data: 'home' }]] };

  const overrides = await content.getAll(env);
  const cur = overrides[key];
  const back = f.product ? 'p:' + f.product
             : f.review ? 'r:' + f.review
             : 'g:' + f.group;

  if (f.type === 'photo') {
    const has = cur === 'yes';
    const rows = [];
    if (has) rows.push([{ text: '🗑 Убрать фото', callback_data: 'del:' + key }]);
    rows.push([{ text: '‹ Назад', callback_data: back }]);
    return {
      text: `<b>${esc(f.label)}</b>\n\n` +
            (has ? 'Фото загружено. Пришлите новое, чтобы заменить.\n\n'
                 : 'Фото пока нет — на сайте здесь пустая рамка.\n\n') +
            '<b>Пришлите фотографию сообщением.</b>\n' +
            '<i>Отправляйте как фото, не как файл.</i>',
      keyboard: rows,
      await: key,
    };
  }

  const rows = [];
  if (cur !== undefined) rows.push([{ text: '↩️ Вернуть как было', callback_data: 'del:' + key }]);
  rows.push([{ text: '‹ Назад', callback_data: back }]);

  const hint = f.type === 'number' ? '\n<i>Только число, без пробелов и знака рубля.</i>'
             : f.type === 'url' ? '\n<i>Полная ссылка, начиная с https://</i>'
             : '';

  return {
    text: `<b>${esc(f.label)}</b>\n\n` +
          (cur !== undefined
            ? `Сейчас: <code>${esc(String(cur))}</code>\n\n`
            : 'Сейчас показывается то, что записано в самом сайте.\n\n') +
          '<b>Пришлите новое значение сообщением.</b>' + hint,
    keyboard: rows,
    await: key,
  };
}

/* ═══════════════════════════════════════════
   Проверка присланного значения
   ═══════════════════════════════════════════ */
function validate(field, raw) {
  const v = String(raw).trim();
  if (!v) return { error: 'Пустое значение. Пришлите текст или нажмите «Вернуть как было».' };
  if (v.length > 600) return { error: 'Слишком длинно — уложитесь в 600 знаков.' };

  if (field.type === 'number') {
    const n = Number(v.replace(/[\s ]/g, '').replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) return { error: 'Нужно число. Например: 12000' };
    if (n > 10000000) return { error: 'Слишком большая сумма — проверьте, не лишний ли ноль.' };
    return { value: String(Math.round(n)) };
  }

  if (field.type === 'url') {
    if (!/^https?:\/\/[^\s]+$/i.test(v)) {
      return { error: 'Нужна ссылка целиком, начиная с https://' };
    }
  }
  return { value: v };
}

/* ═══════════════════════════════════════════
   Точка входа: разбор события от Telegram
   ═══════════════════════════════════════════ */
export async function handleUpdate(env, update) {
  const owner = String(env.TELEGRAM_CHAT_ID || '');
  const msg = update.message;
  const cq = update.callback_query;
  const chat = String(msg?.chat?.id ?? cq?.message?.chat?.id ?? '');

  if (!chat) return;

  // Бот отвечает только владельцу
  if (!owner || chat !== owner) {
    if (msg) await send(env, chat, 'Этот бот принимает заявки только для владельца сайта.');
    return;
  }

  if (!content.ready(env)) {
    await send(env, chat, 'Хранилище не подключено — редактировать пока нечего. ' +
                          'Проверьте привязку REQUESTS в настройках воркера.');
    return;
  }

  /* ── Нажатие кнопки ── */
  if (cq) {
    const data = String(cq.data || '');
    const mid = cq.message.message_id;
    await call(env, 'answerCallbackQuery', { callback_query_id: cq.id });

    if (data === 'home') {
      await setState(env, chat, null);
      await edit(env, chat, mid, HOME_TEXT, homeKeyboard());
      return;
    }
    if (data.startsWith('g:')) {
      await setState(env, chat, null);
      const s = await groupScreen(env, data.slice(2));
      await edit(env, chat, mid, s.text, s.keyboard);
      return;
    }
    if (data.startsWith('p:')) {
      await setState(env, chat, null);
      const s = await productScreen(env, data.slice(2));
      await edit(env, chat, mid, s.text, s.keyboard);
      return;
    }
    if (data.startsWith('r:')) {
      await setState(env, chat, null);
      const s = await reviewScreen(env, data.slice(2));
      await edit(env, chat, mid, s.text, s.keyboard);
      return;
    }
    if (data.startsWith('f:')) {
      const key = data.slice(2);
      const s = await fieldScreen(env, key);
      if (s.await) await setState(env, chat, { key: s.await });
      await edit(env, chat, mid, s.text, s.keyboard);
      return;
    }
    if (data.startsWith('del:')) {
      const key = data.slice(4);
      const f = content.FIELDS[key];
      if (f?.type === 'photo') await content.deletePhoto(env, key.replace(/^photo\./, ''));
      else await content.setOne(env, key, '');
      await setState(env, chat, null);
      const s = await fieldScreen(env, key);
      await edit(env, chat, mid, '✅ Вернули как было.\n\n' + s.text, s.keyboard);
      if (s.await) await setState(env, chat, { key: s.await });
      return;
    }
    return;
  }

  /* ── Обычное сообщение ── */
  if (!msg) return;

  const text = String(msg.text || '').trim();

  if (text === '/start' || text === '/menu' || text === '/help') {
    await setState(env, chat, null);
    await send(env, chat, HOME_TEXT, homeKeyboard());
    return;
  }

  const state = await getState(env, chat);
  if (!state?.key) {
    await send(env, chat,
      'Чтобы что-то изменить, откройте меню: /start\n\n' +
      '<i>Заявки с сайта приходят сюда же отдельными сообщениями.</i>',
      homeKeyboard());
    return;
  }

  const field = content.FIELDS[state.key];
  if (!field) { await setState(env, chat, null); return; }

  /* Фотография */
  if (field.type === 'photo') {
    const photo = msg.photo?.[msg.photo.length - 1];
    if (!photo) {
      await send(env, chat, 'Жду именно фотографию. Отправьте её как фото, не файлом.');
      return;
    }
    const info = await call(env, 'getFile', { file_id: photo.file_id });
    const path = info?.result?.file_path;
    if (!path) { await send(env, chat, 'Не удалось забрать файл у Telegram. Попробуйте ещё раз.'); return; }

    const host = (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
    const fileRes = await fetch(`${host}/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
    if (!fileRes.ok) { await send(env, chat, 'Файл не скачался. Попробуйте ещё раз.'); return; }

    const bytes = await fileRes.arrayBuffer();
    if (bytes.byteLength > 6 * 1024 * 1024) {
      await send(env, chat, 'Фотография тяжелее 6 МБ — пришлите поменьше.');
      return;
    }
    const slot = state.key.replace(/^photo\./, '');
    const ok = await content.putPhoto(env, slot, bytes, 'image/jpeg');
    await setState(env, chat, null);
    await send(env, chat,
      ok ? `✅ Фото обновлено: <b>${esc(field.label)}</b>\nОткройте сайт — оно уже там.`
         : 'Не удалось сохранить фото. Попробуйте ещё раз.',
      homeKeyboard());
    return;
  }

  /* Текст или число */
  const checked = validate(field, text);
  if (checked.error) { await send(env, chat, '⚠️ ' + checked.error); return; }

  const ok = await content.setOne(env, state.key, checked.value);
  await setState(env, chat, null);
  await send(env, chat,
    ok ? `✅ Сохранено: <b>${esc(field.label)}</b>\n\n<code>${esc(checked.value)}</code>\n\n` +
         'Изменение уже на сайте.'
       : 'Не удалось сохранить. Попробуйте ещё раз.',
    homeKeyboard());
}
