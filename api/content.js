/**
 * Редактируемое содержимое сайта.
 *
 * Правки из бота лежат в том же KV-хранилище, что и заявки, но под
 * своим префиксом — отдельное заводить не нужно.
 *
 * На сайте исходные тексты остаются прямо в HTML. Здесь хранятся только
 * изменения поверх них. Поэтому если воркер недоступен или правок ещё
 * нет, сайт показывает исходный текст, а не пустые места. Поисковики
 * тоже видят настоящее содержимое, а не заглушки.
 */

const KEY = 'content:site';
const MEDIA = 'media:';
const KEEP = 400 * 24 * 60 * 60;          // правки живут дольше заявок

/* ═══════════════════════════════════════════
   Что можно менять.
   group — раздел меню в боте
   label — как поле называется для человека
   type  — text | multiline | number | url | photo
   ═══════════════════════════════════════════ */
export const FIELDS = {
  /* ── Контакты ── */
  'contact.phone':     { group: 'contacts', label: 'Телефон',                type: 'text' },
  'contact.vk_dm':     { group: 'contacts', label: 'Ссылка «написать нам»',  type: 'url' },
  'contact.vk_group':  { group: 'contacts', label: 'Ссылка на сообщество',   type: 'url' },
  'contact.email':     { group: 'contacts', label: 'Почта',                  type: 'text' },
  'contact.address':   { group: 'contacts', label: 'Адрес студии',           type: 'text' },
  'contact.hours':     { group: 'contacts', label: 'Часы дегустаций',        type: 'text' },
  'contact.zone':      { group: 'contacts', label: 'Зона доставки',          type: 'text' },

  /* ── Тексты ── */
  'text.hero_lead':    { group: 'texts', label: 'Абзац на первом экране',  type: 'multiline' },
  'text.works_note':   { group: 'texts', label: 'Подпись к разделу «Работы»', type: 'multiline' },
  'text.tasting_note': { group: 'texts', label: 'Описание дегустации',      type: 'multiline' },
  'text.delivery_note':{ group: 'texts', label: 'Примечание о доставке',    type: 'multiline' },
};

/* Товары каталога: у каждого имя, описание и цена */
export const PRODUCTS = [
  ['tasting',         'Дегустационный сет'],
  ['tier-s',          'Ярус «Малый»'],
  ['tier-m',          'Ярус «Средний»'],
  ['tier-l',          'Ярус «Большой»'],
  ['delivery-city',   'Доставка по Самаре'],
  ['delivery-region', 'Доставка по области'],
];

for (const [id, title] of PRODUCTS) {
  FIELDS[`price.${id}.name`]  = { group: 'prices', product: id, label: 'Название',  type: 'text' };
  FIELDS[`price.${id}.desc`]  = { group: 'prices', product: id, label: 'Описание',  type: 'multiline' };
  FIELDS[`price.${id}.value`] = { group: 'prices', product: id, label: 'Цена, ₽',   type: 'number' };
  FIELDS[`price.${id}.note`]  = { group: 'prices', product: id, label: 'Примечание', type: 'text' };
}

/* Отзывы — редактируем те, что уже стоят на сайте */
export const REVIEWS = ['1', '2', '3'];
for (const n of REVIEWS) {
  FIELDS[`review.${n}.text`]   = { group: 'reviews', review: n, label: 'Текст отзыва', type: 'multiline' };
  FIELDS[`review.${n}.author`] = { group: 'reviews', review: n, label: 'Кто и когда',  type: 'text' };
}

/* Фотослоты. Подписи повторяют то, что написано в пустых рамках сайта. */
export const PHOTOS = [
  ['hero',        'Главное фото на первом экране'],
  ['work-1',      'Работа: Ольга и Артём'],
  ['work-2',      'Работа: Дарья и Илья'],
  ['work-3',      'Работа: Мария и Никита'],
  ['work-4',      'Работа: Анна и Сергей'],
  ['work-5',      'Работа: Вера и Максим'],
  ['deliv-1',     'Доставка: погрузка ярусов'],
  ['deliv-2',     'Доставка: дорога'],
  ['deliv-3',     'Доставка: сборка на площадке'],
  ['gal-1',       'Галерея: со свадьбы Ольги и Артёма'],
  ['gal-2',       'Галерея: нарезка торта'],
  ['gal-3',       'Галерея: десертный стол'],
  ['gal-4',       'Галерея: шатёр на Волге'],
  ['gal-5',       'Галерея: живые цветы на ярусах'],
];
for (const [id, label] of PHOTOS) {
  FIELDS[`photo.${id}`] = { group: 'photos', label, type: 'photo' };
}

export const GROUPS = [
  ['contacts', '📞 Контакты'],
  ['prices',   '💰 Цены'],
  ['reviews',  '💬 Отзывы'],
  ['photos',   '🖼 Фотографии'],
  ['texts',    '📝 Тексты'],
];

/* ═══════════════════════════════════════════
   Чтение и запись
   ═══════════════════════════════════════════ */

export function ready(env) {
  return Boolean(env.REQUESTS && typeof env.REQUESTS.put === 'function');
}

/** Все правки одним объектом. */
export async function getAll(env) {
  if (!ready(env)) return {};
  try {
    const raw = await env.REQUESTS.get(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function getOne(env, key) {
  const all = await getAll(env);
  return all[key];
}

/** Записывает значение. Пустая строка означает «вернуть как было». */
export async function setOne(env, key, value) {
  if (!ready(env)) return false;
  if (!FIELDS[key]) return false;
  try {
    const all = await getAll(env);
    if (value === null || value === '') delete all[key];
    else all[key] = value;
    await env.REQUESTS.put(KEY, JSON.stringify(all), { expirationTtl: KEEP });
    return true;
  } catch {
    return false;
  }
}

/* ── Фотографии ── */

export async function putPhoto(env, key, bytes, type) {
  if (!ready(env)) return false;
  try {
    let bin = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    await env.REQUESTS.put(MEDIA + key, JSON.stringify({
      data: btoa(bin), type: type || 'image/jpeg', at: new Date().toISOString(),
    }), { expirationTtl: KEEP });
    // Отмечаем в правках, чтобы сайт знал: для этого слота фото есть
    await setOne(env, `photo.${key}`, 'yes');
    return true;
  } catch {
    return false;
  }
}

export async function getPhoto(env, key) {
  if (!ready(env)) return null;
  try {
    const raw = await env.REQUESTS.get(MEDIA + key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const bin = atob(v.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, type: v.type };
  } catch {
    return null;
  }
}

export async function deletePhoto(env, key) {
  if (!ready(env)) return false;
  try {
    await env.REQUESTS.delete(MEDIA + key);
    await setOne(env, `photo.${key}`, '');
    return true;
  } catch {
    return false;
  }
}

/** Поля одного раздела, по порядку объявления. */
export function fieldsOf(group) {
  return Object.entries(FIELDS).filter(([, f]) => f.group === group);
}
