/* Google 로그인 (Authorization Code 흐름, 설계서 토큰 흐름 (c))
   1) 버튼을 누르면 Google 동의 팝업 → code
   2) 중계 서버가 code를 access token + id token + refresh token으로 교환
   3) refresh token은 이 기기에만 저장, access token은 메모리에만
   4) access token이 만료되면 refresh token을 중계 서버로 보내 새로 받음 */
(function () {
  'use strict';
  var CFG = window.RS_CONFIG;
  var KEY = 'rs.auth';
  var DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

  var access = null;      // { token, exp }
  var inflight = null;    // 동시에 여러 번 갱신하지 않도록

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function save(v) {
    try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch (e) { /* 저장소 사용 불가 */ }
  }

  function NeedLogin(msg) { var e = new Error(msg || '로그인이 필요합니다'); e.needLogin = true; return e; }

  async function relay(path, body) {
    if (!CFG.relayUrl) throw new Error('중계 서버 주소가 설정되지 않았습니다');
    var r = await fetch(CFG.relayUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) {
      var err = new Error((data.error && data.error.message) || ('서버 오류 ' + r.status));
      err.status = r.status;
      err.code = data.error && data.error.code;
      throw err;
    }
    return data;
  }

  function setAccess(d) {
    access = { token: d.accessToken, exp: Date.now() + (Number(d.expiresIn || 3600) - 60) * 1000 };
  }

  function waitForGis() {
    return new Promise(function (resolve, reject) {
      var n = 0;
      (function check() {
        if (window.google && google.accounts && google.accounts.oauth2) return resolve();
        if (++n > 100) return reject(new Error('Google 로그인 스크립트를 불러오지 못했습니다'));
        setTimeout(check, 100);
      })();
    });
  }

  // 반드시 버튼 클릭 안에서 호출 (팝업 차단 방지)
  function login() {
    return new Promise(function (resolve, reject) {
      if (!(window.google && google.accounts && google.accounts.oauth2)) {
        return reject(new Error('Google 로그인 준비 중입니다. 잠시 후 다시 눌러 주세요'));
      }
      var prev = load();
      var client = google.accounts.oauth2.initCodeClient({
        client_id: CFG.googleClientId,
        scope: CFG.scopes,
        ux_mode: 'popup',
        login_hint: prev && prev.email ? prev.email : undefined,
        callback: async function (resp) {
          if (resp.error) return reject(new Error('로그인이 취소되었습니다'));
          if (!google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
            return reject(new Error('Google Drive 권한에 체크해야 앱을 쓸 수 있습니다. 다시 로그인해 주세요'));
          }
          try {
            var d = await relay('/v1/auth/exchange', { code: resp.code });
            var refreshToken = d.refreshToken || (prev && prev.email === d.email ? prev.refreshToken : null);
            if (!refreshToken) {
              // 예전에 동의한 적이 있어 refresh token이 다시 나오지 않은 경우: 권한을 비우고 다시 받게 함
              await relay('/v1/auth/revoke', { token: d.accessToken }).catch(function () {});
              return reject(new Error('로그인 정보를 새로 받아야 합니다. [Google로 로그인]을 한 번 더 눌러 주세요'));
            }
            save({ email: d.email, refreshToken: refreshToken });
            setAccess(d);
            resolve({ email: d.email });
          } catch (e) { reject(e); }
        },
        error_callback: function (e) {
          reject(new Error(e && e.type === 'popup_closed' ? '로그인 창이 닫혔습니다' : '로그인 창을 열지 못했습니다'));
        }
      });
      client.requestCode();
    });
  }

  async function getToken() {
    if (access && Date.now() < access.exp) return access.token;
    var s = load();
    if (!s || !s.refreshToken) throw NeedLogin();
    if (!inflight) {
      inflight = relay('/v1/auth/refresh', { refreshToken: s.refreshToken })
        .then(function (d) { setAccess(d); return access.token; })
        .catch(function (e) {
          if (e.status === 401) { save(null); access = null; throw NeedLogin('로그인이 만료되었습니다. 다시 로그인해 주세요'); }
          throw e;
        })
        .finally(function () { inflight = null; });
    }
    return inflight;
  }

  async function logout() {
    var s = load();
    save(null);
    access = null;
    if (s && s.refreshToken) await relay('/v1/auth/revoke', { token: s.refreshToken }).catch(function () {});
  }

  window.RSAuth = {
    ready: waitForGis,
    login: login,
    logout: logout,
    getToken: getToken,
    user: function () { var s = load(); return s ? { email: s.email } : null; },
    invalidate: function () { access = null; }
  };
})();
