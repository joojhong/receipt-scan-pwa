/* Google Drive·시트 연결
   - 처음 로그인하면 내 Drive에 "영수증 스캔" 폴더(원본·청구본 하위 폴더)와 "영수증 장부" 시트를 만듦
   - 이미 있으면(다른 기기에서 만든 것 포함) 찾아서 씀. appProperties 표시로 찾으므로 이름을 바꿔도 찾음
   - drive.file 권한이라 앱이 만든 파일만 보임 */
(function () {
  'use strict';

  var DRIVE = 'https://www.googleapis.com/drive/v3/files';
  var SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  var FOLDER = 'application/vnd.google-apps.folder';
  var SHEET = 'application/vnd.google-apps.spreadsheet';
  var SCHEMA_VERSION = 1;

  // 열 순서는 "데이터·API 스펙" 탭 표 순서(A~T)
  var RECEIPT_HEADERS = ['ID', '유형', '촬영일시', '구분', '상태', '거래일시', '귀속 월', '금액', '가맹점명', '가맹점 주소',
    '내역', '메모', '영수증 폭', '판독 신뢰도', '확인 사유', '판독 시도', '원본 파일 ID', '청구 PDF ID', '청구일시', '앱 수정일시'];
  var BUDGET_HEADERS = ['ID', '적용 월', '구분', '유형', '이월 방식', '금액', '메모', '앱 수정일시'];
  var COL = { id: 0, kind: 1, capturedAt: 2, category: 3, status: 4, txAt: 5, month: 6, amount: 7 };

  function wsKey(email) { return 'rs.ws.' + email; }
  function loadWs(email) { try { return JSON.parse(localStorage.getItem(wsKey(email)) || 'null'); } catch (e) { return null; } }
  function saveWs(email, ws) { try { localStorage.setItem(wsKey(email), JSON.stringify(ws)); } catch (e) { /* 무시 */ } }

  async function api(url, opt, retried) {
    opt = opt || {};
    var token = await RSAuth.getToken();
    var headers = Object.assign({ Authorization: 'Bearer ' + token }, opt.headers || {});
    if (opt.json !== undefined) { headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(opt.json); }
    var r = await fetch(url, { method: opt.method || 'GET', headers: headers, body: opt.body });
    if (r.status === 401 && !retried) { RSAuth.invalidate(); return api(url, opt, true); }
    if (!r.ok) {
      var detail = await r.text().catch(function () { return ''; });
      var err = new Error('Google API 오류 ' + r.status);
      err.status = r.status; err.detail = detail.slice(0, 300);
      throw err;
    }
    return r.status === 204 ? null : r.json();
  }

  async function findByRole(role) {
    var q = "appProperties has { key='rsRole' and value='" + role + "' } and trashed=false";
    var d = await api(DRIVE + '?q=' + encodeURIComponent(q) + '&fields=files(id,name,createdTime)&orderBy=createdTime&pageSize=10&spaces=drive');
    return d.files && d.files[0] ? d.files[0].id : null;
  }

  async function create(name, mimeType, role, parent) {
    var meta = { name: name, mimeType: mimeType, appProperties: { rsRole: role } };
    if (parent) meta.parents = [parent];
    var d = await api(DRIVE + '?fields=id', { method: 'POST', json: meta });
    return d.id;
  }

  async function findOrCreate(name, mimeType, role, parent) {
    return (await findByRole(role)) || (await create(name, mimeType, role, parent));
  }

  async function exists(id) {
    try {
      var d = await api(DRIVE + '/' + id + '?fields=id,trashed');
      return d && !d.trashed;
    } catch (e) {
      if (e.status === 404) return false;
      throw e;
    }
  }

  async function initLedger(sheetId) {
    var info = await api(SHEETS + '/' + sheetId + '?fields=sheets.properties');
    var titles = info.sheets.map(function (s) { return s.properties.title; });
    if (titles.indexOf('영수증') >= 0) return; // 이미 준비됨
    var first = info.sheets[0].properties.sheetId;
    await api(SHEETS + '/' + sheetId + ':batchUpdate', {
      method: 'POST', json: { requests: [
        { updateSheetProperties: { properties: { sheetId: first, title: '영수증', gridProperties: { frozenRowCount: 1 } }, fields: 'title,gridProperties.frozenRowCount' } },
        { addSheet: { properties: { title: '예산', gridProperties: { frozenRowCount: 1 } } } },
        { addSheet: { properties: { title: '메타' } } }
      ] }
    });
    await api(SHEETS + '/' + sheetId + '/values:batchUpdate', {
      method: 'POST', json: {
        valueInputOption: 'RAW',
        data: [
          { range: '영수증!A1:T1', values: [RECEIPT_HEADERS] },
          { range: '예산!A1:H1', values: [BUDGET_HEADERS] },
          { range: '메타!A1:B1', values: [['스키마 버전', SCHEMA_VERSION]] }
        ]
      }
    });
  }

  // 로그인 직후 한 번: 폴더·시트 준비
  async function ensureWorkspace(email, onStep) {
    var ws = loadWs(email);
    if (ws && ws.sheetId && await exists(ws.sheetId)) return ws;
    onStep && onStep('Drive에 폴더를 준비하는 중…');
    var root = await findOrCreate('영수증 스캔', FOLDER, 'root');
    var originals = await findOrCreate('원본', FOLDER, 'originals', root);
    var claims = await findOrCreate('청구본', FOLDER, 'claims', root);
    onStep && onStep('영수증 장부 시트를 준비하는 중…');
    var sheetId = await findOrCreate('영수증 장부', SHEET, 'ledger', root);
    await initLedger(sheetId);
    ws = { rootId: root, originalsId: originals, claimsId: claims, sheetId: sheetId };
    saveWs(email, ws);
    return ws;
  }

  // 영수증 탭 전체 읽기 → [{id, category, status, month, amount}]
  async function readReceipts(ws) {
    var d = await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('영수증!A2:T') + '?valueRenderOption=UNFORMATTED_VALUE');
    return (d.values || []).filter(function (r) { return r[COL.id]; }).map(function (r) {
      var amt = r[COL.amount];
      if (typeof amt === 'string') amt = Number(amt.replace(/[^\d.-]/g, ''));
      var m = r[COL.month];
      // PC에서 "2026-09"를 입력하면 시트가 날짜로 바꿔 숫자(일련번호)로 올 수 있음
      if (typeof m === 'number') {
        var dt = new Date(Date.UTC(1899, 11, 30) + m * 86400000);
        m = dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0');
      }
      return {
        id: String(r[COL.id]),
        category: r[COL.category] || '',
        status: r[COL.status] || '',
        month: String(m || '').slice(0, 7),
        amount: isFinite(amt) ? Number(amt) : 0
      };
    });
  }

  window.RSStore = {
    ensureWorkspace: ensureWorkspace,
    readReceipts: readReceipts,
    workspace: loadWs,
    sheetUrl: function (ws) { return 'https://docs.google.com/spreadsheets/d/' + ws.sheetId + '/edit'; },
    folderUrl: function (ws) { return 'https://drive.google.com/drive/folders/' + ws.rootId; }
  };
})();
