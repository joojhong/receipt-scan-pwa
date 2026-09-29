/* 영수증 스캔 PWA — 개발 2단계: 뼈대 + 홈 껍데기 + Google 로그인
   - 하단 메뉴 3개(홈·보관함·예산), 해시 주소(#/home 등)로 화면 전환
   - 로그인하면 Drive에 "영수증 스캔" 폴더와 "영수증 장부" 시트를 자동으로 만들고,
     홈 합계는 시트의 영수증 탭(귀속 월, 금액, 구분)을 읽어 계산
   - 예산 칸은 아직 비움(예산 단계에서 채움) */
(function () {
  'use strict';

  var APP_VERSION = '0.3.0';
  var CATEGORIES = ['경비', '접대비', '회의비', '출장비'];
  var CACHE_KEY = 'rs.cache.receipts';

  // ── 상태 ──
  var state = {
    user: RSAuth.user(),   // { email } 또는 null
    ws: null,              // 폴더·시트 ID
    receipts: loadCache(), // 시트에서 읽은 영수증 목록
    loading: false,
    step: '',              // 준비 중 안내 문구
    error: '',
    offline: false
  };

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveCache(list) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(list)); } catch (e) { /* 무시 */ }
  }

  // ── 월 ──
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
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content;
  }

  var ICON = {
    prev: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>',
    camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5E626A" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    google: '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.5 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.8 6C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.8-6z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.2-13.5-10l-7.8 6C6.6 42.6 14.6 48 24 48z"/></svg>'
  };

  // ── 화면: 로그인 전 ──
  function renderLogin(root) {
    root.appendChild(el(
      '<section class="welcome">' +
        '<img src="icons/icon-192.png" alt="" width="72" height="72">' +
        '<h1>영수증 스캔</h1>' +
        '<p>영수증을 찍어 구분별로 모으고<br>A4 청구본 PDF로 만듭니다.</p>' +
        '<button class="google-btn" id="loginBtn" type="button">' + ICON.google + 'Google로 로그인</button>' +
        (state.error ? '<p class="err" role="alert">' + esc(state.error) + '</p>' : '') +
        '<ul class="notes">' +
          '<li>사진과 장부는 <b>내 Google Drive</b>의 "영수증 스캔" 폴더에 저장됩니다.</li>' +
          '<li>앱은 자기가 만든 파일만 볼 수 있고, 다른 Drive 파일은 보지 않습니다.</li>' +
        '</ul>' +
        '<a class="policy" href="privacy.html">개인정보 처리방침</a>' +
      '</section>'
    ));
    root.querySelector('#loginBtn').onclick = onLogin;
  }

  async function onLogin(ev) {
    var btn = ev.currentTarget;
    btn.disabled = true;
    state.error = '';
    try {
      var u = await RSAuth.login();
      state.user = u;
      render();
      await refresh();
    } catch (e) {
      state.error = e.message || '로그인하지 못했습니다';
      render();
    }
  }

  // ── 화면: 홈 ──
  function renderHome(root) {
    if (!state.user) return renderLogin(root);
    var month = ym(view);
    var total = 0, byCat = {}, pending = 0;
    CATEGORIES.forEach(function (c) { byCat[c] = 0; });
    state.receipts.forEach(function (r) {
      if (r.month !== month || r.status === '제외') return;
      if (byCat[r.category] !== undefined) byCat[r.category] += r.amount;
      total += r.amount;
      if (r.status === '판독대기') pending++;
    });

    var cards = CATEGORIES.map(function (c) {
      return '<a class="cat" href="#/box" data-cat="' + c + '">' +
        '<div class="name">' + c + '</div>' +
        '<div class="sum">' + won(byCat[c]) + '<small>원</small></div>' +
        '<div class="bar"></div>' +
        '<div class="budget">예산 —<br>잔액 —</div>' +
      '</a>';
    }).join('');

    var banner = '';
    if (state.step) banner = '<div class="banner">' + esc(state.step) + '</div>';
    else if (state.error) banner = '<div class="banner warn" role="alert">' + esc(state.error) + '</div>';
    else if (state.offline) banner = '<div class="banner">오프라인입니다. 마지막으로 불러온 합계를 보여 줍니다.</div>';

    root.appendChild(el(
      '<header class="topbar">' +
        '<div class="month">' +
          '<button class="icon-btn" id="prevMonth" aria-label="이전 달">' + ICON.prev + '</button>' +
          '<h1>' + view.y + '년 ' + view.m + '월</h1>' +
          '<button class="icon-btn" id="nextMonth" aria-label="다음 달"' + (isCurrent(view) ? ' disabled' : '') + '>' + ICON.next + '</button>' +
        '</div>' +
        '<button class="avatar" id="avatar" aria-label="계정 메뉴">' + esc(state.user.email.charAt(0).toUpperCase()) + '</button>' +
      '</header>' +
      banner +
      '<section class="total" aria-label="이번 달 사용 합계">' +
        '<div class="label">' + (isCurrent(view) ? '이번 달' : view.m + '월') + ' 사용 합계' + (state.loading ? ' · 불러오는 중' : '') + '</div>' +
        '<div class="amount"><b>' + won(total) + '</b><span>원</span></div>' +
        '<div class="track"><i style="width:0%"></i></div>' +
        '<div class="meta"><div>예산 —</div><div>잔액 —</div></div>' +
      '</section>' +
      '<div class="section-head"><h2>구분별 사용</h2>' +
        (pending ? '<div class="chip">' + ICON.clock + '판독 대기 ' + pending + '건</div>' : '') +
      '</div>' +
      '<div class="grid">' + cards + '</div>' +
      '<div class="cta-wrap"><button class="cta" id="capture">' + ICON.camera + '영수증 촬영</button></div>' +
      '<div class="version">v' + APP_VERSION + '</div>'
    ));

    root.querySelector('#prevMonth').onclick = function () { view = shift(view, -1); render(); };
    root.querySelector('#nextMonth').onclick = function () {
      if (!isCurrent(view)) { view = shift(view, 1); render(); }
    };
    root.querySelector('#capture').onclick = function () { toast('촬영 기능은 다음 단계에서 연결됩니다'); };
    root.querySelector('#avatar').onclick = openAccountSheet;
  }

  // ── 계정 메뉴 ──
  function openAccountSheet() {
    var ws = state.ws || RSStore.workspace(state.user.email);
    var wrap = document.createElement('div');
    wrap.className = 'sheet-backdrop';
    wrap.innerHTML =
      '<div class="sheet" role="dialog" aria-label="계정">' +
        '<div class="grab"></div>' +
        '<div class="sheet-email">' + esc(state.user.email) + '</div>' +
        (ws ? '<a class="sheet-item" href="' + RSStore.sheetUrl(ws) + '" target="_blank" rel="noopener">영수증 장부(시트) 열기</a>' +
              '<a class="sheet-item" href="' + RSStore.folderUrl(ws) + '" target="_blank" rel="noopener">Drive 폴더 열기</a>' : '') +
        '<button class="sheet-item" id="reloadBtn" type="button">새로고침</button>' +
        '<button class="sheet-item danger" id="logoutBtn" type="button">로그아웃</button>' +
        '<a class="sheet-item sub" href="privacy.html">개인정보 처리방침</a>' +
      '</div>';
    wrap.onclick = function (e) { if (e.target === wrap) wrap.remove(); };
    document.body.appendChild(wrap);
    wrap.querySelector('#reloadBtn').onclick = function () { wrap.remove(); refresh(); };
    wrap.querySelector('#logoutBtn').onclick = async function () {
      wrap.remove();
      await RSAuth.logout();
      state.user = null; state.ws = null; state.receipts = []; state.error = '';
      saveCache([]);
      render();
    };
  }

  // ── 시트에서 다시 읽기 ──
  async function refresh() {
    if (!state.user || state.loading) return;
    state.loading = true; state.error = ''; render();
    try {
      state.ws = await RSStore.ensureWorkspace(state.user.email, function (msg) { state.step = msg; render(); });
      state.step = '';
      state.receipts = await RSStore.readReceipts(state.ws);
      state.offline = false;
      saveCache(state.receipts);
    } catch (e) {
      state.step = '';
      if (e.needLogin) {
        state.user = null;
        state.error = e.message;
      } else if (!navigator.onLine || e instanceof TypeError) {
        state.offline = true;
      } else {
        state.error = '시트를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요. (' + (e.message || '오류') + ')';
        console.warn(e, e.detail);
      }
    } finally {
      state.loading = false;
      render();
    }
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
    var tab = state.user ? currentTab() : 'home';
    var root = document.getElementById('view');
    root.innerHTML = '';
    ROUTES[tab](root);
    var nav = document.querySelector('.tabbar');
    nav.hidden = !state.user;
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
  // 앱으로 돌아올 때 시트를 다시 읽음(설계서 동기화 규칙: 앱을 열 때, 돌아올 때)
  var lastRefresh = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && Date.now() - lastRefresh > 30000) { lastRefresh = Date.now(); refresh(); }
  });
  window.addEventListener('online', function () { refresh(); });

  render();
  if (state.user) { lastRefresh = Date.now(); refresh(); }

  // ── 오프라인 캐시(서비스 워커) ──
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) {
        console.warn('서비스 워커 등록 실패', e);
      });
    });
  }
})();
