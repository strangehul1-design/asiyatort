/**
 * Поддельный Telegram для сквозной проверки.
 *
 * Ведёт себя как настоящий api.telegram.org: принимает sendMessage и
 * sendPhoto, запоминает всё, что пришло, и умеет притворяться сломанным.
 * Нужен, чтобы проверить весь путь заявки, не имея настоящего токена.
 *
 * Запуск:  node fake-telegram.js [порт]
 * Что пришло:  GET /_inbox
 * Сломаться:   GET /_mode?m=fail    вернуть в норму: /_mode?m=ok
 */
const http = require('http');

const PORT = Number(process.argv[2] || 8787);
let mode = 'ok';
const inbox = [];
const files = {};        // путь -> содержимое, как у Telegram
let blockedChat = null;  // чат, который «заблокировал» бота

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** Достаёт значения полей из multipart-тела. */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return {};
  const boundary = '--' + (m[1] || m[2]).trim();
  const parts = buf.toString('binary').split(boundary);
  const out = {};
  for (const part of parts) {
    const head = part.indexOf('\r\n\r\n');
    if (head === -1) continue;
    const headers = part.slice(0, head);
    const nameM = /name="([^"]+)"/i.exec(headers);
    if (!nameM) continue;
    const fileM = /filename="([^"]*)"/i.exec(headers);
    const body = part.slice(head + 4).replace(/\r\n$/, '');
    if (fileM) {
      out[nameM[1]] = { filename: fileM[1], bytes: Buffer.from(body, 'binary').length };
    } else {
      out[nameM[1]] = Buffer.from(body, 'binary').toString('utf8');
    }
  }
  return out;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === '/_mode') {
    mode = url.searchParams.get('m') || 'ok';
    return send(200, { mode });
  }
  if (url.pathname === '/_inbox') {
    return send(200, { count: inbox.length, messages: inbox });
  }
  // Положить «файл», который потом попросит бот
  if (url.pathname === '/_putfile') {
    const id = url.searchParams.get('id') || 'test';
    const body = await readBody(req);
    files['photos/' + id + '.jpg'] = body;
    return send(200, { ok: true, bytes: body.length });
  }
  if (url.pathname === '/_block') {
    blockedChat = url.searchParams.get('chat') || null;
    return send(200, { blockedChat });
  }
  if (url.pathname === '/_reset') {
    inbox.length = 0;
    return send(200, { ok: true });
  }

  // Выдача файла: /file/bot<токен>/<путь>
  const fm = /^\/file\/bot[^/]+\/(.+)$/.exec(url.pathname);
  if (fm) {
    const f = files[decodeURIComponent(fm[1])];
    if (!f) { res.writeHead(404); return res.end('нет файла'); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    return res.end(f);
  }

  // /bot<токен>/<метод>
  const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
  if (!m) return send(404, { ok: false, description: 'нет такого метода' });

  const method = m[2];
  const buf = await readBody(req);
  const ctype = req.headers['content-type'] || '';
  // Бот шлёт JSON, сайт — multipart с файлами: понимаем оба
  let fields;
  if (/application\/json/i.test(ctype)) {
    try { fields = JSON.parse(buf.toString('utf8')); } catch { fields = {}; }
  } else {
    fields = parseMultipart(buf, ctype);
  }

  // Бот сначала спрашивает путь к файлу, потом качает его
  if (method === 'getFile') {
    const id = String(fields.file_id || '');
    return send(200, { ok: true, result: { file_id: id, file_path: 'photos/' + id + '.jpg' } });
  }

  if (mode === 'fail') {
    return send(500, { ok: false, description: 'тестовый сбой Telegram' });
  }

  /* Отказ только одному чату — так ведёт себя Telegram, когда человек
     заблокировал бота. Остальные получатели должны получить сообщение. */
  if (blockedChat && String(fields.chat_id) === blockedChat) {
    return send(403, { ok: false, description: 'bot was blocked by the user' });
  }

  inbox.push({
    method,
    chat_id: fields.chat_id,
    reply_markup: fields.reply_markup || null,
    parse_mode: fields.parse_mode,
    text: fields.text,
    caption: fields.caption,
    photo: fields.photo || null,
    document: fields.document || null,
    at: new Date().toISOString(),
  });

  send(200, { ok: true, result: { message_id: inbox.length } });
}).listen(PORT, () => console.log('поддельный Telegram на ' + PORT));
