// 영수증 스캔 중계 서버 (Cloud Run)
// 지금 하는 일: Google 로그인 code → 토큰 교환, refresh token으로 새 토큰 받기
// 5단계에서 추가: POST /v1/ocr, GET /v1/me (허용 계정 확인, DeepSeek 판독)
//
// 환경변수
//   GOOGLE_CLIENT_ID      OAuth 클라이언트 ID (공개값)
//   GOOGLE_CLIENT_SECRET  OAuth 클라이언트 보안 비밀 (Secret Manager에서 주입)
//   ALLOWED_ORIGINS       쉼표 구분. 기본값 https://nkmro.github.io
//
// 서버는 토큰을 저장하지 않습니다. refresh token은 사용자 기기에만 있고,
// 새 access token이 필요할 때 앱이 이 서버에 보내 교환합니다(교환에 client_secret이 필요하기 때문).

'use strict';

const http = require('http');
const { OAuth2Client } = require('google-auth-library');

const PORT = Number(process.env.PORT || 8080);
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://nkmro.github.io')
  .split(',').map(s => s.trim()).filter(Boolean);
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const MAX_BODY = 64 * 1024;

const verifier = new OAuth2Client(CLIENT_ID);

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '3600');
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function fail(res, status, code, message) {
  send(res, status, { error: { code, message } });
}

function readJson(req) {
  // Cloud Run 함수(functions-framework)는 JSON 본문을 미리 읽어 req.body에 넣어 줌
  if (req.body !== undefined && !Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body && typeof req.body === 'object' ? req.body : {});
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

async function googleToken(params) {
  const body = new URLSearchParams(Object.assign({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  }, params));
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

async function emailFromIdToken(idToken) {
  const ticket = await verifier.verifyIdToken({ idToken, audience: CLIENT_ID });
  const p = ticket.getPayload();
  if (!p || !p.email || p.email_verified !== true) throw new Error('email not verified');
  return p.email.toLowerCase();
}

function tokenReply(data, email) {
  const out = {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    scope: data.scope,
    idToken: data.id_token || null,
    email
  };
  if (data.refresh_token) out.refreshToken = data.refresh_token;
  return out;
}

// POST /v1/auth/exchange  {code}
async function exchange(req, res) {
  const { code } = await readJson(req);
  if (typeof code !== 'string' || !code) return fail(res, 400, 'BAD_REQUEST', 'code가 없습니다');
  // GIS 코드 모델(팝업)은 redirect_uri로 'postmessage'를 씁니다
  const t = await googleToken({ code, grant_type: 'authorization_code', redirect_uri: 'postmessage' });
  if (!t.ok) {
    console.warn('exchange failed', t.status, t.data && t.data.error);
    return fail(res, 401, 'INVALID_GRANT', '로그인 코드를 교환하지 못했습니다');
  }
  if (!t.data.id_token) return fail(res, 401, 'NO_ID_TOKEN', 'openid 권한이 없습니다');
  const email = await emailFromIdToken(t.data.id_token);
  send(res, 200, tokenReply(t.data, email));
}

// POST /v1/auth/refresh  {refreshToken}
async function refresh(req, res) {
  const { refreshToken } = await readJson(req);
  if (typeof refreshToken !== 'string' || !refreshToken) return fail(res, 400, 'BAD_REQUEST', 'refreshToken이 없습니다');
  const t = await googleToken({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  if (!t.ok) {
    // invalid_grant = 사용자가 권한을 철회했거나 토큰이 만료됨 → 앱이 다시 로그인
    return fail(res, 401, 'REAUTH_REQUIRED', '다시 로그인해 주세요');
  }
  let email = null;
  if (t.data.id_token) {
    try { email = await emailFromIdToken(t.data.id_token); } catch (e) { /* 이메일 없이도 access token은 유효 */ }
  }
  send(res, 200, tokenReply(t.data, email));
}

// POST /v1/auth/revoke  {token}  (로그아웃)
async function revoke(req, res) {
  const { token } = await readJson(req);
  if (typeof token !== 'string' || !token) return fail(res, 400, 'BAD_REQUEST', 'token이 없습니다');
  await fetch(REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token })
  }).catch(() => {});
  send(res, 200, { ok: true });
}

const routes = {
  'POST /v1/auth/exchange': exchange,
  'POST /v1/auth/refresh': refresh,
  'POST /v1/auth/revoke': revoke,
  'GET /healthz': (req, res) => send(res, 200, { ok: true })
};

async function app(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const path = (req.url || '/').split('?')[0];
  const handler = routes[req.method + ' ' + path];
  if (!handler) return fail(res, 404, 'NOT_FOUND', '없는 주소입니다');
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) return fail(res, 403, 'BAD_ORIGIN', '허용되지 않은 출처입니다');
  }
  try {
    await handler(req, res);
  } catch (e) {
    if (e && e.status === 400) return fail(res, 400, 'BAD_REQUEST', '요청 형식 오류');
    if (e && e.status === 413) return fail(res, 413, 'TOO_LARGE', '요청이 너무 큽니다');
    console.error('handler error', e && e.message);
    fail(res, 500, 'INTERNAL', '서버 오류');
  }
}

if (!CLIENT_ID || !CLIENT_SECRET) console.warn('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 환경변수가 없습니다');
// Cloud Run 함수로 배포할 때: 진입점(함수 이름) = relay
exports.relay = app;
// 직접 실행할 때(node index.js): 일반 HTTP 서버
if (require.main === module) http.createServer(app).listen(PORT, () => console.log('listening on', PORT));
