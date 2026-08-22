/**
 * Приёмник заявок с сайта → Telegram.
 *
 * Токен бота живёт здесь, в секретах Cloudflare, и никогда не попадает
 * на страницу. Сайт шлёт сюда обычный multipart/form-data, воркер
 * складывает из него читаемое сообщение и отправляет боту в чат.
 *
 * Секреты (задаются командой `wrangler secret put ИМЯ`):
 *   TELEGRAM_BOT_TOKEN — токен от @BotFather
 *   TELEGRAM_CHAT_ID   — id чата или канала, куда падают заявки
 *
 * Переменные (в wrangler.toml):
 *   ALLOWED_ORIGINS — домены сайта через запятую
 */

const MAX_FILES = 6;
const MAX_FILE_BYTES = 9 * 1024 * 1024;   // Telegram sendPhoto не берёт больше 10 МБ
const MAX_FIELD_CHARS = 2000;

/* ── Подписи полей: техническое имя → как это назвать человеку ── */
const LABELS = {
  date: 'Дата свадьбы',
  place: 'Место проведения',
  guests: 'Количество гостей',
  filling: 'Начинка',
  service: 'Презентация и нарезка',
  channel: 'Способ связи',
  name: 'Имя',
  phone: 'Телефон',
  time: 'Удобное время',
  more: 'Дополнительно',
  people: 'Количество человек',
};

/* Порядок вывода — так же, как поля идут в форме */
const ORDER = {
  order:   ['date', 'place', 'guests', 'filling', 'service', 'name', 'phone', 'channel', 'time', 'more'],
  tasting: ['date', 'people', 'name', 'phone', 'channel'],
};

const TITLES = {
  order:   '🎂 Заявка на торт',
  tasting: '🍰 Запись на дегустацию',
};

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 2026-09-12 → 12.09.2026 */
function human(key, value) {
  if (key === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-');
    return `${d}.${m}.${y}`;
  }
  return value;
}

function corsHeaders(origin, allowed) {
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function callTelegram(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
  return data;
}

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGINS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, allowed);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (request.method !== 'POST') {
      return new Response('Метод не поддерживается', { status: 405, headers: cors });
    }

    // Чужие домены не могут слать заявки от вашего имени
    if (allowed.length && origin && !allowed.includes(origin)) {
      return new Response(JSON.stringify({ ok: false, error: 'origin' }), {
        status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      return new Response(JSON.stringify({ ok: false, error: 'Бот не настроен' }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      return new Response(JSON.stringify({ ok: false, error: 'Не удалось прочитать форму' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Ловушка для ботов: настоящий человек это поле не видит и не заполняет
    if ((form.get('company') || '').toString().trim()) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const kind = form.get('form_type') === 'tasting' ? 'tasting' : 'order';

    /* ── Собираем сообщение ── */
    const lines = [`<b>${TITLES[kind]}</b>`, ''];

    for (const key of ORDER[kind]) {
      let v = form.get(key);
      if (v == null || typeof v !== 'string' || !v.trim()) continue;
      v = human(key, v.trim()).slice(0, MAX_FIELD_CHARS);
      lines.push(`<b>${esc(LABELS[key] || key)}:</b> ${esc(v)}`);
    }

    if (kind === 'order' && form.get('decor_later')) {
      lines.push('<b>Декор:</b> референса нет — обсудить индивидуально');
    }

    const files = form.getAll('refs')
      .filter(f => f && typeof f === 'object' && f.size > 0)
      .slice(0, MAX_FILES);

    if (files.length) lines.push(`<b>Референсы:</b> ${files.length} шт. — ниже`);

    const phone = (form.get('phone') || '').toString().trim();
    if (phone) {
      const tel = phone.replace(/[^\d+]/g, '');
      if (tel) lines.push('', `<a href="tel:${esc(tel)}">Позвонить</a>`);
    }

    lines.push('', `<i>Сайт «Торт по любви» · ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Samara' })}</i>`);

    /* ── Отправляем ── */
    try {
      const msg = new FormData();
      msg.append('chat_id', env.TELEGRAM_CHAT_ID);
      msg.append('parse_mode', 'HTML');
      msg.append('disable_web_page_preview', 'true');
      msg.append('text', lines.join('\n').slice(0, 4000));
      await callTelegram(env.TELEGRAM_BOT_TOKEN, 'sendMessage', msg);

      // Референсы идут следом отдельными сообщениями
      for (const file of files) {
        if (file.size > MAX_FILE_BYTES) continue;
        const photo = new FormData();
        photo.append('chat_id', env.TELEGRAM_CHAT_ID);
        photo.append('caption', `Референс: ${file.name}`.slice(0, 1000));
        photo.append('photo', file, file.name);
        try {
          await callTelegram(env.TELEGRAM_BOT_TOKEN, 'sendPhoto', photo);
        } catch {
          // Не картинка или Telegram не принял как фото — шлём файлом
          const doc = new FormData();
          doc.append('chat_id', env.TELEGRAM_CHAT_ID);
          doc.append('caption', `Референс: ${file.name}`.slice(0, 1000));
          doc.append('document', file, file.name);
          await callTelegram(env.TELEGRAM_BOT_TOKEN, 'sendDocument', doc);
        }
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      // Заявку не приняли — сайт обязан показать это человеку, а не «отправлено»
      return new Response(JSON.stringify({ ok: false, error: String(err.message || err) }), {
        status: 502, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
  },
};
