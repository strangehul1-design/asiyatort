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
  if (url.pathname === '/_reset') {
    inbox.length = 0;
    return send(200, { ok: true });
  }

  // /bot<токен>/<метод>
  const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
  if (!m) return send(404, { ok: false, description: 'нет такого метода' });

  const method = m[2];
  const buf = await readBody(req);
  const fields = parseMultipart(buf, req.headers['content-type']);

  if (mode === 'fail') {
    return send(500, { ok: false, description: 'тестовый сбой Telegram' });
  }

  inbox.push({
    method,
    chat_id: fields.chat_id,
    parse_mode: fields.parse_mode,
    text: fields.text,
    caption: fields.caption,
    photo: fields.photo || null,
    document: fields.document || null,
    at: new Date().toISOString(),
  });

  send(200, { ok: true, result: { message_id: inbox.length } });
}).listen(PORT, () => console.log('поддельный Telegram на ' + PORT));
