/* A4 배치(설계서 "A4 배치 규칙" 의사코드를 그대로 옮김)
   - 거래일시 순(없으면 촬영일시), 행 우선(한 줄에 두 장), 전폭 영수증은 페이지 맨 아래에 모음
   - 넘치는 페이지만 축소: 페이지 축소 하한 85%, 폭 축소 × 페이지 축소의 절대 하한 75%
   - 단위 mm, 원점 = 페이지 왼쪽 위 */
(function () {
  'use strict';

  var PAGE_W = 210, PAGE_H = 297;
  var MARGIN = 10, GAP = 6, MIN_SCALE = 0.85, ABS_MIN = 0.75;
  var AREA_W = PAGE_W - 2 * MARGIN;      // 190
  var AREA_H = PAGE_H - 2 * MARGIN;      // 277
  var COL_W = (AREA_W - GAP) / 2;        // 92

  // items: [{ id, realW(mm), realH(mm), date }]  (date = 거래일시 또는 촬영일시)
  function layout(items) {
    // 1) 크기 정리
    var list = items.map(function (src) {
      var w = src.realW, h = src.realH, ws = 1, span;
      if (w <= COL_W) span = 1;
      else if (COL_W / w >= MIN_SCALE) { span = 1; ws = COL_W / w; }   // 약간 넓으면 반폭 칸에 맞춰 폭 축소
      else { span = 2; ws = Math.min(1, AREA_W / w); }                // 전폭 칸
      w *= ws; h *= ws;
      var ls = Math.min(1, AREA_H / h);                                // 긴 영수증 축소(절대 하한에서 제외)
      return { id: src.id, date: src.date || '', w: w * ls, h: h * ls, span: span, ws: ws };
    });

    // 2) 배치 순서: 거래일시 오름차순(같으면 원래 순서)
    list = list.map(function (it, i) { it._i = i; return it; }).sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : a._i - b._i;
    });

    // 3) 배치(행 우선): 마지막 페이지의 마지막 줄에만 넣고, 안 되면 새 줄 → 새 페이지
    var pages = [];
    list.forEach(function (it) {
      var pos = pages.length ? fit(pages[pages.length - 1], it) : null;
      if (!pos) {
        pages.push({ rows: [], bandH: 0, placed: [] });
        pos = fit(pages[pages.length - 1], it);
        if (!pos) pos = forceNew(pages[pages.length - 1], it); // 빈 페이지에도 안 맞는 경우(이론상 없음) 대비
      }
      put(pages[pages.length - 1], it, pos);
    });

    // 4) 출력 좌표
    return pages.map(function (page, n) {
      var s = Math.min(1, AREA_H / usedHeight(rowsBottom(page.rows), page.bandH)); // 277을 넘은 페이지만 축소
      var bandTop = top(rowsBottom(page.rows));
      return {
        page: n, scale: s,
        boxes: page.placed.map(function (p) {
          var boxX, boxW, y0;
          if (p.pos.kind === 'cell') { boxX = MARGIN + p.pos.col * (COL_W + GAP); boxW = COL_W; y0 = p.pos.row.y; }
          else { boxX = MARGIN; boxW = AREA_W; y0 = bandTop + p.pos.y; }
          var w = p.it.w * s, h = p.it.h * s;
          return { id: p.it.id, x: boxX + (boxW - w) / 2, y: MARGIN + y0 * s, w: w, h: h, scale: p.it.ws * s };
        })
      };
    });
  }

  function top(y) { return y > 0 ? y + GAP : 0; }
  function rowsBottom(rows) { return rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h : 0; }
  function usedHeight(rowsB, bandH) { return bandH === 0 ? rowsB : top(rowsB) + bandH; }

  function pageOK(page, it, newUsed) {
    var s = Math.min(1, AREA_H / newUsed);
    if (s < MIN_SCALE) return false;
    var minWs = it.ws;
    page.placed.forEach(function (p) { if (p.it.ws < minWs) minWs = p.it.ws; });
    return minWs * s >= ABS_MIN;
  }

  function fit(page, it) {
    if (it.span === 1) {
      if (page.bandH > 0) return null;                   // 전폭 뒤에는 반폭 칸 영수증을 넣지 않음
      var last = page.rows[page.rows.length - 1];
      if (last && last.n === 1) {                        // 지금 줄의 오른쪽 칸
        var newB = last.y + Math.max(last.h, it.h);
        if (pageOK(page, it, usedHeight(newB, 0))) return { kind: 'cell', row: last, col: 1 };
      }
      var y = top(rowsBottom(page.rows));                // 새 줄의 왼쪽 칸
      if (pageOK(page, it, usedHeight(y + it.h, 0))) return { kind: 'cell', row: 'new', y: y, col: 0 };
      return null;
    }
    var yb = top(page.bandH);                            // 페이지 맨 아래 띠 안에서의 위치
    if (pageOK(page, it, usedHeight(rowsBottom(page.rows), yb + it.h))) return { kind: 'band', y: yb };
    return null;
  }

  function forceNew(page, it) {
    return it.span === 1 ? { kind: 'cell', row: 'new', y: 0, col: 0 } : { kind: 'band', y: 0 };
  }

  function put(page, it, pos) {
    page.placed.push({ it: it, pos: pos });
    if (pos.kind === 'band') page.bandH = pos.y + it.h;
    else if (pos.row === 'new') { var r = { y: pos.y, h: it.h, n: 1 }; page.rows.push(r); pos.row = r; }
    else { pos.row.h = Math.max(pos.row.h, it.h); pos.row.n = 2; }
  }

  window.RSLayout = { layout: layout, PAGE_W: PAGE_W, PAGE_H: PAGE_H };
})();
