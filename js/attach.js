/* 파일 첨부(4단계 5번) = 영수증을 손으로 1건 등록
   - AI 판독이 안 되는 영수증 묶음(통신비 내역서, 한 달 치 하이패스 내역 등)을 PDF로 올리고 거래일·금액·결제 수단·내역을 직접 적음
   - 청구 PDF에는 찍은 영수증 쪽 뒤에 올린 PDF가 그대로 붙고, 갑지에는 1줄로 들어감
   - 순서: 구분 → PDF → 거래일·금액·결제 수단 → 내역 → 저장 → 상세에서 인트라넷 칸(계정 등) 채움 */
(function () {
  'use strict';

  var CATEGORIES = ['경비', '접대비', '회의비', '출장비'];
  var PAYS = ['개인카드', '법인카드', '현금'];
  var MAX = 10 * 1024 * 1024;
  var A = null, ctx = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function won(n) { return Number(n || 0).toLocaleString('ko-KR'); }
  function p2(n) { return String(n).padStart(2, '0'); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content; }
  var BACK = '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>';

  function field(label, input, req, hint) {
    return '<div class="dt-f"><span class="dt-l">' + label + (req ? ' <em>필수</em>' : '') + '</span>' + input +
      (hint ? '<span class="dt-hint">' + esc(hint) + '</span>' : '') + '</div>';
  }
  function seg(key, list, cur) {
    return '<div class="dt-seg">' + list.map(function (x) {
      var v = Array.isArray(x) ? x[0] : x, t = Array.isArray(x) ? x[1] : x;
      return '<button type="button" data-a="' + key + '" data-v="' + esc(v) + '"' + (cur === v ? ' class="on"' : '') + '>' + esc(t) + '</button>';
    }).join('') + '</div>';
  }

  function render(root, c) {
    ctx = c;
    if (!A) A = { category: CATEGORIES.indexOf(c.category) >= 0 ? c.category : '경비', file: null, date: today(),
      amount: '', pay: '개인카드', corpCard: '', desc: '', busy: '', error: '' };
    var trip = A.category === '출장비';
    var h = '<header class="dt-top"><button class="icon-btn" id="atBack" aria-label="뒤로">' + BACK + '</button><h1>파일 첨부</h1></header>' +
      '<p class="hint" style="margin-top:0">AI가 읽기 어려운 영수증(통신비 내역서, 한 달 치 하이패스 내역 등)을 PDF로 올리고 금액을 직접 적어 1건으로 등록합니다.</p>';
    if (A.error) h += '<div class="banner warn" role="alert">' + esc(A.error) + '</div>';
    h += '<section class="dt-sec"><div class="dt-sec-h">무엇을 올리나요</div><div class="dt-sec-b">' +
      field('구분', seg('category', CATEGORIES, A.category), true) +
      field('PDF 파일', '<label class="at-file"><input type="file" id="atFile" accept="application/pdf,.pdf" hidden>' +
        '<span>' + (A.file ? esc(A.file.name) + ' · ' + (A.file.size / 1048576).toFixed(1) + 'MB' : 'PDF 고르기') + '</span></label>', true) +
      '</div></section>';
    h += '<section class="dt-sec"><div class="dt-sec-h">결제</div><div class="dt-sec-b">' +
      '<div class="dt-2">' + field(trip ? '출장일' : '거래일', '<input type="date" data-a="date" max="' + today() + '" value="' + esc(A.date) + '">', true,
        trip ? '같은 출장일의 영수증과 묶입니다' : '') +
      field('금액', '<div class="dt-won"><input type="text" inputmode="numeric" data-a="amount" value="' + esc(A.amount ? won(A.amount) : '') + '" placeholder="0"><span>원</span></div>', true) + '</div>' +
      field('결제 수단', seg('pay', PAYS, A.pay), false) +
      (A.pay === '법인카드' ? field('법인카드', '<select data-a="corpCard"><option value="">선택</option>' + RSAuth.corpCards().map(function (cc) {
        return '<option' + (A.corpCard === cc ? ' selected' : '') + '>' + esc(cc) + '</option>';
      }).join('') + '</select>', A.category === '접대비' || A.category === '회의비') : '') +
      field('내역', '<input type="text" data-a="desc" maxlength="100" placeholder="예: 9월 통신비, 9월 하이패스" value="' + esc(A.desc) + '">', true,
        '보관함 목록에 이 이름으로 보입니다. 계정·내용 같은 인트라넷 칸은 저장한 뒤 상세 화면에서 채웁니다') +
      '</div></section>';
    var ok = validate() === '';
    h += '<div class="dt-bar"><button class="cta" id="atSave" type="button"' + (ok && !A.busy && navigator.onLine ? '' : ' disabled') + '>' +
      (A.busy ? esc(A.busy) : '저장하고 상세 보기') + '</button></div><div class="bx-space"></div>';
    if (!navigator.onLine) h = h.replace('<div class="dt-bar">', '<div class="banner">온라인에서만 올릴 수 있습니다.</div><div class="dt-bar">');
    root.appendChild(el(h));
    bind(root);
  }

  function validate() {
    if (!A.file) return 'PDF 파일을 골라 주세요';
    if (!A.date) return '날짜를 적어 주세요';
    if (!(Number(A.amount) > 0)) return '금액을 적어 주세요';
    if (!A.desc.trim()) return '내역을 적어 주세요';
    if (A.pay === '법인카드' && (A.category === '접대비' || A.category === '회의비') && !A.corpCard) return '법인카드를 골라 주세요';
    return '';
  }

  function redraw() { var y = window.scrollY; ctx.rerender(); window.scrollTo(0, y); }
  function refreshBtn(root) {
    var b = root.querySelector('#atSave');
    if (b) b.disabled = !(validate() === '' && !A.busy && navigator.onLine);
  }

  function bind(root) {
    root.querySelector('#atBack').onclick = function () { A = null; ctx.back(); };
    root.querySelectorAll('button[data-a]').forEach(function (b) {
      b.onclick = function () {
        var k = b.dataset.a; A[k] = b.dataset.v;
        if (k === 'pay' && A.pay !== '법인카드') A.corpCard = '';
        redraw();
      };
    });
    root.querySelectorAll('input[data-a], select[data-a]').forEach(function (i) {
      var k = i.dataset.a;
      i.oninput = i.onchange = function () {
        if (k === 'amount') {
          var d = i.value.replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '');
          A.amount = d; var f = d ? won(d) : ''; if (i.value !== f) i.value = f;
        } else A[k] = i.value;
        refreshBtn(root);
      };
    });
    var f = root.querySelector('#atFile');
    f.onchange = function () {
      var file = f.files && f.files[0];
      if (!file) return;
      if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { ctx.toast('PDF 파일만 올릴 수 있습니다'); return; }
      if (file.size > MAX) { ctx.toast('10MB가 넘는 파일은 올릴 수 없습니다 (인트라넷 첨부 한도)'); return; }
      A.file = file;
      if (!A.desc) A.desc = file.name.replace(/\.pdf$/i, '').slice(0, 100);
      redraw();
    };
    var s = root.querySelector('#atSave');
    s.onclick = save;
  }

  async function save() {
    var msg = validate();
    if (msg) { ctx.toast(msg); return; }
    A.busy = 'Drive에 올리는 중…'; A.error = ''; redraw();
    try {
      var id = await ctx.saveAttachment({
        category: A.category, file: A.file, txDate: A.date,
        amount: A.amount === '' ? '' : Number(A.amount), cardType: A.pay, corpCard: A.pay === '법인카드' ? A.corpCard : '',
        desc: A.desc.trim()
      }, function (m) { A.busy = m; redraw(); });
      A = null;
      ctx.done(id);
    } catch (e) {
      A.busy = ''; A.error = '올리지 못했습니다. ' + (e.message || e); redraw();
    }
  }

  window.RSAttach = { render: render, reset: function () { A = null; } };
})();
