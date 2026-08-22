/* ═══════════════════════════════════════════
   КАТАЛОГ — ГЛАВНЫЙ ИСТОЧНИК ЦЕН.

   Это единственное место, где сумма заказа считается всерьёз.
   Фронтенд присылает только id и количество; всё остальное —
   названия, цены, итог — берётся отсюда. Ничему, что пришло
   с браузера, доверять нельзя: подменить цену в запросе может
   кто угодно, и при боевой ЮKassa это стоило бы вам денег.

   Добавляете позицию — впишите её сюда И в assets/catalog.js
   с тем же id. Позиция с id, которого здесь нет, отклоняется.
   ═══════════════════════════════════════════ */

export const CATALOG = {
  'tasting':         { name: 'Дегустационный сет',  price: 1500 },
  'tier-s':          { name: 'Ярус «Малый»',        price: 6500 },
  'tier-m':          { name: 'Ярус «Средний»',      price: 11000 },
  'tier-l':          { name: 'Ярус «Большой»',      price: 18000 },
  'delivery-city':   { name: 'Доставка по Самаре',  price: 1000 },
  'delivery-region': { name: 'Доставка по области', price: 2500 },
};

export const MAX_QTY = 99;
export const MAX_LINES = 20;

/**
 * Пересчитывает корзину по серверным ценам.
 * @param {Array<{id:string, qty:number}>} items — то, что прислал браузер
 * @returns {{lines:Array, amount:number}} — состав и сумма в рублях
 * @throws если корзина пуста, слишком длинная или содержит чужой id
 */
export function priceCart(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Корзина пуста');
  }
  if (items.length > MAX_LINES) {
    throw new Error('Слишком много позиций в заказе');
  }

  const merged = new Map();
  for (const raw of items) {
    const id = raw && typeof raw.id === 'string' ? raw.id : null;
    if (!id || !CATALOG[id]) {
      throw new Error('Неизвестная позиция: ' + String(id));
    }
    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      throw new Error('Некорректное количество для позиции ' + id);
    }
    merged.set(id, Math.min(MAX_QTY, (merged.get(id) || 0) + qty));
  }

  const lines = [];
  let amount = 0;
  for (const [id, qty] of merged) {
    const p = CATALOG[id];              // цена ТОЛЬКО отсюда, не из запроса
    const sum = p.price * qty;
    amount += sum;
    lines.push({ id, name: p.name, price: p.price, qty, sum });
  }

  if (amount <= 0) throw new Error('Нулевая сумма заказа');
  return { lines, amount };
}
