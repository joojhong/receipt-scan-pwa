/* 영수증 스캔 PWA — 개발 2단계: 뼈대 + 홈 껍데기
   - 하단 메뉴 3개(홈·보관함·예산), 해시 주소(#/home 등)로 화면 전환
   - 홈: 월 선택, 이번 달 사용 합계, 구분 카드 4개(합계만, 예산 칸은 비움)
   - 데이터는 아직 없음(다음 단계에서 IndexedDB·시트 연결). 지금은 빈 목록으로 합계 0원 */
(function () {
  'use strict';

  var APP_VERSION = '0.2.0';
  var CATEGORIES = ['경비', '접대비', '회의비', '출장비'];

  // ── 데이터 자리 (다음 단계에서 실제 저장소로 교체) ──
  var store = {
    receipts: [], // { category, amount, month:'YYYY-MM', status }
    listByMonth: function (ym) {
      return this.receipts.filter(function (r) { return r.month === ym; });
    }
  };

  // ── 월 상태 ──
  var now = new Date();
  var current = { y: now.getFullYear(), m: now.getMonth() + 1 };
  var view = { y: current.y, m: current.m };

  function ym(v) { return v.y + '-' + String(v.m).padStart(2, '0'); }
  function isCurrent(v) { return v.y === current.y && v.m === current.m; }
  function shift(v, d) {
    var m = v.m + d, y = v.y;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    return { y: y, m: m };
  }
  function won(n) { return Number(n || 0).toLocaleString('ko-KR'); }

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content;
  }

  var ICON = {
    prev: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>',
    camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5E626A" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
  };

  // ── 화면: 홈 ──
  function renderHome(root) {
    var list = store.listByMonth(ym(view));
    var total = 0, byCat = {}, pending = 0;
    CATEGORIES.forEach(function (c) { byCat[c] = 0; });
    list.forEach(function (r) {
      if (byCat[r.category] !== undefined) byCat[r.category] += Number(r.amount || 0);
      total += Number(r.amount || 0);
      if (r.status === 'pending') pending++;
    });

    var cards = CATEGORIES.map(function (c) {
      return '<a class="cat" href="#/box" data-cat="' + c + '">' +
        '<div class="name">' + c + '</div>' +
        '<div class="sum">' + won(byCat[c]) + '<small>원</small></div>' +
        '<div class="bar"></div>' +
        '<div class="budget">예산 —<br>잔액 —</div>' +
      '</a>';
    }).join('');

    root.appendChild(el(
      '<header class="topbar">' +
        '<div class="month">' +
          '<button class="icon-btn" id="prevMonth" aria-label="이전 달">' + ICON.prev + '</button>' +
          '<h1>' + view.y + '년 ' + view.m + '월</h1>' +
          '<button class="icon-btn" id="nextMonth" aria-label="다음 달"' + (isCurrent(view) ? ' disabled' : '') + '>' + ICON.next + '</button>' +
        '</div>' +
        '<div class="avatar" aria-hidden="true">재</div>' +
      '</header>' +
      '<section class="total" aria-label="이번 달 사용 합계">' +
        '<div class="label">' + (isCurrent(view) ? '이번 달' : view.m + '월') + ' 사용 합계</div>' +
        '<div class="amount"><b>' + won(total) + '</b><span>원</span></div>' +
        '<div class="track"><i style="width:0%"></i></div>' +
        '<div class="meta"><div>예산 —</div><div>잔액 —</div></div>' +
      '</section>' +
      '<div class="section-head"><h2>구분별 사용</h2>' +
        (pending ? '<div class="chip">' + ICON.clock + '판독 대기 ' + pending + '건</div>' : '') +
      '</div>' +
      '<div class="grid">' + cards + '</div>' +
      '<div class="cta-wrap"><button class="cta" id="capture">' + ICON.camera + '영수증 촬영</button></div>' +
      '<div class="version">v' + APP_VERSION + ' · 개발 2단계</div>'
    ));

    root.querySelector('#prevMonth').onclick = function () { view = shift(view, -1); render(); };
    root.querySelector('#nextMonth').onclick = function () {
      if (!isCurrent(view)) { view = shift(view, 1); render(); }
    };
    root.querySelector('#capture').onclick = function () { toast('촬영 기능은 다음 단계에서 연결됩니다'); };
  }

  // ── 화면: 보관함·예산 (자리만) ──
  function renderPlaceholder(root, title, msg) {
    root.appendChild(el(
      '<h1 class="page-title">' + title + '</h1>' +
      '<div class="empty"><b>준비 중</b>' + msg + '</div>'
    ));
  }

  var ROUTES = {
    home: renderHome,
    box: function (r) { renderPlaceholder(r, '보관함', '촬영한 영수증이 여기에 모입니다.<br>다음 단계에서 만듭니다.'); },
    budget: function (r) { renderPlaceholder(r, '예산', '구분별 예산·이월·추가 예산을 설정합니다.<br>다음 단계에서 만듭니다.'); }
  };

  function currentTab() {
    var t = (location.hash.replace(/^#\/?/, '') || 'home').split('?')[0];
    return ROUTES[t] ? t : 'home';
  }

  function render() {
    var tab = currentTab();
    var root = document.getElementById('view');
    root.innerHTML = '';
    ROUTES[tab](root);
    document.querySelectorAll('.tabbar a').forEach(function (a) {
      if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  var toastTimer;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  window.addEventListener('hashchange', render);
  render();

  // ── 오프라인 캐시(서비스 워커) ──
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) {
        console.warn('서비스 워커 등록 실패', e);
      });
    });
  }
})();
