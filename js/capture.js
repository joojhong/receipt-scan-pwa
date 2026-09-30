/* 촬영 화면(3단계)
   순서: 구분·카드 구분·영수증 폭 고르기 → [촬영]/[갤러리] → 모서리 4점 맞추기 → 보정 미리보기(흑백/컬러, 회전, 메모) → 저장
   - 화면 요소를 한 번 만들어 두고 계속 씀(앱의 다른 화면 갱신 때 사진·모서리 위치가 지워지지 않도록)
   - 저장 = 폰에 저장 후 업로드 대기열에 넣음. Drive 업로드·시트 기록은 뒤에서 진행 */
(function () {
  'use strict';

  var CATEGORIES = ['경비', '접대비', '회의비', '출장비'];
  var CARD_TYPES = ['카드(개인)', '카드(법인)', '현금'];
  var WIDTHS = [80, 58];
  var PREF_KEY = 'rs.capture.prefs';

  function loadPrefs() {
    var p = {};
    try { p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { p = {}; }
    return {
      category: '',                                  // 구분은 매번 새로 고름(미리 골라 두지 않음)
      saved: !!p.cardType,                           // 결제·폭을 한 번이라도 골랐는지
      cardType: CARD_TYPES.indexOf(p.cardType) >= 0 ? p.cardType : '카드(개인)',
      widthMm: Number(p.widthMm) > 0 ? Number(p.widthMm) : 80,
      // 기본값 = 스캔 컬러(빨간 도장·색 글씨가 남도록). 예전 기본값 흑백이 저장된 경우도 한 번 컬러로 바꿈
      mode: p.md === 2 ? (p.mode === 'gray' ? 'gray' : 'color') : 'color'
    };
  }
  function savePrefs(p) {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ cardType: p.cardType, widthMm: p.widthMm, mode: p.mode === 'orig' ? 'color' : p.mode, md: 2 })); } catch (e) { /* 무시 */ }
  }
  var PAY_LABEL = { '카드(개인)': '개인 카드', '카드(법인)': '법인 카드', '현금': '현금' };
  function widthLabel(w) { return w === 80 ? '보통(80mm)' : w === 58 ? '좁은 것(58mm)' : '기타(' + w + 'mm)'; }

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  // 한국 시간 그대로 적은 ISO 8601(예: 2026-09-30T14:05:12+09:00)
  function localIso(d) {
    var p = function (n) { return String(n).padStart(2, '0'); };
    var off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-';
    off = Math.abs(off);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
      sign + p(Math.floor(off / 60)) + ':' + p(off % 60);
  }

  var ICON = {
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    gallery: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l5-5 4 4 2-2 3 3"/></svg>',
    rotate: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 11-2.3-5.6"/><path d="M20 4v5h-5"/></svg>'
  };

  // ── 화면 상태 ──
  var S = null;   // 화면을 닫으면 null
  var ctx = null; // 앱이 넘겨주는 것: { email, toast, onSaved, onClose }

  function fresh() {
    return {
      el: null, prefs: loadPrefs(), step: 'select', sheet: false, upInfo: '', files: [], fileIndex: 0, saved: 0,
      work: null, corners: null, warped: null, rot: 0, memo: '', busy: '', error: '', drag: -1, warpFailed: false
    };
  }

  // ── 그리기 ──
  function mount(root, c) {
    ctx = c;
    if (!S) {
      S = fresh(); S.el = document.createElement('div'); S.el.className = 'cap';
      if (c.category && CATEGORIES.indexOf(c.category) >= 0) S.prefs.category = c.category;
      draw(); refreshUpInfo();
    }
    root.appendChild(S.el);
    if (S.step === 'adjust') requestAnimationFrame(layoutAdjust);
    if (S.step === 'preview') requestAnimationFrame(drawPreview);
  }

  function chips(name, list, cur, fmt) {
    return list.map(function (v) {
      return '<button type="button" class="chip-btn' + (String(v) === String(cur) ? ' on' : '') + '" data-k="' + name + '" data-v="' + esc(v) + '">' + esc(fmt ? fmt(v) : v) + '</button>';
    }).join('');
  }

  function header(title, sub) {
    return '<header class="cap-top"><button class="icon-btn" id="capClose" aria-label="닫기">' + ICON.close + '</button>' +
      '<h1>' + esc(title) + '</h1>' + (sub ? '<span class="cap-sub">' + esc(sub) + '</span>' : '<span class="cap-sub"></span>') + '</header>';
  }

  function summary() {
    var p = S.prefs;
    return '<div class="cap-sum">' + esc(p.category) + ' · ' + esc(PAY_LABEL[p.cardType] || p.cardType) + ' · ' + esc(widthLabel(p.widthMm)) + '</div>';
  }

  function draw() {
    var p = S.prefs, h = '';
    if (S.step === 'select') {
      var ready = !!p.category && !S.busy;
      var tiles = CATEGORIES.map(function (c) {
        return '<button type="button" class="tile' + (p.category === c ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>';
      }).join('');
      h = header('영수증 촬영', S.saved ? '이번에 ' + S.saved + '장 저장' : '') +
        '<div class="cap-q">어떤 비용인가요?</div>' +
        '<div class="tiles">' + tiles + '</div>' +
        '<div class="pay' + (p.saved ? '' : ' first') + '"><div class="pay-t"><small>결제 · 영수증 폭</small>' +
          esc(PAY_LABEL[p.cardType] || p.cardType) + ' · ' + esc(widthLabel(p.widthMm)) +
          (p.saved ? '' : '<em>처음이면 한 번 확인해 주세요</em>') + '</div>' +
          '<button class="chg" id="payBtn" type="button">바꾸기</button></div>' +
        (S.error ? '<p class="err" role="alert">' + esc(S.error) + '</p>' : '') +
        (ready ? '<label class="big-cta" for="camInput">' + ICON.camera + '촬영</label>'
               : '<button class="big-cta off" id="camOff" type="button">' + ICON.camera + (S.busy ? esc(S.busy) : '촬영') + '</button>') +
        (ready ? '<label class="gal-btn" for="libInput">갤러리에서 고르기</label>'
               : '<button class="gal-btn off" id="libOff" type="button">갤러리에서 고르기</button>') +
        (p.category ? '' : '<p class="cap-need">먼저 위에서 비용 구분을 골라 주세요.</p>') +
        (S.upInfo ? '<p class="cap-up">' + esc(S.upInfo) + '</p>' : '') +
        '<ul class="cap-tips"><li><b>영수증을 손으로 펴고</b> 찍어 주세요. 구겨진 모양은 보정으로 펴지지 않습니다.</li>' +
          '<li>영수증 윗부분이 화면 위쪽으로 오게 찍어 주세요.</li>' +
          '<li>어두운 바탕에 놓으면 테두리가 잘 보입니다.</li></ul>' +
        '<input id="camInput" type="file" accept="image/*" capture="environment" hidden>' +
        '<input id="libInput" type="file" accept="image/*" multiple hidden>' +
        (S.sheet ? paySheet() : '');
    } else if (S.step === 'adjust') {
      h = header('모서리 맞추기', S.files.length > 1 ? (S.fileIndex + 1) + ' / ' + S.files.length : '') +
        '<div class="cap-stage" id="stage"><canvas id="adjCanvas"></canvas><canvas id="loupe" class="loupe" width="240" height="240" hidden></canvas></div>' +
        '<p class="cap-tip">' + (S.auto
          ? (S.usingAuto ? '영수증 테두리를 자동으로 찾았습니다. 어긋난 곳만 동그라미를 끌어 맞춰 주세요.' : '동그라미를 끌어 영수증 끝에 맞춰 주세요.')
          : '테두리를 자동으로 찾지 못했습니다. 네 모서리의 동그라미를 끌어 영수증 끝에 맞춰 주세요.') + '</p>' +
        (S.error ? '<p class="err" role="alert">' + esc(S.error) + '</p>' : '') +
        '<div class="cap-actions three">' +
          '<button class="btn-alt" id="retake" type="button">다시 찍기</button>' +
          '<button class="btn-alt" id="fullBtn" type="button">' + (S.auto && !S.usingAuto ? '자동 테두리' : '사진 전체') + '</button>' +
          '<button class="cta" id="nextBtn" type="button"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? esc(S.busy) : '다음') + '</button>' +
        '</div>';
    } else if (S.step === 'preview') {
      h = header('보정 확인', S.files.length > 1 ? (S.fileIndex + 1) + ' / ' + S.files.length : '') +
        summary() +
        '<div class="cap-stage prev" id="stage"><canvas id="prevCanvas"></canvas></div>' +
        (S.warpFailed ? '<p class="err">보정하지 못해 원본 그대로 보여 줍니다. 이대로 저장하거나 다시 찍어 주세요.</p>' : '') +
        '<div class="cap-tools">' +
          '<div class="seg">' +
            '<button type="button" class="' + (p.mode === 'color' ? 'on' : '') + '" data-mode="color">컬러</button>' +
            '<button type="button" class="' + (p.mode === 'gray' ? 'on' : '') + '" data-mode="gray">흑백</button>' +
            '<button type="button" class="' + (p.mode === 'orig' ? 'on' : '') + '" data-mode="orig">원본</button>' +
          '</div>' +
          '<button class="btn-alt small" id="rotBtn" type="button">' + ICON.rotate + '회전</button>' +
        '</div>' +
        '<input class="cap-memo" id="memoInput" type="text" maxlength="100" placeholder="메모(선택)" value="' + esc(S.memo) + '">' +
        (S.error ? '<p class="err" role="alert">' + esc(S.error) + '</p>' : '') +
        '<div class="cap-actions three">' +
          '<button class="btn-alt" id="retake" type="button">다시 찍기</button>' +
          '<button class="btn-alt" id="saveMore" type="button"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? esc(S.busy) : '저장하고 계속') + '</button>' +
          '<button class="cta" id="saveDone" type="button"' + (S.busy ? ' disabled' : '') + '>저장하고 완료</button>' +
        '</div>';
    }
    S.el.innerHTML = h;
    bind();
    if (S.step === 'adjust') requestAnimationFrame(layoutAdjust);
    if (S.step === 'preview') requestAnimationFrame(drawPreview);
  }

  function paySheet() {
    var p = S.prefs, other = WIDTHS.indexOf(p.widthMm) < 0;
    var pays = CARD_TYPES.map(function (v) {
      return '<button type="button" class="' + (p.cardType === v ? 'on' : '') + '" data-pay="' + esc(v) + '">' + esc(PAY_LABEL[v]) + '</button>';
    }).join('');
    var w = function (mm, name, bar) {
      return '<button type="button" class="wc' + (p.widthMm === mm ? ' on' : '') + '" data-w="' + mm + '"><i style="width:' + bar + 'px"></i><span><b>' + name + '</b><small>' + mm + 'mm</small></span></button>';
    };
    return '<div class="sheet-backdrop" id="payBack"><div class="sheet pay-sheet" role="dialog" aria-label="결제와 영수증 폭">' +
      '<div class="grab"></div>' +
      '<div class="cap-q">무엇으로 결제했나요?</div><div class="seg3">' + pays + '</div>' +
      '<div class="cap-q">영수증 폭</div>' +
      '<div class="wrow">' + w(80, '보통', 22) + w(58, '좁은 것', 15) +
        '<button type="button" class="wc o' + (other ? ' on' : '') + '" data-w="other">기타</button></div>' +
      (other ? '<div class="cap-other"><input id="widthInput" type="number" inputmode="numeric" min="20" max="300" value="' + p.widthMm + '"> mm</div>' : '') +
      '<p class="hint">고른 값은 다음 촬영 때도 그대로 남습니다.</p>' +
      '<div class="cap-actions one"><button class="cta" id="payOk" type="button">확인</button></div>' +
      '</div></div>';
  }

  // 업로드 상태 한 줄(촬영 화면 아래)
  function refreshUpInfo() {
    if (!S || !ctx) return;
    RSQueue.pending(ctx.email).then(function (list) {
      if (!S) return;
      var t = !list.length ? (S.saved ? '찍은 영수증을 모두 Drive에 올렸습니다.' : '') :
        RSQueue.busy() ? 'Drive에 올리는 중 ' + list.length + '건 · 앱을 닫지 말아 주세요' :
        '업로드 대기 ' + list.length + '건 · 인터넷이 연결되면 올립니다';
      if (t !== S.upInfo) { S.upInfo = t; if (S.step === 'select') draw(); }
    }).catch(function () {});
  }
  RSQueue.onChange(refreshUpInfo);

  function $(id) { return S.el.querySelector('#' + id); }

  function bind() {
    var c = $('capClose');
    if (c) c.onclick = close;
    S.el.querySelectorAll('.chip-btn').forEach(function (b) {
      b.onclick = function () {
        var k = b.dataset.k, v = b.dataset.v;
        if (k === 'width') S.prefs.widthMm = v === 'other' ? (WIDTHS.indexOf(S.prefs.widthMm) < 0 ? S.prefs.widthMm : 100) : Number(v);
        else S.prefs[k] = v;
        savePrefs(S.prefs); draw();
      };
    });
    S.el.querySelectorAll('[data-cat]').forEach(function (b) {
      b.onclick = function () { S.prefs.category = b.dataset.cat; S.error = ''; draw(); };
    });
    var pb = $('payBtn');
    if (pb) pb.onclick = function () { S.sheet = true; draw(); };
    ['camOff', 'libOff'].forEach(function (id) {
      var b = $(id);
      if (b) b.onclick = function () { if (!S.busy) ctx.toast('먼저 비용 구분을 골라 주세요'); };
    });
    var back = $('payBack');
    if (back) back.onclick = function (e) { if (e.target === back) closeSheet(); };
    S.el.querySelectorAll('[data-pay]').forEach(function (b) {
      b.onclick = function () { S.prefs.cardType = b.dataset.pay; draw(); };
    });
    S.el.querySelectorAll('[data-w]').forEach(function (b) {
      b.onclick = function () {
        var v = b.dataset.w;
        S.prefs.widthMm = v === 'other' ? (WIDTHS.indexOf(S.prefs.widthMm) < 0 ? S.prefs.widthMm : 100) : Number(v);
        draw();
      };
    });
    var ok = $('payOk');
    if (ok) ok.onclick = closeSheet;
    var wi = $('widthInput');
    if (wi) wi.onchange = function () {
      var n = Math.round(Number(wi.value));
      if (!(n >= 20 && n <= 300)) { ctx.toast('폭은 20~300mm로 적어 주세요'); wi.value = S.prefs.widthMm; return; }
      S.prefs.widthMm = n; savePrefs(S.prefs);
    };
    ['camInput', 'libInput'].forEach(function (id) {
      var inp = $(id);
      if (inp) inp.onchange = function () {
        var list = Array.prototype.slice.call(inp.files || []);
        inp.value = '';
        if (list.length) startFiles(list);
      };
    });
    var r = $('retake');
    if (r) r.onclick = function () { discardCurrent(); nextFileOrSelect(); };
    var f = $('fullBtn');
    if (f) f.onclick = function () {
      if (S.auto && !S.usingAuto) { S.corners = S.auto.map(function (p) { return { x: p.x, y: p.y }; }); S.usingAuto = true; }
      else { S.corners = defaultCorners(S.work, 0); S.usingAuto = false; }
      draw();
    };
    var n = $('nextBtn');
    if (n) n.onclick = toPreview;
    S.el.querySelectorAll('[data-mode]').forEach(function (b) {
      b.onclick = function () {
        S.prefs.mode = b.dataset.mode;
        if (b.dataset.mode !== 'orig') savePrefs(S.prefs);
        draw();
      };
    });
    var rb = $('rotBtn');
    if (rb) rb.onclick = function () { S.rot = (S.rot + 1) % 4; drawPreview(); };
    var mi = $('memoInput');
    if (mi) mi.oninput = function () { S.memo = mi.value; };
    var sm = $('saveMore');
    if (sm) sm.onclick = function () { save(false); };
    var sd = $('saveDone');
    if (sd) sd.onclick = function () { save(true); };
  }

  function closeSheet() {
    var wi = $('widthInput');
    if (wi) {
      var n = Math.round(Number(wi.value));
      if (!(n >= 20 && n <= 300)) { ctx.toast('폭은 20~300mm로 적어 주세요'); return; }
      S.prefs.widthMm = n;
    }
    S.prefs.saved = true; savePrefs(S.prefs); S.sheet = false; draw();
  }

  function close() {
    if ((S.step === 'adjust' || S.step === 'preview') && !confirm('저장하지 않고 나갈까요?')) return;
    var n = S.saved;
    S = null;
    ctx.onClose(n);
  }

  // ── 사진 불러오기 ──
  async function startFiles(list) {
    S.files = list; S.fileIndex = 0; S.error = '';
    await openCurrent();
  }

  async function openCurrent() {
    var file = S.files[S.fileIndex];
    S.busy = '사진을 여는 중…'; S.error = ''; draw();
    try {
      S.work = await RSImaging.open(file);
      // 영수증 테두리를 자동으로 찾고, 못 찾으면 사진 안쪽 사각형
      var auto = null;
      try { auto = RSImaging.detectQuad(S.work); } catch (e2) { auto = null; }
      S.auto = auto; S.usingAuto = !!auto;
      S.corners = auto ? auto.map(function (p) { return { x: p.x, y: p.y }; }) : defaultCorners(S.work, 0.06);
      S.warped = null; S.rot = 0; S.memo = ''; S.warpFailed = false;
      if (S.prefs.mode === 'orig') S.prefs.mode = loadPrefs().mode;
      S.busy = ''; S.step = 'adjust'; draw();
    } catch (e) {
      S.busy = '';
      S.error = '이 사진 형식은 쓸 수 없습니다(JPG·PNG·WebP). 폰 카메라 설정에서 사진 형식을 "호환성"이 높은 쪽으로 바꾸면 JPG로 찍힙니다.';
      if (S.fileIndex < S.files.length - 1) { S.fileIndex++; ctx.toast('열 수 없는 사진은 건너뜁니다'); return openCurrent(); }
      S.step = 'select'; S.files = []; draw();
    }
  }

  function defaultCorners(c, inset) {
    var w = c.width, h = c.height, dx = w * inset, dy = h * inset;
    return [{ x: dx, y: dy }, { x: w - dx, y: dy }, { x: w - dx, y: h - dy }, { x: dx, y: h - dy }];
  }

  function discardCurrent() { S.work = null; S.warped = null; S.corners = null; }

  function nextFileOrSelect() {
    S.error = '';
    if (S.fileIndex < S.files.length - 1) { S.fileIndex++; openCurrent(); return; }
    S.files = []; S.fileIndex = 0; S.step = 'select'; draw();
  }

  // ── 모서리 맞추기 ──
  var view = { scale: 1, dpr: 1, w: 0, h: 0 };

  function layoutAdjust() {
    if (!S || S.step !== 'adjust' || !S.work) return;
    var stage = $('stage'), cv = $('adjCanvas');
    if (!stage || !cv) return;
    var maxW = stage.clientWidth || (window.innerWidth - 32);
    var maxH = Math.max(240, window.innerHeight * 0.58);
    var s = Math.min(maxW / S.work.width, maxH / S.work.height);
    view.scale = s; view.dpr = window.devicePixelRatio || 1;
    view.w = Math.round(S.work.width * s); view.h = Math.round(S.work.height * s);
    cv.style.width = view.w + 'px'; cv.style.height = view.h + 'px';
    cv.width = Math.round(view.w * view.dpr); cv.height = Math.round(view.h * view.dpr);
    renderAdjust();
    if (!cv._bound) { bindDrag(cv); cv._bound = true; }
  }

  function renderAdjust() {
    var cv = $('adjCanvas');
    if (!cv || !S.work) return;
    var g = cv.getContext('2d'), k = view.scale * view.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    g.drawImage(S.work, 0, 0, cv.width, cv.height);
    var q = S.corners;
    // 바깥 어둡게
    g.save();
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.beginPath();
    g.rect(0, 0, cv.width, cv.height);
    g.moveTo(q[0].x * k, q[0].y * k);
    for (var i = 3; i >= 0; i--) g.lineTo(q[i].x * k, q[i].y * k);
    g.closePath();
    g.fill('evenodd');
    g.restore();
    // 테두리
    g.lineWidth = 2 * view.dpr; g.strokeStyle = '#4F7BFF';
    g.beginPath();
    q.forEach(function (p, i) { if (i) g.lineTo(p.x * k, p.y * k); else g.moveTo(p.x * k, p.y * k); });
    g.closePath(); g.stroke();
    // 모서리 점
    q.forEach(function (p, i) {
      g.beginPath();
      g.arc(p.x * k, p.y * k, (S.drag === i ? 16 : 13) * view.dpr, 0, Math.PI * 2);
      g.fillStyle = 'rgba(79,123,255,0.25)'; g.fill();
      g.lineWidth = 3 * view.dpr; g.strokeStyle = '#FFFFFF'; g.stroke();
    });
  }

  function bindDrag(cv) {
    cv.style.touchAction = 'none';
    function pos(ev) {
      var r = cv.getBoundingClientRect();
      return { x: (ev.clientX - r.left) / view.scale, y: (ev.clientY - r.top) / view.scale, cx: ev.clientX - r.left, cy: ev.clientY - r.top };
    }
    cv.addEventListener('pointerdown', function (ev) {
      if (!S || !S.corners) return;
      var p = pos(ev), best = -1, bd = Infinity;
      S.corners.forEach(function (c, i) {
        var d = Math.hypot((c.x - p.x) * view.scale, (c.y - p.y) * view.scale);
        if (d < bd) { bd = d; best = i; }
      });
      if (bd > 70) return;                       // 모서리에서 너무 멀면 무시
      S.drag = best;
      S.grab = { dx: S.corners[best].x - p.x, dy: S.corners[best].y - p.y };
      cv.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      renderAdjust(); loupe(p);
    });
    cv.addEventListener('pointermove', function (ev) {
      if (!S || S.drag < 0) return;
      var p = pos(ev);
      var x = Math.max(0, Math.min(S.work.width, p.x + S.grab.dx));
      var y = Math.max(0, Math.min(S.work.height, p.y + S.grab.dy));
      S.corners[S.drag] = { x: x, y: y };
      renderAdjust(); loupe(p);
      ev.preventDefault();
    });
    function end() { if (!S) return; S.drag = -1; renderAdjust(); var l = $('loupe'); if (l) l.hidden = true; }
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }

  // 손가락에 가려지지 않게 모서리 부분을 확대해서 보여 줌(손가락 반대쪽 위 모서리)
  function loupe(p) {
    var l = $('loupe');
    if (!l || S.drag < 0) return;
    var c = S.corners[S.drag], g = l.getContext('2d'), size = 240, zoom = 3;
    var srcSize = size / (zoom * view.scale);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#000'; g.fillRect(0, 0, size, size);
    g.drawImage(S.work, c.x - srcSize / 2, c.y - srcSize / 2, srcSize, srcSize, 0, 0, size, size);
    g.strokeStyle = '#4F7BFF'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(size / 2, 0); g.lineTo(size / 2, size); g.moveTo(0, size / 2); g.lineTo(size, size / 2); g.stroke();
    l.hidden = false;
    l.style.left = (p.cx < view.w / 2 ? view.w - 128 : 8) + 'px';
    l.style.top = '8px';
  }

  // ── 보정 ──
  async function toPreview() {
    S.busy = '보정 중…'; draw();
    await new Promise(function (r) { setTimeout(r, 30); }); // 버튼 표시가 먼저 바뀌도록
    try {
      S.warped = RSImaging.warp(S.work, S.corners);
      S.warpFailed = false;
    } catch (e) {
      S.warped = S.work; S.warpFailed = true;
    }
    // 글자 줄이 세로로 서 있으면(옆으로 찍힌 영수증) 90° 돌려 세움. 위아래가 바뀌면 [회전]
    S.rot = RSImaging.textSideways(S.warped) ? 1 : 0;
    S.busy = ''; S.step = 'preview'; draw();
  }

  // 흑백·컬러 = 스캔처럼 보정(그림자·조명 얼룩 제거), 원본 = 원근만 바로잡은 사진 그대로
  function look(c) {
    return S.prefs.mode === 'orig' ? c : RSImaging.scan(c, S.prefs.mode === 'color' ? 'color' : 'gray');
  }

  function finalCanvas() {
    return RSImaging.rotate(look(S.warped), S.rot);
  }

  function drawPreview() {
    if (!S || S.step !== 'preview' || !S.warped) return;
    var stage = $('stage'), cv = $('prevCanvas');
    if (!stage || !cv) return;
    // 미리보기는 작은 크기로 만들어 빠르게 보여 줌
    var small = RSImaging.scaled(S.warped, 1200);
    var img = RSImaging.rotate(look(small), S.rot);
    var maxW = stage.clientWidth || (window.innerWidth - 32), maxH = Math.max(240, window.innerHeight * 0.5);
    var s = Math.min(maxW / img.width, maxH / img.height, 1.5), dpr = window.devicePixelRatio || 1;
    cv.style.width = Math.round(img.width * s) + 'px'; cv.style.height = Math.round(img.height * s) + 'px';
    cv.width = Math.round(img.width * s * dpr); cv.height = Math.round(img.height * s * dpr);
    var g = cv.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, cv.width, cv.height);
  }

  // ── 저장 ──
  async function save(done) {
    if (S.busy) return;
    var left = S.files.length - 1 - S.fileIndex;
    if (done && left > 0 && !confirm('갤러리에서 고른 사진 ' + left + '장이 남았습니다. 남은 사진은 저장하지 않고 끝낼까요?')) return;
    S.busy = '저장 중…'; S.error = ''; draw();
    try {
      var fin = finalCanvas();
      var blob = await RSImaging.jpeg(fin, 0.88);
      var thumb = await RSImaging.jpeg(RSImaging.scaled(fin, 320), 0.7);
      var now = new Date();
      var item = {
        id: uuid(), email: ctx.email, blob: blob, thumb: thumb,
        meta: {
          category: S.prefs.category, cardType: S.prefs.cardType, widthMm: S.prefs.widthMm, memo: S.memo.trim(),
          capturedAt: localIso(now), month: now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0'),
          mode: S.prefs.mode, width: fin.width, height: fin.height
        }
      };
      await RSQueue.add(item);
      S.saved++;
      ctx.onSaved();
    } catch (e) {
      S.busy = '';
      S.error = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))
        ? '저장 공간이 부족합니다. 업로드 대기 중인 사진을 먼저 올려 주세요(인터넷 연결 후 앱 열기).'
        : '저장하지 못했습니다. 다시 눌러 주세요. (' + (e && e.message || e) + ')';
      draw();
      return;
    }
    S.busy = '';
    discardCurrent();
    if (done) {
      var n = S.saved; S = null; ctx.onClose(n); return;
    }
    nextFileOrSelect();
  }

  window.RSCapture = {
    mount: mount,
    active: function () { return !!S; },
    reset: function () { S = null; }
  };
})();
