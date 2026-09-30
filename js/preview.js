/* A4 미리보기(4단계 3번)
   - 보관함에서 체크한 영수증을 설계서 A4 배치 규칙(RSLayout)대로 놓아 페이지별로 보여 줌
   - 영수증 실제 크기 = 촬영 때 고른 폭(mm) × 사진 비율. 회전 값을 적용함
   - 파일명 규칙: YYMMDD_구분_영수증_이름.pdf (출장비 = 출장일, 그 외 = 청구월 말일)
   - PDF 저장·청구완료는 4번 작업에서 붙임 */
(function () {
  'use strict';

  var P = null;     // { key, items, pages, dims, status, error }
  var ctx = null;
  var imgs = {};    // id → objectURL(미리보기용으로 작게 만든 사진)
  var DIM_KEY = 'rs.dim.';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function won(n) { return Number(n || 0).toLocaleString('ko-KR'); }
  function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content; }
  var ICON = { back: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>' };

  // ── 파일명 ──
  function lastDay(ym) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7); return new Date(y, m, 0).getDate(); }
  function mostCommon(list) {
    var c = {}, best = '', n = 0;
    list.forEach(function (v) { if (!v) return; c[v] = (c[v] || 0) + 1; });
    Object.keys(c).sort().forEach(function (v) { if (c[v] >= n) { n = c[v]; best = v; } }); // 같으면 늦은 쪽
    return best;
  }
  function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 20); }
  function fileName(category, items, userName) {
    var who = safeName(userName) || '이름없음', date;
    if (category === '출장비') {
      var trips = items.map(function (it) { return it.tripDate; }).filter(Boolean).sort();
      date = trips[0] || (items.map(function (it) { return (it.txAt || it.capturedAt || '').slice(0, 10); }).sort()[0] || '');
      return (date ? date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10) : '000000') + '_출장_영수증_' + who + '.pdf';
    }
    var ym = mostCommon(items.map(function (it) { return it.month; }));
    date = ym ? ym.slice(2, 4) + ym.slice(5, 7) + String(lastDay(ym)).padStart(2, '0') : '000000';
    return date + '_' + category + '_영수증_' + who + '.pdf';
  }

  // ── 그리기 ──
  function render(root, c) {
    ctx = c;
    var sel = c.selection;
    if (!sel || !sel.ids.length) {
      root.appendChild(el('<div class="empty"><b>고른 영수증이 없습니다</b>보관함에서 영수증을 체크한 뒤 [A4 미리보기·PDF]를 눌러 주세요.</div>'));
      setTimeout(function () { ctx.back(); }, 1200);
      return;
    }
    var key = sel.category + '|' + sel.ids.join(',');
    if (!P || P.key !== key) start(sel, key);

    var items = P.items, sum = 0;
    items.forEach(function (it) { sum += it.amount || 0; });
    var name = fileName(sel.category, items, ctx.userName);
    var warns = [];
    if (sel.category === '출장비') {
      var trips = {}; items.forEach(function (it) { trips[it.tripDate || '없음'] = 1; });
      if (Object.keys(trips).length > 1) warns.push('출장일이 다른 영수증이 섞여 있습니다. 파일명에는 가장 이른 출장일을 씁니다.');
      if (trips['없음']) warns.push('출장일이 없는 영수증이 있습니다.');
    } else {
      var ms = {}; items.forEach(function (it) { ms[it.month] = 1; });
      if (Object.keys(ms).length > 1) warns.push('귀속 월이 다른 영수증이 섞여 있습니다(' + Object.keys(ms).sort().map(function (m) { return Number(m.slice(5)) + '월'; }).join('·') + '). 파일명에는 가장 많은 달을 씁니다.');
    }
    if (sel.leftOut) warns.push('판독 대기·확인 필요 ' + sel.leftOut + '건은 아직 값이 없어 PDF에 들어가지 않습니다.');

    var h = '<header class="dt-top"><button class="icon-btn" id="pvBack" aria-label="뒤로">' + ICON.back + '</button><h1>A4 미리보기</h1></header>' +
      '<div class="pv-sum"><b>' + esc(sel.category) + '</b> · ' + items.length + '건 · ' + won(sum) + '원' +
        (P.pages ? ' · <b>' + P.pages.length + '쪽</b>' : '') + '</div>' +
      '<div class="pv-name"><span>파일명</span><b>' + esc(name) + '</b></div>' +
      warns.map(function (w) { return '<div class="banner warn">' + esc(w) + '</div>'; }).join('') +
      (P.error ? '<div class="banner warn" role="alert">' + esc(P.error) + ' <button class="mini" id="pvRetry" type="button">다시 시도</button></div>' : '');

    if (!P.pages) {
      h += '<div class="empty"><b>배치를 계산하는 중…</b>' + esc(P.status || '') + '</div>';
    } else {
      h += P.pages.map(function (pg) {
        return '<div class="pv-pl">' + (pg.page + 1) + ' / ' + P.pages.length + '쪽' + (pg.scale < 0.999 ? ' · ' + Math.round(pg.scale * 100) + '%로 줄임' : '') + '</div>' +
          '<div class="pv-page">' + pg.boxes.map(function (b) {
            var st = 'left:' + (b.x / 210 * 100) + '%;top:' + (b.y / 297 * 100) + '%;width:' + (b.w / 210 * 100) + '%;height:' + (b.h / 297 * 100) + '%';
            return '<div class="pv-box" style="' + st + '" data-pv="' + esc(b.id) + '">' + (imgs[b.id] ? '<img src="' + imgs[b.id] + '" alt="">' : '') + '</div>';
          }).join('') + '</div>';
      }).join('');
      h += '<p class="hint">흰 종이 = A4 한 장(여백 10mm). 영수증은 실제 크기로 놓고, 넘치는 쪽만 조금 줄입니다(85%까지).</p>';
    }
    h += '<div class="dt-bar"><button class="btn-alt pv-alt" id="pvBack2" type="button">고르기로</button>' +
      '<button class="cta" id="pvSave" type="button"' + (P.pages ? '' : ' disabled') + '>PDF로 저장하고 청구완료</button></div><div class="bx-space"></div>';

    root.appendChild(el(h));
    var back = function () { ctx.back(); };
    root.querySelector('#pvBack').onclick = back;
    root.querySelector('#pvBack2').onclick = back;
    root.querySelector('#pvSave').onclick = function () { ctx.toast('PDF 저장·청구완료는 4단계 4번 작업에서 만듭니다'); };
    var rt = root.querySelector('#pvRetry');
    if (rt) rt.onclick = function () { P = null; ctx.rerender(); };
  }

  function start(sel, key) {
    P = { key: key, items: sel.items.slice(), pages: null, dims: {}, status: '', error: '' };
    prepare(P).catch(function (e) {
      if (P && P.key === key) { P.error = '배치를 계산하지 못했습니다 (' + (e.message || e) + ')'; redraw(); }
    });
  }

  function redraw() { if (ctx && ctx.isActive()) { var y = window.scrollY; ctx.rerender(); window.scrollTo(0, y); } }

  // 사진 크기를 알아낸 뒤 배치 → 사진 불러오기
  async function prepare(p) {
    var items = p.items, done = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      p.dims[it.id] = await dimsOf(it);
      done++;
      if (P !== p) return;
      p.status = '사진 크기 확인 ' + done + ' / ' + items.length;
      if (done % 3 === 0 || done === items.length) redraw();
    }
    var input = items.map(function (it) {
      var d = p.dims[it.id], odd = (it.rot || 0) % 2 === 1;
      var pw = odd ? d.h : d.w, ph = odd ? d.w : d.h;
      var wmm = Number(it.widthMm) || 80;
      return { id: it.id, realW: wmm, realH: wmm * ph / pw, date: it.txAt || it.capturedAt || '' };
    });
    p.pages = RSLayout.layout(input);
    redraw();
    // 사진은 두 장씩 차례로 불러와 끼워 넣음
    var queue = p.pages.reduce(function (a, pg) { return a.concat(pg.boxes.map(function (b) { return b.id; })); }, []);
    var byId = {}; items.forEach(function (it) { byId[it.id] = it; });
    var worker = async function () {
      while (queue.length && P === p) {
        var id = queue.shift();
        if (imgs[id]) { place(id); continue; }
        try { imgs[id] = await smallImage(byId[id], 900); place(id); } catch (e) { /* 사진 없이 자리만 보임 */ }
      }
    };
    await Promise.all([worker(), worker()]);
  }

  function place(id) {
    var box = document.querySelector('.pv-box[data-pv="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (box && imgs[id]) box.innerHTML = '<img src="' + imgs[id] + '" alt="">';
  }

  async function dimsOf(it) {
    try { var c = JSON.parse(localStorage.getItem(DIM_KEY + it.id) || 'null'); if (c && c.w > 0 && c.h > 0) return c; } catch (e) { /* 무시 */ }
    var d = null;
    if (it.fileId) { try { d = await ctx.imageSize(it.fileId); } catch (e) { d = null; } }
    if (!d) { var img = await decode(await ctx.photoBlob(it)); d = { w: img.naturalWidth, h: img.naturalHeight }; }
    try { localStorage.setItem(DIM_KEY + it.id, JSON.stringify(d)); } catch (e) { /* 무시 */ }
    return d;
  }

  function decode(blob) {
    return new Promise(function (res, rej) {
      var u = URL.createObjectURL(blob), im = new Image();
      im.onload = function () { URL.revokeObjectURL(u); res(im); };
      im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('사진을 열 수 없습니다')); };
      im.src = u;
    });
  }

  async function smallImage(it, max) {
    var img = await decode(await ctx.photoBlob(it));
    var s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    var c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    c = RSImaging.rotate(c, it.rot || 0);
    var b = await new Promise(function (res) { c.toBlob(res, 'image/jpeg', 0.8); });
    return URL.createObjectURL(b);
  }

  window.RSPreview = {
    render: render,
    fileName: fileName,
    reset: function () { P = null; Object.keys(imgs).forEach(function (k) { URL.revokeObjectURL(imgs[k]); }); imgs = {}; }
  };
})();
