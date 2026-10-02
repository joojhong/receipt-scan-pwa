/* 갑지(사용내역서) 그리기
   - 경비 = "월간경비 사용 내역서", 접대비·회의비 = "○○비 개인청구(법인카드) 사용내역서" (회사 양식 PDF를 보고 옮김)
   - A4 한 장을 캔버스에 그려 PDF에 사진처럼 넣음(글꼴은 폰에 있는 기본 글꼴)
   - 줄이 많으면 여러 장으로 나눔. 합계는 마지막 장에만
   - 머리글 값(사번·팀명 등)은 시트 '설정' 탭(내 정보) */
(function () {
  'use strict';

  var CAR_ACCOUNTS = ['8220001-주유비(회사차량)', '8220002-차량유지관리비(회사 차량)', '8220003-주차/통행료'];
  var FUEL_ACCOUNT = '8220001-주유비(회사차량)';
  var OWN_CAR_ACCOUNT = '8120001-자차운행비(별도서류첨부)';
  var PARKING_ACCOUNT = '8220003-주차/통행료';
  var FONT = '"Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif';

  function won(n) { return Number(n || 0).toLocaleString('ko-KR'); }
  function p2(n) { return String(n).padStart(2, '0'); }
  function dateOf(it) { return String(it.txAt || it.capturedAt || '').slice(0, 10); }

  // 사용구분: 법인카드면 법인카드, 그 밖(개인카드·빈칸)은 개인청구
  function useType(it) { return it.cardType === '법인카드' ? '법인카드' : '개인청구'; }

  // 회사 차량 번호(갑지·상세 기본값): "183허5450(주재홍)"
  function companyCar(info) {
    info = info || {};
    if (!info['차량번호'] || info['회사 차량'] === '아니오') return '';
    return info['차량번호'] + (info['사원명'] ? '(' + info['사원명'] + ')' : '');
  }

  // ── 표 정의 ──
  function cols(kind) {
    if (kind === '경비') return [
      { t: '날짜', w: 20 }, { t: '계정', w: 25 }, { t: '업무내용', w: 36 }, { t: '금액', w: 16, r: 1 }, { t: '출발지', w: 16 }, { t: '도착지', w: 16 },
      { t: '교통수단', w: 14 }, { t: '운행시간', w: 14 }, { t: '이동거리', w: 14, r: 1 }, { t: '차량번호', w: 19 }];
    return [
      { t: 'No', w: 8 }, { t: '월', w: 8 }, { t: '일', w: 8 }, { t: '내용', w: 46, l: 1 }, { t: '금액', w: 16, r: 1 },
      { t: kind === '접대비' ? '접대상대방' : '회의참석자', w: 38, l: 1 }, { t: kind === '접대비' ? '접대자' : '신청자', w: 14 },
      { t: '사용구분', w: 15 }, { t: '상태', w: 9 }, { t: '결재완료일', w: 28 }];
  }

  function rowsOf(kind, items, info) {
    var list = items.slice().sort(function (a, b) { return dateOf(a) < dateOf(b) ? -1 : dateOf(a) > dateOf(b) ? 1 : 0; });
    var me = info['사원명'] || '';
    return list.map(function (it, i) {
      var d = dateOf(it);
      if (kind === '경비') {
        var acc = it.account || '', car = '';
        if (CAR_ACCOUNTS.indexOf(acc) >= 0 && info['회사 차량'] !== '아니오') {
          if (acc === PARKING_ACCOUNT && !it.car) car = '';                          // 주차/통행료는 차량 선택 사항
          else car = !it.car || it.car === info['차량번호'] ? companyCar(info) || it.car : it.car;
        } // 번호만 적혀 있으면 "번호(사원명)"으로
        return [d, acc.replace(/^\d+-/, ''), acc === FUEL_ACCOUNT ? (it.fuel || '') : (it.work || ''), won(it.amount),
          it.from || '', it.to || '', it.transport || '', it.driveTime || '',
          acc === OWN_CAR_ACCOUNT && it.km !== '' && it.km != null ? it.km + ' km' : '', car];
      }
      return [String(i + 1), d.slice(5, 7), d.slice(8, 10), it.topic || '', won(it.amount),
        kind === '접대비' ? (it.guest || '') : (it.attendees || ''), me, useType(it), '', ''];
    });
  }

  function titleOf(kind, use) { return kind === '경비' ? '월간경비 사용 내역서' : kind + ' ' + use + ' 사용내역서'; }

  // ── 그리기 ──
  // month = 'YYYY-MM'(청구월), dpi = 해상도. 결과 = 캔버스 배열(한 장씩)
  function draw(kind, items, info, month, dpi) {
    info = info || {};
    var k = dpi / 25.4, W = Math.round(210 * k), H = Math.round(297 * k);
    var use = items.length ? useType(items[0]) : '개인청구';
    var C = cols(kind), rows = rowsOf(kind, items, info);
    var total = items.reduce(function (a, it) { return a + (Number(it.amount) || 0); }, 0);
    var g1 = kind === '경비';
    var top = g1 ? 48 : 80, rowH = g1 ? 5 : 6.6, headH = g1 ? 6 : 6.6, bottom = 285;
    var perPage = Math.max(1, Math.floor((bottom - top - headH - rowH) / rowH));
    var pages = [], n = Math.max(1, Math.ceil(rows.length / perPage));
    var y = month ? month.slice(0, 4) : '', m = month ? month.slice(5, 7) : '';
    for (var pi = 0; pi < n; pi++) {
      var c = document.createElement('canvas'); c.width = W; c.height = H;
      var g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#000'; g.strokeStyle = '#000'; g.textBaseline = 'middle';
      var font = function (mm, bold) { g.font = (bold ? '700 ' : '') + (mm * k) + 'px ' + FONT; };
      var text = function (s, x, yy, align) { g.textAlign = align || 'left'; g.fillText(s, x * k, yy * k); };
      var square = function (x, yy, s) { g.fillRect(x * k, (yy - s / 2) * k, s * k, s * k); };
      if (g1) {
        font(3.6); square(11, 23.5, 3); text(titleOf(kind, use), 16, 23.5);
        font(3.3);
        text('사번' + (info['사번'] || ''), 10, 37);
        text('팀명 :' + (info['팀명'] || ''), 48, 37);
        text('사원명 :' + (info['사원명'] || ''), 84, 37);
        text('청구월 : ' + (y ? y + '년' + m + '월' : ''), 124, 37);
        text('승인자:' + (info['승인자'] || ''), 200, 37, 'right');
      } else {
        font(5.6); text(titleOf(kind, use), 105, 24, 'center');
        font(3.3);
        text(y ? y + '년 ' + m + '월' : '', 7, 42);
        text([info['회사명'] || '', info['팀명'] || '', '사번 : ' + (info['사번'] || ''), '사원명 : ' + (info['사원명'] || '')].join('     '), 203, 42, 'right');
        font(3.3); square(7, 59, 2.8); text(use + ' 승인내역', 11.5, 59);
      }
      // 표
      var x0 = g1 ? 7 : 7, widths = C.map(function (cc) { return cc.w * (196 / 190); });
      var xs = [x0]; widths.forEach(function (w, i) { xs.push(xs[i] + w); });
      g.lineWidth = Math.max(1, 0.2 * k);
      var cell = function (s, ci, yy, h, opt) {
        opt = opt || {};
        var x = xs[ci], w = widths[ci];
        if (opt.fill) { g.fillStyle = opt.fill; g.fillRect(x * k, yy * k, w * k, h * k); g.fillStyle = '#000'; }
        g.strokeRect(x * k, yy * k, w * k, h * k);
        if (!s) return;
        var size = opt.size, pad = 0.8;
        font(size);
        while (g.measureText(s).width > (w - pad * 2) * k && size > opt.size * 0.62) { size -= 0.1; font(size); }
        var str = s;
        if (g.measureText(str).width > (w - pad * 2) * k) {
          while (str.length > 1 && g.measureText(str + '…').width > (w - pad * 2) * k) str = str.slice(0, -1);
          str += '…';
        }
        var al = opt.align || 'center';
        text(str, al === 'left' ? x + pad : al === 'right' ? x + w - pad : x + w / 2, yy + h / 2 + 0.15, al);
      };
      var yy = top;
      C.forEach(function (cc, ci) { cell(cc.t, ci, yy, headH, { size: g1 ? 3.4 : 2.7, fill: g1 ? null : '#C9C9C9' }); });
      yy += headH;
      var part = rows.slice(pi * perPage, (pi + 1) * perPage);
      part.forEach(function (r) {
        C.forEach(function (cc, ci) {
          cell(r[ci], ci, yy, rowH, { size: g1 ? 2.5 : 2.7, align: cc.r ? 'right' : cc.l ? 'left' : 'center' });
        });
        yy += rowH;
      });
      if (pi === n - 1) {
        if (g1) {
          cell('합계', 1, yy, rowH + 1.5, { size: 3.4 });
          var x = xs[2], w = widths[2] + widths[3];
          g.strokeRect(x * k, yy * k, w * k, (rowH + 1.5) * k);
          font(3.4); text(won(total), x + w - 0.8, yy + (rowH + 1.5) / 2 + 0.15, 'right');
        } else {
          C.forEach(function (cc, ci) { cell(ci === 3 ? '합계' : ci === 4 ? won(total) : '', ci, yy, rowH, { size: 2.7, align: ci === 4 ? 'right' : 'left' }); });
        }
      }
      if (n > 1) { font(2.6); text((pi + 1) + ' / ' + n, 105, 291, 'center'); }
      pages.push(c);
    }
    return pages;
  }

  window.RSGapji = {
    draw: draw, useType: useType, companyCar: companyCar,
    CAR_ACCOUNTS: CAR_ACCOUNTS, OWN_CAR_ACCOUNT: OWN_CAR_ACCOUNT,
    KINDS: ['경비', '접대비', '회의비']
  };
})();
