// 영수증 스캔 중계 서버 (Cloud Run 함수, 진입점 relay)
// 하는 일
//   1) Google 로그인: code → 토큰 교환, refresh token으로 새 토큰 받기
//   2) 앱 사용 승인: 관리자가 승인한 계정만 토큰을 받음(Firestore users 컬렉션)
//   3) 관리자 화면용: 사용자 목록·승인·거절·사용 중지
// 5단계에서 추가: POST /v1/ocr (DeepSeek 판독)
//
// 환경변수
//   GOOGLE_CLIENT_ID      OAuth 클라이언트 ID (공개값)
//   GOOGLE_CLIENT_SECRET  OAuth 클라이언트 보안 비밀 (Secret Manager에서 주입)
//   ADMIN_EMAILS          관리자 Gmail(쉼표 구분). 관리자는 자동 승인
//   ALLOWED_ORIGINS       쉼표 구분. 기본값 https://nkmro.github.io
//
// 서버는 토큰을 저장하지 않습니다. refresh token은 사용자 기기에만 있고,
// 새 access token이 필요할 때 앱이 이 서버에 보내 교환합니다(교환에 client_secret이 필요하기 때문).
// 승인되지 않은 계정은 refresh token만 받고 access token은 받지 못합니다.
// 나중에 승인되면 앱이 [다시 확인]으로 refresh를 불러 바로 들어갑니다(로그인 창을 다시 띄우지 않음).

'use strict';

const http = require('http');
const { OAuth2Client } = require('google-auth-library');
const { Firestore, FieldValue } = require('@google-cloud/firestore');

const PORT = Number(process.env.PORT || 8080);
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://nkmro.github.io')
  .split(',').map(s => s.trim()).filter(Boolean);
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const MAX_BODY = 64 * 1024;
const STATUSES = ['pending', 'approved', 'rejected', 'disabled'];

const verifier = new OAuth2Client(CLIENT_ID);
let db = null;
function firestore() { if (!db) db = new Firestore(); return db; }
const users = () => firestore().collection('users');

function isAdmin(email) { return ADMIN_EMAILS.includes(email); }

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

function fail(res, status, code, message, extra) {
  send(res, status, { error: Object.assign({ code, message }, extra || {}) });
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
  const body = new URLSearchParams(Object.assign({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }, params));
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// id token 검증 → { email, name }
async function identityFromIdToken(idToken) {
  const ticket = await verifier.verifyIdToken({ idToken, audience: CLIENT_ID });
  const p = ticket.getPayload();
  if (!p || !p.email || p.email_verified !== true) throw new Error('email not verified');
  return { email: p.email.toLowerCase(), name: p.name || '' };
}

// id token이 없을 때 access token으로 이메일 확인
async function identityFromAccessToken(accessToken) {
  const r = await fetch(USERINFO_URL, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!r.ok) throw new Error('userinfo failed');
  const p = await r.json();
  if (!p.email || p.email_verified !== true) throw new Error('email not verified');
  return { email: p.email.toLowerCase(), name: p.name || '' };
}

// 승인 상태 확인. 처음 보는 계정이면 "승인 대기"로 등록. 관리자는 자동 승인
async function approvalOf(ident) {
  const ref = users().doc(ident.email);
  const snap = await ref.get();
  if (!snap.exists) {
    const status = isAdmin(ident.email) ? 'approved' : 'pending';
    await ref.set({ email: ident.email, name: ident.name, status, requestedAt: FieldValue.serverTimestamp(),
      decidedAt: status === 'approved' ? FieldValue.serverTimestamp() : null, decidedBy: status === 'approved' ? 'auto(admin)' : null });
    return status;
  }
  const d = snap.data();
  if (isAdmin(ident.email) && d.status !== 'approved') {
    await ref.update({ status: 'approved', decidedAt: FieldValue.serverTimestamp(), decidedBy: 'auto(admin)' });
    return 'approved';
  }
  await ref.update({ lastSeenAt: FieldValue.serverTimestamp(), name: ident.name || d.name || '' }).catch(() => {});
  return d.status || 'pending';
}

const STATUS_MESSAGE = {
  pending: '관리자 승인을 기다리고 있습니다',
  rejected: '관리자가 사용을 승인하지 않았습니다',
  disabled: '관리자가 사용을 중지했습니다'
};

function tokenReply(data, ident, status) {
  const out = {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    scope: data.scope,
    idToken: data.id_token || null,
    email: ident.email,
    status,
    isAdmin: isAdmin(ident.email)
  };
  if (data.refresh_token) out.refreshToken = data.refresh_token;
  return out;
}

function notApproved(res, ident, status, refreshToken) {
  const extra = { email: ident.email, status };
  if (refreshToken) extra.refreshToken = refreshToken; // 승인 후 [다시 확인]용. 이것만으로는 Drive를 쓸 수 없음
  return fail(res, 403, 'NOT_APPROVED', STATUS_MESSAGE[status] || '사용 승인이 필요합니다', extra);
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
  const ident = await identityFromIdToken(t.data.id_token);
  const status = await approvalOf(ident);
  if (status !== 'approved') return notApproved(res, ident, status, t.data.refresh_token);
  send(res, 200, tokenReply(t.data, ident, status));
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
  let ident;
  try {
    ident = t.data.id_token ? await identityFromIdToken(t.data.id_token) : await identityFromAccessToken(t.data.access_token);
  } catch (e) {
    return fail(res, 401, 'REAUTH_REQUIRED', '다시 로그인해 주세요');
  }
  const status = await approvalOf(ident);
  if (status !== 'approved') return notApproved(res, ident, status);
  send(res, 200, tokenReply(t.data, ident, status));
}

// POST /v1/auth/revoke  {token}  (로그아웃)
async function revoke(req, res) {
  const { token } = await readJson(req);
  if (typeof token !== 'string' || !token) return fail(res, 400, 'BAD_REQUEST', 'token이 없습니다');
  await fetch(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }) }).catch(() => {});
  send(res, 200, { ok: true });
}

// 관리자 확인: Authorization: Bearer <id token>
async function requireAdmin(req, res) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) { fail(res, 401, 'INVALID_TOKEN', '다시 로그인해 주세요'); return null; }
  let ident;
  try { ident = await identityFromIdToken(m[1]); } catch (e) { fail(res, 401, 'INVALID_TOKEN', '다시 로그인해 주세요'); return null; }
  if (!isAdmin(ident.email)) { fail(res, 403, 'NOT_ADMIN', '관리자만 쓸 수 있습니다'); return null; }
  return ident;
}

function ts(v) { return v && typeof v.toDate === 'function' ? v.toDate().toISOString() : null; }

// GET /v1/admin/users
async function adminList(req, res) {
  if (!(await requireAdmin(req, res))) return;
  const snap = await users().get();
  const list = snap.docs.map(d => {
    const x = d.data();
    return { email: x.email || d.id, name: x.name || '', status: x.status || 'pending',
      requestedAt: ts(x.requestedAt), decidedAt: ts(x.decidedAt), lastSeenAt: ts(x.lastSeenAt), isAdmin: isAdmin(x.email || d.id) };
  });
  const order = { pending: 0, approved: 1, disabled: 2, rejected: 3 };
  list.sort((a, b) => (order[a.status] - order[b.status]) || String(b.requestedAt).localeCompare(String(a.requestedAt)));
  send(res, 200, { users: list });
}

// POST /v1/admin/users/status  {email, status}
async function adminSetStatus(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { email, status } = await readJson(req);
  const target = String(email || '').trim().toLowerCase();
  if (!target || !STATUSES.includes(status) || status === 'pending') return fail(res, 400, 'BAD_REQUEST', '요청 형식 오류');
  if (isAdmin(target)) return fail(res, 400, 'BAD_REQUEST', '관리자 계정은 바꿀 수 없습니다');
  const ref = users().doc(target);
  const snap = await ref.get();
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', '없는 사용자입니다');
  await ref.update({ status, decidedAt: FieldValue.serverTimestamp(), decidedBy: admin.email });
  send(res, 200, { ok: true, email: target, status });
}

const routes = {
  'POST /v1/auth/exchange': exchange,
  'POST /v1/auth/refresh': refresh,
  'POST /v1/auth/revoke': revoke,
  'GET /v1/admin/users': adminList,
  'POST /v1/admin/users/status': adminSetStatus,
  // Cloud Run은 /healthz 주소를 자체 용도로 예약해 쓰므로 다른 이름을 씀
  'GET /v1/health': (req, res) => send(res, 200, { ok: true })
};

async function app(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const path = (req.url || '/').split('?')[0];
  const handler = routes[req.method + ' ' + path];
  if (!handler) return fail(res, 404, 'NOT_FOUND', '없는 주소입니다');
  if (path !== '/v1/health') {
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
if (!ADMIN_EMAILS.length) console.warn('ADMIN_EMAILS 환경변수가 없습니다(관리자 없음)');
// Cloud Run 함수로 배포할 때: 진입점(함수 이름) = relay
exports.relay = app;
exports._test = { setDb: d => { db = d; }, isAdmin };
// 직접 실행할 때(node index.js): 일반 HTTP 서버
if (require.main === module) http.createServer(app).listen(PORT, () => console.log('listening on', PORT));
