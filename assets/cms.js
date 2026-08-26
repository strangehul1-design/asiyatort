/* ═══════════════════════════════════════════
   Подстановка правок, сделанных владельцем через Telegram-бота.

   Исходные тексты остаются прямо в HTML. Этот скрипт только
   заменяет те места, которые владелец действительно менял.
   Поэтому если воркер недоступен, правок ещё нет или скрипт не
   загрузился — сайт показывает исходный текст, а не пустоту.
   Поисковики по той же причине видят настоящее содержимое.

   Разметка:
     data-cms="ключ"        заменить текст внутри элемента
     data-cms-href="ключ"   заменить ссылку
     data-cms-photo="слот"  подставить фотографию вместо рамки
   ═══════════════════════════════════════════ */
(function () {
  'use strict';

  var base = (window.API_BASE || '').replace(/\/+$/, '');
  if (!base) return;                       // сервер не подключён — оставляем как есть

  /** 12000 → «12 000 ₽» */
  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) return null;
    return new Intl.NumberFormat('ru-RU').format(Math.round(v)) + ' ₽';
  }

  /** Как превратить значение в ссылку для разных полей */
  function hrefFor(key, value) {
    if (key === 'contact.phone') return 'tel:' + String(value).replace(/[^\d+]/g, '');
    if (key === 'contact.email') return 'mailto:' + String(value).trim();
    return String(value).trim();
  }

  function applyText(el, key, value) {
    // Цена показывается с разделителями и знаком рубля
    if (/^price\..+\.value$/.test(key)) {
      var m = money(value);
      if (m) el.textContent = m;
      return;
    }
    el.textContent = String(value);
  }

  /** Меняет пустую рамку на фотографию, сохраняя пропорции слота */
  function applyPhoto(box, slot) {
    var img = document.createElement('img');
    img.src = base + '/media/' + encodeURIComponent(slot);
    img.alt = (box.querySelector('.ph-label') || {}).textContent || '';
    /* Главное фото — первое, что видит посетитель: грузим сразу.
       Остальные откладываем, чтобы не тормозить открытие страницы. */
    img.loading = (slot === 'hero') ? 'eager' : 'lazy';
    if (slot === 'hero') img.fetchPriority = 'high';
    img.decoding = 'async';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';

    // Не показываем битую картинку: если не загрузилась — остаётся рамка
    img.onerror = function () { img.remove(); box.removeAttribute('data-cms-filled'); };
    img.onload = function () {
      Array.prototype.forEach.call(box.children, function (c) {
        if (c !== img) c.style.display = 'none';
      });
      box.style.padding = '0';
      box.setAttribute('data-cms-filled', '');
    };
    box.appendChild(img);
  }

  function apply(data) {
    if (!data) return;

    Array.prototype.forEach.call(document.querySelectorAll('[data-cms]'), function (el) {
      var key = el.getAttribute('data-cms');
      if (data[key] !== undefined && data[key] !== '') applyText(el, key, data[key]);
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-cms-href]'), function (el) {
      var key = el.getAttribute('data-cms-href');
      if (data[key] !== undefined && data[key] !== '') el.setAttribute('href', hrefFor(key, data[key]));
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-cms-photo]'), function (box) {
      var slot = box.getAttribute('data-cms-photo');
      if (data['photo.' + slot] === 'yes') applyPhoto(box, slot);
    });

    /* Цены в корзине обязаны совпадать с теми, что на карточках.
       Каталог на фронте — массив позиций, ищем по id. */
    if (Array.isArray(window.CATALOG)) {
      var touched = false;
      window.CATALOG.forEach(function (item) {
        var name = data['price.' + item.id + '.name'];
        var desc = data['price.' + item.id + '.desc'];
        var price = Number(data['price.' + item.id + '.value']);
        if (typeof name === 'string' && name.trim()) { item.name = name.trim(); touched = true; }
        if (typeof desc === 'string' && desc.trim()) { item.desc = desc.trim(); touched = true; }
        if (isFinite(price) && price >= 0) { item.price = Math.round(price); touched = true; }
      });
      // Корзина могла отрисоваться до того, как приехали правки
      if (touched && window.Cart && typeof window.Cart.refresh === 'function') {
        window.Cart.refresh();
      }
    }
  }

  fetch(base + '/content', { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d && d.ok) apply(d.content); })
    .catch(function () { /* сервер недоступен — на сайте остаётся исходный текст */ });
})();
