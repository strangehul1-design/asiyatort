/* ═══════════════════════════════════════════
   Единый канал уведомлений: одна заявка — одно место.

   Всё, что приходит с сайта или из ВКонтакте, уходит
   и в Telegram, и в диалоги сообщества VK. Если один
   канал отвалился, второй всё равно доставит — заявка
   не теряется из-за чужого сбоя.

   Секреты (wrangler secret put ИМЯ):
     TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
     VK_TOKEN        — ключ доступа сообщества (права: messages)
     VK_PEER_ID      — куда слать: ваш user id или 2000000000+id беседы
   Любую пару можно не задавать — тогда этот канал просто молчит.
   ═══════════════════════════════════════════ */

const TZ = 'Europe/Samara';

export function now() {
  return new Date().toLocaleString('ru-RU', { timeZone: TZ });
}

const escHtml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ── Telegram ── */
async function sendTelegram(env, text, files) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { skipped: 'telegram' };

  /* Адрес API вынесен в переменную, чтобы сквозной тест мог направить
     запросы на локальную заглушку. В бою переменная не задана и
     используется настоящий api.telegram.org. */
  const host = (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const api = m => `${host}/bot${env.TELEGRAM_BOT_TOKEN}/${m}`;

  const msg = new FormData();
  msg.append('chat_id', env.TELEGRAM_CHAT_ID);
  msg.append('parse_mode', 'HTML');
  msg.append('disable_web_page_preview', 'true');
  msg.append('text', text.slice(0, 4000));

  const res = await fetch(api('sendMessage'), { method: 'POST', body: msg });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error('telegram: ' + (data.description || res.status));

  for (const file of files || []) {
    const photo = new FormData();
    photo.append('chat_id', env.TELEGRAM_CHAT_ID);
    photo.append('caption', `Референс: ${file.name}`.slice(0, 1000));
    photo.append('photo', file, file.name);
    const r = await fetch(api('sendPhoto'), { method: 'POST', body: photo });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) {
      const doc = new FormData();
      doc.append('chat_id', env.TELEGRAM_CHAT_ID);
      doc.append('caption', `Референс: ${file.name}`.slice(0, 1000));
      doc.append('document', file, file.name);
      await fetch(api('sendDocument'), { method: 'POST', body: doc });
    }
  }
  return { ok: 'telegram' };
}

/* ── ВКонтакте ──
   messages.send кладёт сообщение в диалоги сообщества.
   На телефоне это сразу приходит push-уведомлением. */
async function sendVk(env, text) {
  if (!env.VK_TOKEN || !env.VK_PEER_ID) return { skipped: 'vk' };

  const body = new URLSearchParams({
    peer_id: env.VK_PEER_ID,
    message: text.slice(0, 4000),
    random_id: String(Date.now() % 2147483647),   // VK требует, защищает от дублей
    dont_parse_links: '1',
    v: '5.199',
    access_token: env.VK_TOKEN,
  });

  const res = await fetch('https://api.vk.com/method/messages.send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) throw new Error('vk: ' + (data.error.error_msg || 'ошибка'));
  return { ok: 'vk' };
}

/**
 * Шлёт заявку во все настроенные каналы.
 * Падение одного канала не отменяет остальные.
 * @param {object} env
 * @param {{title:string, rows:Array<[string,string]>, footer?:string}} letter
 * @param {Array<File>} [files]
 * @returns {{delivered:string[], failed:string[], errors:string[]}}
 */
export async function notifyAll(env, letter, files) {
  // Telegram понимает HTML, VK — только текст. Готовим обе версии.
  const html = [`<b>${escHtml(letter.title)}</b>`, '']
    .concat(letter.rows.map(([k, v]) => `<b>${escHtml(k)}:</b> ${escHtml(v)}`))
    .concat(letter.footer ? ['', `<i>${escHtml(letter.footer)}</i>`] : [])
    .join('\n');

  const plain = [letter.title, '']
    .concat(letter.rows.map(([k, v]) => `${k}: ${v}`))
    .concat(letter.footer ? ['', letter.footer] : [])
    .join('\n');

  const results = await Promise.allSettled([
    sendTelegram(env, html, files),
    sendVk(env, plain),
  ]);

  const delivered = [], failed = [], errors = [];
  const names = ['telegram', 'vk'];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      if (r.value.ok) delivered.push(r.value.ok);
      // skipped — канал просто не настроен, это не ошибка
    } else {
      failed.push(names[i]);
      errors.push(String(r.reason && r.reason.message || r.reason));
    }
  });
  return { delivered, failed, errors };
}
