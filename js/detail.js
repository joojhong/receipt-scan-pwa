/* 영수증 상세(4단계 2번)
   - 사진을 보며 값을 직접 입력·수정. 확인필요·판독대기 영수증은 거래일·금액을 채워 저장하면 보관중이 됨
   - 구분별 추가 입력: 접대비(접대상대방) · 회의비(회의 내용) · 경비(계정 등) · 출장비(출장일)
   - [회전]은 시트에 회전 값만 기록(원본 사진은 그대로). PDF·AI 판독 때 이 값을 적용
   - 청구완료 영수증은 읽기 전용. [보관중으로 되돌리기] 후 고침
   - 저장은 바뀐 칸만 씀. 그사이 PC에서 같은 칸을 고쳤으면 PC 값을 남김(동기화 규칙: PC 우선) */
(function () {
  'use strict';

  var CATEGORIES = ['경비', '접대비', '회의비', '출장비'];
  var ACCOUNTS = ['8250000-교육훈련비', '8120003-교통비(대중교통 외)', '8110001-그 외 기타경비', '8260000-도서인쇄비', '8210002-보험료(차량보험)',
    '8290000-사무용품비', '8510000-샘플비(견본비)', '8300000-소모품비', '8200000-수선비(A/S)', '8120002-숙박비(출장 외)', '8110002-식비',
    '8140002-우편료', '8120001-자차운행비(별도서류첨부)', '8220001-주유비(회사차량)', '8220003-주차/통행료', '8310000-지급수수료(수수료 비용)',
    '8220002-차량유지관리비(회사 차량)', '8240000-택배비', '8140001-휴대폰(통신비)'];
  var FUEL_ACCOUNT = '8220001-주유비(회사차량)';
  var CAR_KEY = 'rs.detail.car';

  var D = null;    // { id, orig, v(편집값), monthFollows, saving, error, photo }
  var ctx = null;
  var photoCache = {}, photoOrder = [];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function won(n) { return Number(n || 0).toLocaleString('ko-KR'); }
  function p2(n) { return String(n).padStart(2, '0'); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function localIso(d) {
    var off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-'; off = Math.abs(off);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) +
      sign + p2(Math.floor(off / 60)) + ':' + p2(off % 60);
  }
  function fmtDT(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso || '');
    return m ? Number(m[2]) + '월 ' + Number(m[3]) + '일' + (m[4] ? ' ' + m[4] + ':' + m[5] : '') : '';
  }

  var ICON = {
    back: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
    rotate: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 11-2.3-5.6"/><path d="M20 4v5h-5"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  // 시트 값 → 편집값
  function toEdit(r) {
    var m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(r.txAt || '');
    var time = m && m[2] && m[2] !== '00:00' ? m[2] : '';
    return {
      category: r.category, date: m ? m[1] : '', time: time, amount: r.hasAmount ? String(r.amount) : '',
      merchant: r.merchant || '', address: r.address || '', desc: r.desc || '', memo: r.memo || '',
      month: r.month || '', widthMm: r.widthMm || 80, rot: r.rot || 0,
      guest: r.guest || '', topic: r.topic || '', account: r.account || '', fuel: r.fuel || '', work: r.work || '',
      car: r.car || '', from: r.from || '', to: r.to || '', km: r.km || '', tripDate: r.tripDate || '', attendees: r.attendees || ''
    };
  }

  function start(r) {
    var v = toEdit(r);
    var dm = v.date ? v.date.slice(0, 7) : '';
    D = { id: r.id, orig: r, base: toEdit(r), v: v, monthFollows: !v.month || !dm || v.month === dm, saving: false, error: '', photo: null, full: false };
    if (r.category === '경비' && !v.car) { try { v.car = localStorage.getItem(CAR_KEY) || ''; D.base.carDefault = v.car; } catch (e) { /* 무시 */ } }
  }

  // ── 그리기 ──
  function render(root, c) {
    ctx = c;
    var r = c.receipt;
    if (!r) {
      root.appendChild(el('<header class="dt-top"><button class="icon-btn" id="dtBack" aria-label="뒤로">' + ICON.back + '</button><h1>영수증 상세</h1></header>' +
        '<div class="empty"><b>영수증을 찾을 수 없습니다</b>시트에서 줄이 지워졌을 수 있습니다. (Drive 원본은 남아 있습니다)</div>'));
      root.querySelector('#dtBack').onclick = function () { ctx.back(); };
      return;
    }
    if (!D || D.id !== r.id) start(r);
    var v = D.v, st = r.st, ro = st === '청구완료' || st === 'upload';
    var badge = { upload: '업로드 대기', '판독대기': '판독 대기', '확인필요': '확인 필요', '보관중': '보관중', '청구완료': '청구완료', '제외': '제외' }[st] || st;
    var errs = validate();

    var h = '<header class="dt-top"><button class="icon-btn" id="dtBack" aria-label="뒤로">' + ICON.back + '</button><h1>영수증 상세</h1>' +
      '<span class="dt-st st-' + esc(st) + '">' + esc(badge) + '</span></header>';

    h += '<div class="dt-photo" id="dtPhoto">' + (D.photo ? '<img src="' + D.photo + '" alt="영수증 사진">' : '<div class="dt-ph">' + (D.photoErr ? '사진을 불러오지 못했습니다 <button class="mini" id="dtPhotoRetry" type="button">다시 시도</button>' : '사진을 불러오는 중…') + '</div>') +
      (!ro && D.photo ? '<button class="dt-rot" id="dtRot" type="button">' + ICON.rotate + '회전</button>' : '') + '</div>';

    if (st === 'upload') h += '<div class="banner">아직 Drive에 올라가지 않았습니다. 올라간 뒤 값을 고칠 수 있습니다. <button class="mini" id="dtRetry" type="button">지금 다시 시도</button></div>';
    if (st === '판독대기') h += '<div class="banner">AI 판독 전입니다. 직접 입력해도 됩니다. 거래일·금액을 채워 저장하면 PDF에 넣을 수 있습니다.</div>';
    if (st === '확인필요') h += '<div class="banner warn">확인이 필요합니다' + (r.reason ? ': ' + esc(r.reason) : '') + '. 거래일·금액을 확인해 저장해 주세요.</div>';
    if (st === '청구완료') h += '<div class="banner">청구완료된 영수증은 고칠 수 없습니다. 고치려면 [보관중으로 되돌리기]를 눌러 주세요.' +
      (r.claimedAt ? '<br>청구일: ' + esc(fmtDT(r.claimedAt)) : '') + '</div>';
    if (ctx.offline) h += '<div class="banner">오프라인입니다. 온라인에서만 저장할 수 있습니다.</div>';
    if (D.error) h += '<div class="banner warn" role="alert">' + esc(D.error) + '</div>';

    var dis = ro ? ' disabled' : '';
    h += '<div class="dt-form">';
    h += field('구분', '<div class="dt-seg">' + CATEGORIES.map(function (cn) {
      return '<button type="button" data-k="category" data-v="' + cn + '"' + (v.category === cn ? ' class="on"' : '') + dis + '>' + cn + '</button>';
    }).join('') + '</div>');
    h += '<div class="dt-2">' + field('거래일', '<input type="date" data-k="date" max="' + today() + '" value="' + esc(v.date) + '"' + dis + '>', errs.date, true) +
      field('시각(선택)', '<input type="time" data-k="time" value="' + esc(v.time) + '"' + dis + '>') + '</div>';
    h += field('금액', '<div class="dt-won"><input type="text" inputmode="numeric" data-k="amount" value="' + esc(v.amount ? won(v.amount) : '') + '" placeholder="0"' + dis + '><span>원</span></div>', errs.amount, true);
    h += extraFields(v, dis, errs);
    h += field('가맹점명', '<input type="text" data-k="merchant" maxlength="60" value="' + esc(v.merchant) + '"' + dis + '>');
    h += field('가맹점 주소', '<input type="text" data-k="address" maxlength="100" value="' + esc(v.address) + '"' + dis + '>');
    // 귀속 월: 기본은 거래일(카드 사용일)의 달로 자동. 필요하면 앱에서 바꿀 수 있음(예: 이번 달 청구에서 빼기)
    h += field('귀속 월', '<input type="month" data-k="month" value="' + esc(v.month) + '"' + dis + '>', errs.month, false,
      D.monthFollows ? '거래일(카드 사용일) 기준으로 자동으로 정해집니다. 바꾸면 그 달 청구로 옮겨집니다' : '직접 바꾼 값입니다. 거래일을 바꿔도 따라 바뀌지 않습니다');
    h += field('내역', '<input type="text" data-k="desc" maxlength="100" value="' + esc(v.desc) + '"' + dis + '>');
    h += field('메모', '<input type="text" data-k="memo" maxlength="100" value="' + esc(v.memo) + '"' + dis + '>');
    var other = [80, 58].indexOf(Number(v.widthMm)) < 0;
    h += field('영수증 폭', '<div class="dt-seg">' +
      '<button type="button" data-k="widthMm" data-v="80"' + (Number(v.widthMm) === 80 ? ' class="on"' : '') + dis + '>보통 80mm</button>' +
      '<button type="button" data-k="widthMm" data-v="58"' + (Number(v.widthMm) === 58 ? ' class="on"' : '') + dis + '>좁은 것 58mm</button>' +
      '<button type="button" data-k="widthMm" data-v="other"' + (other ? ' class="on"' : '') + dis + '>기타</button></div>' +
      (other ? '<div class="dt-won dt-mm"><input type="number" inputmode="numeric" data-k="widthNum" min="20" max="300" value="' + esc(v.widthMm) + '"' + dis + '><span>mm</span></div>' : ''), errs.widthMm);
    h += '<div class="dt-meta">촬영: ' + esc(fmtDT(r.capturedAt)) + '</div>';
    h += '</div>';

    // 아래 버튼
    var dirty = changedKeys().length > 0;
    var canSave = dirty && !Object.keys(errs).length && !D.saving && navigator.onLine;
    var btns = '';
    if (st === '청구완료') btns = '<button class="cta" id="dtUnclaim" type="button"' + (navigator.onLine && !D.saving ? '' : ' disabled') + '>보관중으로 되돌리기</button>';
    else if (st === '제외') btns = '<button class="cta" id="dtRestore" type="button"' + (navigator.onLine && !D.saving ? '' : ' disabled') + '>복원</button>';
    else if (st !== 'upload') btns = '<button class="btn-alt" id="dtExclude" type="button"' + (navigator.onLine && !D.saving ? '' : ' disabled') + '>제외</button>' +
      '<button class="cta" id="dtSave" type="button"' + (canSave ? '' : ' disabled') + '>' + (D.saving ? '저장 중…' : '저장') + '</button>';
    if (btns) h += '<div class="dt-bar">' + btns + '</div><div class="bx-space"></div>';
    if (D.full && D.photo) h += '<div class="dt-full" id="dtFull"><button class="icon-btn" id="dtFullClose" aria-label="닫기">' + ICON.close + '</button><img src="' + D.photo + '" alt=""></div>';

    root.appendChild(el(h));
    bind(root);
    if (!D.photo && !D.photoErr && !D.photoLoading) loadPhoto(r);
  }

  function field(label, input, err, req, hint) {
    return '<div class="dt-f"><span class="dt-l">' + label + (req ? ' <em>필수</em>' : '') + '</span>' + input +
      (err ? '<span class="dt-err">' + esc(err) + '</span>' : (hint ? '<span class="dt-hint">' + esc(hint) + '</span>' : '')) + '</div>';
  }

  // 구분별 추가 입력(필수 = 청구(PDF 만들기) 전에 채워야 함)
  function extraFields(v, dis, errs) {
    var h = '';
    var reqTag = function (t) { return t + ' <span class="opt">(선택)</span>'; }; // 모두 선택 입력(시트에서 적어도 됨)
    if (v.category === '접대비') h += field(reqTag('접대상대방'), '<input type="text" data-k="guest" maxlength="60" placeholder="예: ○○상사 김부장" value="' + esc(v.guest) + '"' + dis + '>');
    if (v.category === '회의비') {
      h += field(reqTag('회의 내용'), '<input type="text" data-k="topic" maxlength="100" placeholder="예: 3분기 영업 회의" value="' + esc(v.topic) + '"' + dis + '>');
      h += field('참석자(선택)', '<input type="text" data-k="attendees" maxlength="200" placeholder="예: 홍길동, 김철수" value="' + esc(v.attendees) + '"' + dis + '>', '', false, '나중에 구글 시트 "참석자" 열에 적어도 됩니다. 적으면 앱에도 보입니다');
    }
    if (v.category === '출장비') h += field(reqTag('출장일'), '<input type="date" data-k="tripDate" value="' + esc(v.tripDate) + '"' + dis + '>', errs.tripDate, false, '보통 출장 첫째 날. 같은 출장의 영수증을 묶는 데 씁니다');
    if (v.category === '경비') {
      h += field(reqTag('계정'), '<select data-k="account"' + dis + '><option value="">고르기</option>' + ACCOUNTS.map(function (a) {
        return '<option' + (v.account === a ? ' selected' : '') + '>' + esc(a) + '</option>';
      }).join('') + (v.account && ACCOUNTS.indexOf(v.account) < 0 ? '<option selected>' + esc(v.account) + '</option>' : '') + '</select>');
      if (v.account === FUEL_ACCOUNT) h += field(reqTag('주유량(L)'), '<div class="dt-won"><input type="text" inputmode="decimal" data-k="fuel" value="' + esc(v.fuel) + '"' + dis + '><span>L</span></div>', errs.fuel);
      h += field('업무내용', '<input type="text" data-k="work" maxlength="100" value="' + esc(v.work) + '"' + dis + '>');
      h += '<details class="dt-more"' + (v.car || v.from || v.to || v.km ? ' open' : '') + '><summary>차량 운행 정보(선택)</summary>' +
        field('업무용 차량', '<input type="text" data-k="car" maxlength="30" placeholder="예: 12가3456" value="' + esc(v.car) + '"' + dis + '>', '', false, '한 번 적으면 다음 경비 영수증에도 채워 둡니다') +
        '<div class="dt-2">' + field('출발지', '<input type="text" data-k="from" maxlength="40" value="' + esc(v.from) + '"' + dis + '>') +
        field('도착지', '<input type="text" data-k="to" maxlength="40" value="' + esc(v.to) + '"' + dis + '>') + '</div>' +
        field('운행거리', '<div class="dt-won"><input type="text" inputmode="decimal" data-k="km" value="' + esc(v.km) + '"' + dis + '><span>km</span></div>', errs.km) +
      '</details>';
    }
    return h;
  }

  function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content; }

  function validate() {
    var v = D.v, e = {};
    if (v.date && v.date > today()) e.date = '오늘 이후 날짜는 쓸 수 없습니다';
    if (v.amount !== '' && !(Number(v.amount) >= 1 && Number.isInteger(Number(v.amount)))) e.amount = '1원 이상 정수로 적어 주세요';
    if (v.fuel !== '' && !(Number(v.fuel) > 0)) e.fuel = '숫자로 적어 주세요';
    if (v.km !== '' && !(Number(v.km) >= 0)) e.km = '숫자로 적어 주세요';
    if (!(Number(v.widthMm) >= 20 && Number(v.widthMm) <= 300)) e.widthMm = '폭은 20~300mm로 적어 주세요';
    if (D.orig.st === '보관중' && (!v.date || v.amount === '')) {
      if (!v.date) e.date = '보관중 영수증은 거래일이 필요합니다';
      if (v.amount === '') e.amount = '보관중 영수증은 금액이 필요합니다';
    }
    return e;
  }

  var KEYS = ['category', 'date', 'time', 'amount', 'merchant', 'address', 'desc', 'memo', 'month', 'widthMm', 'rot',
    'guest', 'topic', 'account', 'fuel', 'work', 'car', 'from', 'to', 'km', 'tripDate', 'attendees'];
  function changedKeys() {
    return KEYS.filter(function (k) {
      if (k === 'car' && D.base.carDefault !== undefined && D.v.car === D.base.carDefault && !D.orig.car) return false; // 채워 둔 기본값만으로는 "바뀜" 아님
      return String(D.v[k]) !== String(D.base[k]);
    });
  }

  function bind(root) {
    var q = function (s) { return root.querySelector(s); };
    q('#dtBack').onclick = function () {
      if (D && changedKeys().length && !confirm('저장하지 않고 나갈까요?')) return;
      D = null; ctx.back();
    };
    root.querySelectorAll('[data-k]').forEach(function (inp) {
      var k = inp.dataset.k;
      if (inp.tagName === 'BUTTON') {
        inp.onclick = function () {
          if (k === 'widthMm') D.v.widthMm = inp.dataset.v === 'other' ? ([80, 58].indexOf(Number(D.v.widthMm)) < 0 ? D.v.widthMm : 100) : Number(inp.dataset.v);
          else D.v[k] = inp.dataset.v;
          redraw();
        };
        return;
      }
      var handler = function () {
        var val = inp.value;
        if (k === 'amount') {
          var digits = val.replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '');
          D.v.amount = digits;
          var f = digits ? won(digits) : '';
          if (inp.value !== f) { inp.value = f; }
        } else if (k === 'widthNum') {
          D.v.widthMm = val === '' ? '' : Number(val);
        } else if (k === 'date') {
          D.v.date = val;
          if (D.monthFollows && val) D.v.month = val.slice(0, 7);
        } else if (k === 'month') {
          D.v.month = val; D.monthFollows = false;
        } else {
          D.v[k] = val;
        }
      };
      inp.oninput = function () { handler(); refreshBar(root); };
      // 날짜·선택 칸은 값에 따라 다른 칸(귀속 월, 주유량)이 바뀌므로 다시 그림
      inp.onchange = function () { handler(); if (k === 'date' || k === 'account' || k === 'month' || k === 'widthNum' || k === 'tripDate') redraw(); else refreshBar(root); };
    });
    var rot = q('#dtRot');
    if (rot) rot.onclick = function (e) { e.stopPropagation(); D.v.rot = (Number(D.v.rot) + 1) % 4; drawPhoto(); };
    var ph = q('#dtPhoto');
    if (ph) ph.onclick = function () { if (D.photo) { D.full = true; redraw(); } };
    var pr = q('#dtPhotoRetry');
    if (pr) pr.onclick = function (e) { e.stopPropagation(); D.photoErr = false; redraw(); };
    var fc = q('#dtFullClose');
    if (fc) fc.onclick = function () { D.full = false; redraw(); };
    var rt = q('#dtRetry');
    if (rt) rt.onclick = function () { ctx.retryUpload(); ctx.toast('다시 올리는 중입니다'); };
    var sv = q('#dtSave');
    if (sv) sv.onclick = save;
    var ex = q('#dtExclude');
    if (ex) ex.onclick = function () { statusAction('exclude'); };
    var rs = q('#dtRestore');
    if (rs) rs.onclick = function () { statusAction('restore'); };
    var uc = q('#dtUnclaim');
    if (uc) uc.onclick = function () {
      if (!confirm('이 영수증을 보관중으로 되돌릴까요?\n이미 만든 PDF 파일은 지우지 않습니다.')) return;
      statusAction('unclaim');
    };
  }

  // 입력 중에는 화면 전체를 다시 그리지 않고 저장 버튼만 갱신(키보드가 닫히지 않게)
  function refreshBar(root) {
    var sv = root.querySelector('#dtSave');
    if (!sv) return;
    var errs = validate();
    sv.disabled = !(changedKeys().length && !Object.keys(errs).length && !D.saving && navigator.onLine);
  }

  function redraw() {
    var y = window.scrollY;
    ctx.rerender();
    window.scrollTo(0, y);
  }

  // ── 사진 ──
  async function loadPhoto(r) {
    D.photoLoading = true;
    var id = D.id;
    try {
      var blob = photoCache[r.id];
      if (!blob) {
        blob = await ctx.photoBlob(r);
        photoCache[r.id] = blob; photoOrder.push(r.id);
        while (photoOrder.length > 4) delete photoCache[photoOrder.shift()];
      }
      if (!D || D.id !== id) return;
      D.srcBlob = blob;
      await drawPhoto();
    } catch (e) {
      if (D && D.id === id) { D.photoErr = true; D.photoLoading = false; ctx.isActive() && redraw(); }
    }
  }

  async function drawPhoto() {
    if (!D || !D.srcBlob) return;
    var img = await new Promise(function (res, rej) {
      var u = URL.createObjectURL(D.srcBlob), im = new Image();
      im.onload = function () { URL.revokeObjectURL(u); res(im); };
      im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('image')); };
      im.src = u;
    });
    var c = RSImaging.rotate(RSImaging.scaled(toCanvas(img), 1600), Number(D.v.rot) || 0);
    var blob = await new Promise(function (res) { c.toBlob(res, 'image/jpeg', 0.85); });
    if (D.photo) URL.revokeObjectURL(D.photo);
    D.photo = URL.createObjectURL(blob);
    D.photoLoading = false;
    if (ctx.isActive()) redraw();
  }

  function toCanvas(img) {
    var c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  }

  // ── 저장 ──
  function sheetChanges() {
    var v = D.v, ch = {}, keys = changedKeys();
    keys.forEach(function (k) {
      if (k === 'date' || k === 'time') ch.txAt = v.date ? v.date + (v.time ? ' ' + v.time : '') : '';
      else if (k === 'amount') ch.amount = v.amount === '' ? '' : Number(v.amount);
      else if (k === 'rot') ch.rot = (Number(v.rot) || 0) * 90;
      else if (k === 'widthMm') ch.widthMm = Number(v.widthMm);
      else if (k === 'fuel' || k === 'km') ch[k] = v[k] === '' ? '' : Number(v[k]);
      else ch[k] = v[k];
    });
    // 기본값으로 채워 둔 차량을 저장할 때 함께 기록
    if (v.category === '경비' && v.car && !D.orig.car && ch.car === undefined && keys.length) ch.car = v.car;
    // 판독대기·확인필요 → 거래일·금액이 있으면 보관중
    var st = D.orig.st;
    if ((st === '판독대기' || st === '확인필요') && v.date && v.amount !== '') { ch.status = '보관중'; ch.reason = ''; }
    return ch;
  }

  async function save() {
    if (D.saving) return;
    var ch = sheetChanges();
    if (!Object.keys(ch).length) return;
    D.saving = true; D.error = ''; redraw();
    try {
      var res = await ctx.edit(D.id, ch, D.orig);
      if (D.v.car) { try { localStorage.setItem(CAR_KEY, D.v.car); } catch (e) { /* 무시 */ } }
      var msg = res.conflicts.length ? 'PC에서 수정된 값으로 바뀌었습니다: ' + res.conflicts.join(', ') : (ch.status === '보관중' ? '저장했습니다 · 이제 PDF에 넣을 수 있습니다' : '저장했습니다');
      D = null;
      ctx.toast(msg);
      ctx.back();
    } catch (e) {
      D.saving = false; D.error = e.message || '저장하지 못했습니다'; redraw();
    }
  }

  async function statusAction(kind) {
    var r = D.orig;
    D.saving = true; D.error = ''; redraw();
    try {
      await ctx.statusAction(kind, r);
      D = null;
      ctx.back();
    } catch (e) {
      D.saving = false; D.error = e.message || '처리하지 못했습니다'; redraw();
    }
  }

  window.RSDetail = {
    render: render,
    reset: function () { D = null; photoCache = {}; photoOrder = []; },
    ACCOUNTS: ACCOUNTS
  };
})();
