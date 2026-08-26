/* ═══════════════════════════════════════════
   Корзина. Хранится в localStorage, поэтому переживает
   переход между главной, оформлением и экраном оплаты.

   Внутри лежат ТОЛЬКО id и количество. Ни цен, ни сумм —
   их считает воркер при создании платежа. Даже если кто-то
   подменит localStorage, подделать сумму заказа не выйдет.
   ═══════════════════════════════════════════ */
(function () {
  'use strict';

  var KEY = 'tpl_cart_v1';
  var listeners = [];

  function read() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw
        .filter(function (r) { return r && typeof r.id === 'string'; })
        .map(function (r) {
          return { id: r.id, qty: Math.max(1, Math.min(99, parseInt(r.qty, 10) || 1)) };
        });
    } catch (e) {
      return [];
    }
  }

  function write(items) {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {}
    listeners.forEach(function (fn) { fn(items); });
  }

  function item(id) {
    var list = window.CATALOG || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  var Cart = {
    /** Позиции корзины, обогащённые данными каталога для показа. */
    lines: function () {
      return read()
        .map(function (r) {
          var p = item(r.id);
          if (!p) return null;                       // позиция исчезла из каталога
          return { id: r.id, qty: r.qty, name: p.name, price: p.price, unit: p.unit };
        })
        .filter(Boolean);
    },

    /** Только то, что уходит на сервер: id и количество. */
    payload: function () {
      return read();
    },

    count: function () {
      return read().reduce(function (n, r) { return n + r.qty; }, 0);
    },

    /** Предварительная сумма для показа. Итоговую называет сервер. */
    subtotal: function () {
      return Cart.lines().reduce(function (s, l) { return s + l.price * l.qty; }, 0);
    },

    add: function (id, qty) {
      if (!item(id)) return false;
      var list = read();
      var found = null;
      for (var i = 0; i < list.length; i++) if (list[i].id === id) found = list[i];
      if (found) found.qty = Math.min(99, found.qty + (qty || 1));
      else list.push({ id: id, qty: qty || 1 });
      write(list);
      return true;
    },

    setQty: function (id, qty) {
      qty = parseInt(qty, 10) || 0;
      var list = read().filter(function (r) { return r.id !== id || qty > 0; });
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) list[i].qty = Math.max(1, Math.min(99, qty));
      }
      write(list);
    },

    remove: function (id) {
      write(read().filter(function (r) { return r.id !== id; }));
    },

    clear: function () { write([]); },

    onChange: function (fn) { listeners.push(fn); },

    /* Перерисовать всё, что показывает корзину. Нужно, когда цены
       поменялись не из-за действий человека — например, владелец
       правил их через бота, и правки доехали уже после отрисовки. */
    refresh: function () { listeners.forEach(function (fn) { fn(read()); }); },
  };

  /** 11000 → «11 000 ₽» */
  Cart.money = function (v) {
    return new Intl.NumberFormat('ru-RU').format(Math.round(v)) + ' ₽';
  };

  /** Корзина открыта в двух вкладках — держим их синхронно. */
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) listeners.forEach(function (fn) { fn(read()); });
  });

  window.Cart = Cart;
})();
