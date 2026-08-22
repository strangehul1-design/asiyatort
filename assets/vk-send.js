/* ═══════════════════════════════════════════
   Отправка заявки через ВКонтакте.

   Пока у сайта нет серверного доступа к VK API, заявка уходит
   руками клиента: собираем читаемый текст, кладём в буфер обмена,
   показываем окно и уводим в личку сообщества — там остаётся
   вставить и отправить.

   Текст всегда виден в окне: если браузер запретил буфер обмена
   (так бывает без https или в старых версиях), человек скопирует
   вручную и заявка всё равно не потеряется.
   ═══════════════════════════════════════════ */
(function () {
  'use strict';

  var VK_DM = 'https://vk.me/asiyatort';        // личка сообщества
  var VK_GROUP = 'https://vk.ru/asiyatort';     // страница сообщества
  var DELAY = 6;                                 // секунд до автоперехода

  /* Подписи полей: как показать человеку то, что он заполнил */
  var LABELS = {
    date: 'Дата свадьбы', place: 'Место проведения', guests: 'Количество гостей',
    filling: 'Начинка', service: 'Презентация и нарезка', channel: 'Способ связи',
    name: 'Имя', phone: 'Телефон', email: 'Почта', time: 'Удобное время',
    more: 'Дополнительно', people: 'Количество человек'
  };

  var ORDER = {
    order:    ['date', 'place', 'guests', 'filling', 'service', 'name', 'phone', 'channel', 'time', 'more'],
    tasting:  ['date', 'people', 'name', 'phone', 'channel'],
    checkout: ['name', 'phone', 'email', 'channel', 'date', 'more']
  };

  /* У дегустации поле «дата» значит другое — подписываем точнее */
  var OVERRIDE = {
    tasting: { date: 'Желаемая дата' }
  };

  var TITLES = {
    order:    'Заявка на свадебный торт',
    tasting:  'Запись на дегустацию',
    checkout: 'Заказ с сайта'
  };

  function humanDate(key, v) {
    if (key === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      var p = v.split('-');
      return p[2] + '.' + p[1] + '.' + p[0];
    }
    return v;
  }

  /** Собирает текст заявки из формы. */
  function buildText(form, kind, extra) {
    var data = new FormData(form);
    var keys = ORDER[kind] || ORDER.order;
    var out = [TITLES[kind] || TITLES.order, ''];

    keys.forEach(function (k) {
      var v = data.get(k);
      if (typeof v !== 'string' || !v.trim()) return;
      var label = (OVERRIDE[kind] && OVERRIDE[kind][k]) || LABELS[k] || k;
      out.push(label + ': ' + humanDate(k, v.trim()));
    });

    if (kind === 'order' && data.get('decor_later')) {
      out.push('Декор: референса нет, обсудим индивидуально');
    }
    var files = data.getAll('refs').filter(function (f) { return f && f.size > 0; });
    if (files.length) {
      out.push('Референсы: ' + files.length + ' шт. — приложу в сообщении');
    }

    (extra || []).forEach(function (row) { out.push(row[0] + ': ' + row[1]); });

    out.push('');
    out.push('Отправлено с сайта · ' + new Date().toLocaleString('ru-RU'));
    return out.join('\n');
  }

  /** Кладёт текст в буфер. Возвращает промис с true/false. */
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; },
                                                      function () { return fallback(text); });
    }
    return Promise.resolve(fallback(text));
  }

  function fallback(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  /* ── Окно ── */
  var veil, box, timer, tick;

  function build() {
    if (veil) return;
    veil = document.createElement('div');
    veil.className = 'vk-veil';
    veil.setAttribute('role', 'dialog');
    veil.setAttribute('aria-modal', 'true');
    veil.setAttribute('aria-labelledby', 'vk-title');
    veil.innerHTML =
      '<div class="vk-box">' +
        '<button class="vk-x" type="button" aria-label="Закрыть">' +
          '<svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5L5 19"/></svg>' +
        '</button>' +
        '<div class="vk-ic"><svg viewBox="0 0 24 24">' +
          '<rect x="8" y="3" width="12" height="15" rx="2"/>' +
          '<path d="M16 18v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1"/>' +
        '</svg></div>' +
        '<h2 class="vk-title" id="vk-title">Текст заявки скопирован</h2>' +
        '<p class="vk-lead" id="vk-lead"></p>' +
        '<span class="vk-copied" id="vk-copied">' +
          '<svg viewBox="0 0 24 24"><path d="m5 13 4.5 4.5L19 7"/></svg>' +
          '<span id="vk-copied-text">Скопировано в буфер</span>' +
        '</span>' +
        '<div class="vk-text" id="vk-text"></div>' +
        '<div class="vk-actions">' +
          '<a class="btn btn--solid" id="vk-go" href="' + VK_DM + '" target="_blank" rel="noopener"><span>Открыть ВКонтакте' +
            '<svg viewBox="0 0 24 24"><path d="M4 12h16M14 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</span></a>' +
          '<button class="btn btn--ghost" type="button" id="vk-recopy"><span>Скопировать ещё раз</span></button>' +
        '</div>' +
        '<p class="vk-count" id="vk-count"></p>' +
      '</div>';
    document.body.appendChild(veil);
    box = veil.querySelector('.vk-box');

    veil.querySelector('.vk-x').addEventListener('click', close);
    veil.addEventListener('click', function (e) { if (e.target === veil) close(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && veil.classList.contains('is-on')) close();
    });
    // Человек сам нажал — перехода по таймеру больше не нужно
    veil.querySelector('#vk-go').addEventListener('click', function () { stopTimer(); clearCounter(); });
  }

  /* Гасит только таймер. Подпись убирается отдельно там,
     где это уместно — иначе стирала бы счётчик сразу после установки. */
  function stopTimer() {
    clearInterval(timer);
    timer = null;
  }

  function clearCounter() {
    var c = document.getElementById('vk-count');
    if (c) c.textContent = '';
  }

  function close() {
    stopTimer();
    clearCounter();
    veil.classList.remove('is-on');
    document.body.style.overflow = '';
  }

  /**
   * Показывает окно с текстом заявки.
   * @param {string} text — что отправить в сообщество
   */
  function open(text) {
    build();
    document.getElementById('vk-text').textContent = text;
    document.getElementById('vk-lead').textContent =
      'Сейчас откроется наше сообщество ВКонтакте. Вставьте текст в сообщение и отправьте — так заявка точно дойдёт.';

    copy(text).then(function (ok) {
      var badge = document.getElementById('vk-copied');
      var label = document.getElementById('vk-copied-text');
      if (ok) {
        badge.classList.remove('is-warn');
        label.textContent = 'Скопировано в буфер';
      } else {
        badge.classList.add('is-warn');
        label.textContent = 'Скопируйте текст ниже вручную';
      }
    });

    veil.classList.add('is-on');
    document.body.style.overflow = 'hidden';
    document.getElementById('vk-go').focus();

    document.getElementById('vk-recopy').onclick = function () {
      var self = this, span = self.querySelector('span');
      copy(text).then(function (ok) {
        span.textContent = ok ? 'Скопировано' : 'Не вышло — выделите вручную';
        setTimeout(function () { span.textContent = 'Скопировать ещё раз'; }, 1600);
      });
    };

    // Мягкий автопереход: в этой же вкладке, чтобы не блокировал попап-фильтр
    stopTimer();
    tick = DELAY;
    var counter = document.getElementById('vk-count');
    counter.innerHTML = 'Перейдём автоматически через <b>' + tick + '</b> с';
    timer = setInterval(function () {
      tick -= 1;
      if (tick <= 0) {
        clearInterval(timer);
        timer = null;
        location.href = VK_DM;
        return;
      }
      counter.innerHTML = 'Перейдём автоматически через <b>' + tick + '</b> с';
    }, 1000);
  }

  window.VKSend = {
    open: open,
    buildText: buildText,
    DM: VK_DM,
    GROUP: VK_GROUP
  };
})();
