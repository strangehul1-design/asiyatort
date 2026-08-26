/**
 * Хранилище заявок.
 *
 * Заявка записывается ДО попытки отправки. Если Telegram недоступен,
 * упал воркер или кончился интернет — имя и телефон клиента уже лежат
 * в хранилище, и заявка не потеряна.
 *
 * Хранилище — KV Cloudflare, привязка REQUESTS в wrangler.toml.
 * Если привязки нет, функции молча ничего не делают: сайт продолжает
 * работать, но защиты от потери нет — воркер сообщит об этом в ответе.
 */

const PREFIX = 'req:';
const KEEP_DAYS = 180;                 // сколько хранить заявку
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;  // суммарный предел на сохранение фото

/** Есть ли куда сохранять */
export function ready(env) {
  return Boolean(env.REQUESTS && typeof env.REQUESTS.put === 'function');
}

function keyFor(id) {
  return PREFIX + id;
}

/** Читаемый идентификатор: по нему заявку легко найти глазами */
export function newId() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
                `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${stamp}-${rnd}`;
}

/**
 * Кладёт заявку в хранилище со статусом «не доставлена».
 * Фото сохраняем, только если они помещаются в разумный объём —
 * телефон клиента важнее референса, его теряем в последнюю очередь.
 */
export async function save(env, id, record, files) {
  if (!ready(env)) return false;

  /* Сюда приходят уже вычитанные вложения: { name, type, size, bytes }.
     Читать поток здесь нельзя — его ждёт ещё и отправка в Telegram. */
  const photos = [];
  let budget = MAX_PHOTO_BYTES;
  for (const f of files || []) {
    if (!f || !f.bytes || f.size > budget) {
      photos.push({ name: f?.name || 'вложение', size: f?.size || 0, saved: false });
      continue;
    }
    try {
      let bin = '';
      const bytes = new Uint8Array(f.bytes);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      photos.push({ name: f.name, size: f.size, saved: true, type: f.type || 'image/jpeg', data: btoa(bin) });
      budget -= f.size;
    } catch {
      photos.push({ name: f.name, size: f.size, saved: false });
    }
  }

  const value = {
    id,
    created: new Date().toISOString(),
    kind: record.kind,
    title: record.title,
    rows: record.rows,
    text: record.text,
    html: record.html,
    photos,
    status: 'pending',
    delivered: [],
    errors: [],
    attempts: 0,
  };

  try {
    await env.REQUESTS.put(keyFor(id), JSON.stringify(value), {
      expirationTtl: KEEP_DAYS * 24 * 60 * 60,
    });
    return true;
  } catch {
    return false;
  }
}

/** Отмечает результат доставки. */
export async function markResult(env, id, delivered, errors) {
  if (!ready(env)) return;
  try {
    const raw = await env.REQUESTS.get(keyFor(id));
    if (!raw) return;
    const v = JSON.parse(raw);
    v.attempts = (v.attempts || 0) + 1;
    v.delivered = delivered;
    v.errors = errors;
    v.status = delivered.length ? 'delivered' : 'pending';
    if (v.status === 'delivered') {
      // Доставлено — фото больше не нужны, освобождаем место
      v.photos = (v.photos || []).map(p => ({ name: p.name, size: p.size, saved: false }));
    }
    await env.REQUESTS.put(keyFor(id), JSON.stringify(v), {
      expirationTtl: KEEP_DAYS * 24 * 60 * 60,
    });
  } catch {
    /* не смогли обновить статус — сама заявка на месте, это главное */
  }
}

/** Список недоставленных заявок. */
export async function listPending(env, limit = 50) {
  if (!ready(env)) return [];
  const out = [];
  try {
    const list = await env.REQUESTS.list({ prefix: PREFIX, limit: 1000 });
    for (const k of list.keys) {
      if (out.length >= limit) break;
      const raw = await env.REQUESTS.get(k.name);
      if (!raw) continue;
      const v = JSON.parse(raw);
      if (v.status === 'pending') out.push(v);
    }
  } catch {
    /* пусто лучше, чем падение */
  }
  return out;
}

/** Полный список — для выгрузки владельцем. */
export async function listAll(env, limit = 200) {
  if (!ready(env)) return [];
  const out = [];
  try {
    const list = await env.REQUESTS.list({ prefix: PREFIX, limit: 1000 });
    for (const k of list.keys) {
      if (out.length >= limit) break;
      const raw = await env.REQUESTS.get(k.name);
      if (!raw) continue;
      const v = JSON.parse(raw);
      // Фото в выгрузку не отдаём — иначе ответ раздуется до мегабайт
      v.photos = (v.photos || []).map(p => ({ name: p.name, size: p.size, saved: p.saved }));
      out.push(v);
    }
  } catch {
    /* пусто лучше, чем падение */
  }
  out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return out;
}

/** Разворачивает сохранённые фото обратно в готовые байты для повторной отправки. */
export function photosToFiles(record) {
  const out = [];
  for (const p of record.photos || []) {
    if (!p.saved || !p.data) continue;
    try {
      const bin = atob(p.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      out.push({ name: p.name, type: p.type || 'image/jpeg', size: bytes.length, bytes: bytes.buffer });
    } catch {
      /* битое вложение пропускаем, текст всё равно уйдёт */
    }
  }
  return out;
}
