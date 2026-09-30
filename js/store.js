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
  var SCHEMA_VERSION = 3; // 2: 카드사 열(F) 추가, 3: 카드 구분 열(G, 법인카드/개인카드) 추가

  // 열 순서는 "데이터·API 스펙" 탭 표 순서(A~V)
  var RECEIPT_HEADERS = ['ID', '유형', '촬영일시', '구분', '상태', '카드사', '카드 구분', '거래일시', '귀속 월', '금액', '가맹점명', '가맹점 주소',
    '내역', '메모', '영수증 폭', '판독 신뢰도', '확인 사유', '판독 시도', '원본 파일 ID', '청구 PDF ID', '청구일시', '앱 수정일시'];
  var BUDGET_HEADERS = ['ID', '적용 월', '구분', '유형', '이월 방식', '금액', '메모', '앱 수정일시'];
  var COL = { id: 0, kind: 1, capturedAt: 2, category: 3, status: 4, card: 5, cardType: 6, txAt: 7, month: 8, amount: 9 };

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
          { range: '영수증!A1:V1', values: [RECEIPT_HEADERS] },
          { range: '예산!A1:H1', values: [BUDGET_HEADERS] },
          { range: '메타!A1:B1', values: [['스키마 버전', SCHEMA_VERSION]] }
        ]
      }
    });
  }

  // 예전 형식 시트를 새 형식으로 고침(버전마다 열 하나씩 끼워 넣음, 기존 데이터는 오른쪽으로 밀림)
  var MIGRATIONS = [
    { to: 2, index: 5, cell: 'F1', header: '카드사' },
    { to: 3, index: 6, cell: 'G1', header: '카드 구분' }
  ];

  async function migrate(sheetId) {
    var meta = await api(SHEETS + '/' + sheetId + '/values/' + encodeURIComponent('메타!B1') + '?valueRenderOption=UNFORMATTED_VALUE');
    var ver = Number(meta.values && meta.values[0] && meta.values[0][0]) || 1;
    if (ver >= SCHEMA_VERSION) return;
    var info = await api(SHEETS + '/' + sheetId + '?fields=sheets.properties');
    var tab = info.sheets.find(function (s) { return s.properties.title === '영수증'; });
    if (!tab) return;
    for (var i = 0; i < MIGRATIONS.length; i++) {
      var mg = MIGRATIONS[i];
      if (ver >= mg.to) continue;
      var head = await api(SHEETS + '/' + sheetId + '/values/' + encodeURIComponent('영수증!' + mg.cell));
      var already = head.values && head.values[0] && head.values[0][0] === mg.header;
      if (!already) {
        await api(SHEETS + '/' + sheetId + ':batchUpdate', {
          method: 'POST', json: { requests: [{ insertDimension: {
            range: { sheetId: tab.properties.sheetId, dimension: 'COLUMNS', startIndex: mg.index, endIndex: mg.index + 1 },
            inheritFromBefore: false } }] }
        });
      }
      await api(SHEETS + '/' + sheetId + '/values:batchUpdate', {
        method: 'POST', json: { valueInputOption: 'RAW', data: [
          { range: '영수증!' + mg.cell, values: [[mg.header]] },
          { range: '메타!B1', values: [[mg.to]] }
        ] }
      });
      ver = mg.to;
    }
  }

  // 로그인 직후 한 번: 폴더·시트 준비
  async function ensureWorkspace(email, onStep) {
    var ws = loadWs(email);
    if (ws && ws.sheetId && await exists(ws.sheetId)) { await migrate(ws.sheetId); return ws; }
    onStep && onStep('Drive에 폴더를 준비하는 중…');
    var root = await findOrCreate('영수증 스캔', FOLDER, 'root');
    var originals = await findOrCreate('원본', FOLDER, 'originals', root);
    var claims = await findOrCreate('청구본', FOLDER, 'claims', root);
    onStep && onStep('영수증 장부 시트를 준비하는 중…');
    var sheetId = await findOrCreate('영수증 장부', SHEET, 'ledger', root);
    await initLedger(sheetId);
    await migrate(sheetId);
    ws = { rootId: root, originalsId: originals, claimsId: claims, sheetId: sheetId };
    saveWs(email, ws);
    return ws;
  }

  // 영수증 탭 전체 읽기 → [{id, category, status, month, amount}]
  async function readReceipts(ws) {
    var d = await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('영수증!A2:V') + '?valueRenderOption=UNFORMATTED_VALUE');
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
        card: r[COL.card] || '',
        cardType: r[COL.cardType] || '',
        month: String(m || '').slice(0, 7),
        amount: isFinite(amt) ? Number(amt) : 0
      };
    });
  }

  // ── 촬영한 영수증 올리기(업로드 대기열이 씀) ──
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

  // 원본/2026-09 같은 달 폴더. 없으면 만듦(appProperties로 찾으므로 이름을 바꿔도 찾음)
  async function monthFolder(ws, month, email) {
    var key = 'rs.mf.' + email + '.' + month;
    var cached = null;
    try { cached = localStorage.getItem(key); } catch (e) { /* 무시 */ }
    if (cached && await exists(cached)) return cached;
    var q = "appProperties has { key='rsRole' and value='month' } and appProperties has { key='rsMonth' and value='" + month + "' }" +
      " and '" + ws.originalsId + "' in parents and trashed=false";
    var d = await api(DRIVE + '?q=' + encodeURIComponent(q) + '&fields=files(id)&orderBy=createdTime&pageSize=5&spaces=drive');
    var id = d.files && d.files[0] ? d.files[0].id : null;
    if (!id) {
      var r = await api(DRIVE + '?fields=id', { method: 'POST', json: {
        name: month, mimeType: FOLDER, parents: [ws.originalsId], appProperties: { rsRole: 'month', rsMonth: month } } });
      id = r.id;
    }
    try { localStorage.setItem(key, id); } catch (e) { /* 무시 */ }
    return id;
  }

  // 같은 영수증 ID로 이미 올린 파일이 있으면 그 ID(재시도해도 중복으로 올리지 않기 위함)
  async function findUpload(receiptId) {
    var q = "appProperties has { key='rsReceiptId' and value='" + receiptId + "' } and trashed=false";
    var d = await api(DRIVE + '?q=' + encodeURIComponent(q) + '&fields=files(id)&pageSize=1&spaces=drive');
    return d.files && d.files[0] ? d.files[0].id : null;
  }

  async function uploadJpeg(parentId, receiptId, blob) {
    var meta = { name: receiptId + '.jpg', mimeType: 'image/jpeg', parents: [parentId], appProperties: { rsReceiptId: receiptId } };
    var b = 'rs' + Math.random().toString(36).slice(2);
    var body = new Blob([
      '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n',
      '--' + b + '\r\nContent-Type: image/jpeg\r\n\r\n', blob, '\r\n--' + b + '--'
    ]);
    var d = await api(UPLOAD + '?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: body });
    return d.id;
  }

  async function hasReceiptRow(ws, receiptId) {
    var d = await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('영수증!A2:A'));
    return (d.values || []).some(function (r) { return r[0] === receiptId; });
  }

  // 영수증 탭에 한 줄 추가(열 순서는 RECEIPT_HEADERS)
  async function appendReceipt(ws, r) {
    var row = new Array(RECEIPT_HEADERS.length).fill('');
    row[COL.id] = r.id;
    row[COL.kind] = '영수증';
    row[COL.capturedAt] = r.capturedAt;
    row[COL.category] = r.category;
    row[COL.status] = '판독대기';
    row[COL.card] = '';
    row[COL.cardType] = r.cardType;
    row[COL.month] = r.month;
    row[13] = r.memo || '';          // 메모
    row[14] = r.widthMm;             // 영수증 폭
    row[17] = 0;                     // 판독 시도
    row[18] = r.fileId;              // 원본 파일 ID
    row[21] = r.updatedAt;           // 앱 수정일시
    await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('영수증!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
      method: 'POST', json: { values: [row] } });
  }

  window.RSStore = {
    monthFolder: monthFolder,
    findUpload: findUpload,
    uploadJpeg: uploadJpeg,
    hasReceiptRow: hasReceiptRow,
    appendReceipt: appendReceipt,
    ensureWorkspace: ensureWorkspace,
    readReceipts: readReceipts,
    workspace: loadWs,
    sheetUrl: function (ws) { return 'https://docs.google.com/spreadsheets/d/' + ws.sheetId + '/edit'; },
    folderUrl: function (ws) { return 'https://drive.google.com/drive/folders/' + ws.rootId; }
  };
})();
