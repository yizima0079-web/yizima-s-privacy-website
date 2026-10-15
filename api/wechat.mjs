import { createHmac, timingSafeEqual } from 'node:crypto';

const SESSION_COOKIE = 'yizima_admin_session';
const SESSION_SECONDS = 8 * 60 * 60;
const MAX_JSON_BYTES = 1_100_000;
const MAX_COVER_BYTES = 4 * 1024 * 1024;
const MAX_INLINE_BYTES = 1024 * 1024;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const loginFailures = new Map();
let tokenCache = { value: '', expiresAt: 0 };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
    });
}

function requestBodyLimit(request) {
  const url = new URL(request.url || '/', 'https://localhost');
  const action = url.searchParams.get('action');
  if (action === 'login' || action === 'logout') return 8_192;
  if (action === 'upload-inline') return MAX_INLINE_BYTES + 64_000;
  if (action === 'upload-cover') return MAX_COVER_BYTES + 64_000;
  if (action === 'save-draft') return MAX_JSON_BYTES;
  return 16_384;
}

function sanitizeArticleHtml(source, uploadedImageUrls = []) {
  const allowedTags = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'a', 'img']);
  const allowedAttributes = { a: new Set(['href', 'title']), img: new Set(['src', 'alt']) };
  return String(source).replace(/<(script|style|iframe|object|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->|<![^>]*>|<\/?([a-zA-Z][\w-]*)\b([^>]*)>/g, (whole, rawTag, rawAttributes) => {
    if (!rawTag) return '';
    const tag = rawTag.toLowerCase();
    const closing = /^<\//.test(whole);
    if (!allowedTags.has(tag)) return '';
    if (closing) return ['br', 'img'].includes(tag) ? '' : `</${tag}>`;
    const attrs = [];
    const attributePattern = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let match;
    while ((match = attributePattern.exec(rawAttributes || ''))) {
      const name = match[1].toLowerCase();
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      if (!allowedAttributes[tag]?.has(name) || /[<>"']/.test(value)) continue;
      if (name === 'href' && !/^https:\/\//i.test(value)) continue;
      if (name === 'src' && (!/^https:\/\/mmbiz\.qpic\.cn\//i.test(value) || !uploadedImageUrls.includes(value))) continue;
      attrs.push(`${name}="${value.replace(/&/g, '&amp;')}"`);
    }
    if (tag === 'img' && !attrs.some((value) => value.startsWith('src='))) return '';
    return `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
  });
}

function envReady() {
  return Boolean(process.env.WECHAT_APPID && process.env.WECHAT_APPSECRET && process.env.ADMIN_PASSWORD && process.env.SESSION_SECRET);
}

function originAllowed(request) {
  const origin = request.headers.get('origin');
  return Boolean(origin && origin === new URL(request.url).origin);
}

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

function sign(value) {
  return createHmac('sha256', process.env.SESSION_SECRET).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function createSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_SECONDS * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function hasSession(request) {
  const [payload, signature, extra] = readCookie(request, SESSION_COOKIE).split('.');
  if (!payload || !signature || extra) return false;
  if (!safeEqual(sign(payload), signature)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(data.exp) && data.exp > Date.now();
  } catch {
    return false;
  }
}

function sessionCookie(request, value, maxAge = SESSION_SECONDS) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function clientKey(request) {
  return (request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim().slice(0, 80);
}

function blockedLogin(key) {
  const item = loginFailures.get(key);
  if (!item) return false;
  if (Date.now() - item.startedAt >= LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return false;
  }
  return item.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(key) {
  const item = loginFailures.get(key);
  if (!item || Date.now() - item.startedAt >= LOGIN_WINDOW_MS) {
    loginFailures.set(key, { count: 1, startedAt: Date.now() });
  } else {
    item.count += 1;
  }
}

async function getAccessToken() {
  if (tokenCache.value && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.value;
  const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
  url.searchParams.set('grant_type', 'client_credential');
  url.searchParams.set('appid', process.env.WECHAT_APPID);
  url.searchParams.set('secret', process.env.WECHAT_APPSECRET);
  const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(12_000) });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    tokenCache = { value: '', expiresAt: 0 };
    throw new Error(`wechat_token_error:${body.errcode || response.status}`);
  }
  tokenCache = { value: body.access_token, expiresAt: Date.now() + Math.max(60, Number(body.expires_in || 7200)) * 1000 };
  return tokenCache.value;
}

async function wechatJson(path, token, payload) {
  const response = await fetch(`https://api.weixin.qq.com/cgi-bin/${path}?access_token=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json();
  if (!response.ok || body.errcode) throw new Error(`wechat_api_error:${body.errcode || response.status}`);
  return body;
}

function imageFile(form, name, maxBytes, allowedTypes) {
  const file = form.get(name);
  if (!file || typeof file.arrayBuffer !== 'function' || !allowedTypes.has(file.type)) return { error: '请上传支持格式的图片。' };
  if (file.size < 1 || file.size > maxBytes) return { error: `图片大小需小于 ${Math.floor(maxBytes / 1024 / 1024)} MB。` };
  return { file };
}

async function uploadCover(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_COVER_BYTES + 64_000) return json({ error: '封面图片超过 4 MB 限制。' }, 413);
  const form = await request.formData();
  const result = imageFile(form, 'image', MAX_COVER_BYTES, new Set(['image/jpeg', 'image/png', 'image/gif', 'image/bmp']));
  if (result.error) return json({ error: result.error.replace('小于 4 MB', '不超过 4 MB') }, 400);
  const token = await getAccessToken();
  const upload = new FormData();
  upload.set('media', result.file, result.file.name || 'cover');
  const url = new URL('https://api.weixin.qq.com/cgi-bin/material/add_material');
  url.searchParams.set('access_token', token);
  url.searchParams.set('type', 'image');
  const response = await fetch(url, { method: 'POST', body: upload, signal: AbortSignal.timeout(30_000) });
  const data = await response.json();
  if (!response.ok || data.errcode || !data.media_id) throw new Error(`wechat_cover_error:${data.errcode || response.status}`);
  return json({ media_id: data.media_id, url: data.url || '' });
}

async function uploadInline(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_INLINE_BYTES + 64_000) return json({ error: '正文图片必须小于 1 MB。' }, 413);
  const form = await request.formData();
  const result = imageFile(form, 'image', MAX_INLINE_BYTES, new Set(['image/jpeg', 'image/png']));
  if (result.error) return json({ error: result.error }, 400);
  const token = await getAccessToken();
  const upload = new FormData();
  upload.set('media', result.file, result.file.name || 'inline-image');
  const url = new URL('https://api.weixin.qq.com/cgi-bin/media/uploadimg');
  url.searchParams.set('access_token', token);
  const response = await fetch(url, { method: 'POST', body: upload, signal: AbortSignal.timeout(30_000) });
  const data = await response.json();
  if (!response.ok || data.errcode || !data.url) throw new Error(`wechat_inline_error:${data.errcode || response.status}`);
  return json({ url: data.url });
}

async function saveDraft(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_JSON_BYTES) return json({ error: '文章内容超出可处理大小。' }, 413);
  let article;
  try { article = await request.json(); } catch { return json({ error: '文章数据格式不正确。' }, 400); }
  if (!article || typeof article !== 'object' || Array.isArray(article)) return json({ error: '文章数据格式不正确。' }, 400);
  const title = typeof article.title === 'string' ? article.title.trim() : '';
  const author = typeof article.author === 'string' ? article.author.trim() : '';
  const digest = typeof article.digest === 'string' ? article.digest.trim() : '';
  const content = typeof article.content === 'string' ? article.content.trim() : '';
  const thumbMediaId = typeof article.thumb_media_id === 'string' ? article.thumb_media_id.trim() : '';
  if (!title || [...title].length > 32) return json({ error: '标题必填，最多 32 个字。' }, 400);
  if ([...author].length > 16) return json({ error: '作者最多 16 个字。' }, 400);
  if ([...digest].length > 120) return json({ error: '摘要最多 120 个字。' }, 400);
  if (!content || [...content].length >= 20_000 || Buffer.byteLength(content, 'utf8') >= 1_000_000) return json({ error: '正文必填，最多 20,000 字且小于 1 MB。' }, 400);
  if (!/^\S{1,128}$/.test(thumbMediaId)) return json({ error: '请先上传有效的公众号封面图片。' }, 400);
  const uploadedImageUrls = Array.isArray(article.uploaded_image_urls) ? article.uploaded_image_urls : [];
  if (uploadedImageUrls.some((value) => {
    if (typeof value !== 'string') return true;
    try { const url = new URL(value); return url.protocol !== 'https:' || url.hostname !== 'mmbiz.qpic.cn'; }
    catch { return true; }
  })) {
    return json({ error: '正文图片请先通过此编辑器上传到公众号。' }, 400);
  }
  const safeContent = sanitizeArticleHtml(content, uploadedImageUrls);
  if (!safeContent.replace(/<[^>]*>/g, '').trim()) return json({ error: '正文内容为空，请填写文字或公众号正文图片。' }, 400);
  for (const url of uploadedImageUrls) {
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`<img\\b[^>]*\\bsrc="${escaped}"`, 'i').test(safeContent)) return json({ error: '有已上传图片没有插入正文，请检查后重试。' }, 400);
  }
  const token = await getAccessToken();
  const saved = await wechatJson('draft/add', token, { articles: [{
    article_type: 'news', title, author, digest, content: safeContent, thumb_media_id: thumbMediaId,
    need_open_comment: 0, only_fans_can_comment: 0,
  }] });
  return json({ media_id: saved.media_id, saved_to: 'draft_box', published: false });
}

async function handle(request) {
  if (request.method === 'GET' && new URL(request.url).searchParams.get('action') === 'status') {
    if (!hasSession(request)) return json({ authenticated: false }, 401);
    return json({ authenticated: true, configured: envReady() });
  }
  if (request.method !== 'POST') return json({ error: '不支持的请求方式。' }, 405, { allow: 'POST, GET' });
  if (!originAllowed(request)) return json({ error: '请求来源校验失败。' }, 403);
  const action = new URL(request.url).searchParams.get('action');
  if (action === 'login') {
    if (!envReady()) return json({ error: '服务端配置尚未完成。' }, 503);
    const key = clientKey(request);
    if (blockedLogin(key)) return json({ error: '尝试次数过多，请稍后再试。' }, 429);
    let body;
    try { body = await request.json(); } catch { return json({ error: '请求格式不正确。' }, 400); }
    if (!safeEqual(body?.password || '', process.env.ADMIN_PASSWORD)) {
      recordLoginFailure(key);
      return json({ error: '密码不正确。' }, 401);
    }
    loginFailures.delete(key);
    return json({ authenticated: true }, 200, { 'set-cookie': sessionCookie(request, createSession()) });
  }
  if (!hasSession(request)) return json({ error: '请先登录。' }, 401);
  if (!envReady()) return json({ error: '服务端配置尚未完成。' }, 503);
  try {
    if (action === 'logout') return json({ authenticated: false }, 200, { 'set-cookie': sessionCookie(request, '', 0) });
    if (action === 'upload-cover') return await uploadCover(request);
    if (action === 'upload-inline') return await uploadInline(request);
    if (action === 'save-draft') return await saveDraft(request);
    return json({ error: '未知操作。' }, 404);
  } catch (error) {
    const code = String(error?.message || '').match(/wechat_[a-z_]+_error:(\d+)/)?.[1];
    console.error('wechat_editor_error', { action, code: code || 'internal_error', type: error?.name || 'Error' });
    return json({ error: code ? `微信公众号接口返回错误码 ${code}，请检查公众号权限和文章素材。` : '服务暂时不可用，请稍后重试。' }, 502);
  }
}

async function readNodeBody(request, maxBytes) {
  if (request.body !== undefined && request.body !== null) {
    if (typeof request.body === 'string' || Buffer.isBuffer(request.body)) return Buffer.from(request.body);
    return Buffer.from(JSON.stringify(request.body));
  }
  if (typeof request[Symbol.asyncIterator] !== 'function') return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += part.length;
    if (total > maxBytes) throw new Error('request_body_too_large');
    chunks.push(part);
  }
  return Buffer.concat(chunks, total);
}

export default async function handler(request, response) {
  const method = request.method || 'GET';
  const protocol = String(request.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const rawPath = request.url || '/';
  const url = new URL(rawPath.startsWith('/') ? rawPath : `/${rawPath}`, `${protocol}://${request.headers?.host || 'localhost'}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers || {})) {
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else if (value !== undefined) headers.set(key, String(value));
  }
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    try { body = await readNodeBody(request, requestBodyLimit(request)); }
    catch (error) {
      response.status(error?.message === 'request_body_too_large' ? 413 : 400);
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: error?.message === 'request_body_too_large' ? '上传内容超出大小限制。' : '无法读取请求内容。' }));
      return;
    }
  }
  const result = await handle(new Request(url, { method, headers, body: body?.length ? body : undefined }));
  response.statusCode = result.status;
  result.headers.forEach((value, key) => response.setHeader(key, value));
  response.end(Buffer.from(await result.arrayBuffer()));
}
