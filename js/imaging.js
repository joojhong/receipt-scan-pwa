/* 사진 처리: 열기(방향 보정 포함) · 원근 보정(모서리 4점) · 대비 보정(흑백/컬러) · 회전 · JPEG 만들기
   - OpenCV 없이 직접 계산(실기기에서 OpenCV.js가 1분 넘게 멈춰서 쓰지 않기로 함)
   - iPhone은 캔버스 크기 제한(약 1,670만 픽셀)이 있어 작업용 사진은 긴 변 3000px로 줄여서 씀 */
(function () {
  'use strict';

  var WORK_MAX = 3000;      // 작업용 사진 긴 변
  var OUT_MAX = 3000;       // 보정 결과 긴 변
  var OUT_PIXELS = 6e6;     // 보정 결과 최대 픽셀 수

  function canvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    return c;
  }

  // 파일 → 작업용 캔버스. createImageBitmap이 안 되면 <img>로 한 번 더 시도(HEIC 등)
  async function open(file) {
    var src = null, w, h, closeFn = null;
    try {
      src = await createImageBitmap(file);
      w = src.width; h = src.height; closeFn = function () { src.close && src.close(); };
    } catch (e) {
      src = await new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file), img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
        img.src = url;
        closeFn = function () { URL.revokeObjectURL(url); };
      });
      w = src.naturalWidth; h = src.naturalHeight;
    }
    if (!w || !h) throw new Error('decode');
    var s = Math.min(1, WORK_MAX / Math.max(w, h));
    var c = canvas(w * s, h * s);
    var g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, c.width, c.height);
    closeFn && closeFn();
    return c;
  }

  // 모서리 4점을 왼쪽 위 → 오른쪽 위 → 오른쪽 아래 → 왼쪽 아래 순서로 정리
  function order(pts) {
    var cx = 0, cy = 0;
    pts.forEach(function (p) { cx += p.x / 4; cy += p.y / 4; });
    var s = pts.slice().sort(function (a, b) { return Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx); });
    // atan2 기준 정렬(-π부터): 대략 왼쪽 위가 먼저 오도록 x+y가 가장 작은 점에서 시작
    var k = 0, best = Infinity;
    s.forEach(function (p, i) { if (p.x + p.y < best) { best = p.x + p.y; k = i; } });
    return s.slice(k).concat(s.slice(0, k));
  }

  // 8×8 연립방정식(가우스 소거)
  function solve(A, b) {
    var n = b.length, i, j, k;
    for (i = 0; i < n; i++) {
      var max = i;
      for (k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[max][i])) max = k;
      var t = A[i]; A[i] = A[max]; A[max] = t; var tb = b[i]; b[i] = b[max]; b[max] = tb;
      if (Math.abs(A[i][i]) < 1e-12) throw new Error('singular');
      for (k = i + 1; k < n; k++) {
        var f = A[k][i] / A[i][i];
        for (j = i; j < n; j++) A[k][j] -= f * A[i][j];
        b[k] -= f * b[i];
      }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) {
      var sum = b[i];
      for (j = i + 1; j < n; j++) sum -= A[i][j] * x[j];
      x[i] = sum / A[i][i];
    }
    return x;
  }

  // 결과 사각형(0,0)-(W,H)의 점 → 원본 사진의 점 으로 가는 변환(호모그래피)
  function homography(W, H, q) {
    var d = [[0, 0], [W, 0], [W, H], [0, H]], A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var u = d[i][0], v = d[i][1], x = q[i].x, y = q[i].y;
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    var h = solve(A, b);
    return h.concat([1]);
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // 원근 보정: 작업용 캔버스 + 모서리 4점(작업용 캔버스 좌표) → 곧게 편 캔버스
  function warp(src, corners) {
    var q = order(corners);
    var W = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
    var H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    if (W < 20 || H < 20) throw new Error('too small');
    var s = Math.min(1, OUT_MAX / Math.max(W, H), Math.sqrt(OUT_PIXELS / (W * H)));
    W = Math.round(W * s); H = Math.round(H * s);
    var h = homography(W, H, q);
    var sw = src.width, sh = src.height;
    var sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
    var out = canvas(W, H), og = out.getContext('2d');
    var img = og.createImageData(W, H), od = img.data;
    var o = 0;
    for (var v = 0; v < H; v++) {
      for (var u = 0; u < W; u++) {
        var den = h[6] * u + h[7] * v + 1;
        var x = (h[0] * u + h[1] * v + h[2]) / den;
        var y = (h[3] * u + h[4] * v + h[5]) / den;
        if (x < 0) x = 0; else if (x > sw - 1.001) x = sw - 1.001;
        if (y < 0) y = 0; else if (y > sh - 1.001) y = sh - 1.001;
        var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
        var i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        od[o] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
        od[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
        od[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
        od[o + 3] = 255;
        o += 4;
      }
    }
    og.putImageData(img, 0, 0);
    return out;
  }

  // 대비 보정: 밝기 분포의 아래 1%·위 1%를 검정·흰색으로 늘림
  // 흑백: 회색조로 바꾼 뒤 적용. 컬러: 빨강·초록·파랑을 따로 늘려 종이가 흰색이 되게 함(누런 색 빠짐)
  function stretchLut(hist, n) {
    var lo = 0, hi = 255, acc = 0, i;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc > n * 0.01) { lo = i; break; } }
    acc = 0;
    for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc > n * 0.01) { hi = i; break; } }
    if (hi - lo < 30) { lo = Math.max(0, lo - 15); hi = Math.min(255, hi + 15); }
    var lut = new Uint8ClampedArray(256), range = hi - lo;
    for (i = 0; i < 256; i++) lut[i] = ((i - lo) * 255) / range;
    return lut;
  }

  function enhance(src, mode) {
    var w = src.width, h = src.height;
    var c = canvas(w, h), g = c.getContext('2d');
    g.drawImage(src, 0, 0);
    var img = g.getImageData(0, 0, w, h), d = img.data, n = w * h, i, L;
    if (mode === 'color') {
      var hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
      for (i = 0; i < d.length; i += 4) { hr[d[i]]++; hg[d[i + 1]]++; hb[d[i + 2]]++; }
      var lr = stretchLut(hr, n), lg = stretchLut(hg, n), lb = stretchLut(hb, n);
      for (i = 0; i < d.length; i += 4) { d[i] = lr[d[i]]; d[i + 1] = lg[d[i + 1]]; d[i + 2] = lb[d[i + 2]]; }
    } else {
      var hist = new Uint32Array(256);
      for (i = 0; i < d.length; i += 4) { hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++; }
      var lut = stretchLut(hist, n);
      for (i = 0; i < d.length; i += 4) {
        L = lut[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8];
        d[i] = d[i + 1] = d[i + 2] = L;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  // 시계 방향 90° × turns
  function rotate(src, turns) {
    turns = ((turns % 4) + 4) % 4;
    if (!turns) return src;
    var sw = src.width, sh = src.height, odd = turns % 2 === 1;
    var c = canvas(odd ? sh : sw, odd ? sw : sh), g = c.getContext('2d');
    g.translate(c.width / 2, c.height / 2);
    g.rotate(turns * Math.PI / 2);
    g.drawImage(src, -sw / 2, -sh / 2);
    return c;
  }

  function scaled(src, maxSide) {
    var s = Math.min(1, maxSide / Math.max(src.width, src.height));
    if (s === 1) return src;
    var c = canvas(src.width * s, src.height * s), g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  function jpeg(src, quality) {
    return new Promise(function (resolve, reject) {
      src.toBlob(function (b) { b ? resolve(b) : reject(new Error('encode')); }, 'image/jpeg', quality || 0.88);
    });
  }

  // 글자 줄이 세로로 서 있는지(= 영수증이 옆으로 누운 채 찍혔는지) 판단
  // 방법: 작게 줄여 어두운 점(글자)을 찾은 뒤, 가로줄·세로줄마다 글자 점 수를 셈.
  //   글자 줄이 가로로 놓여 있으면 줄 사이 여백 때문에 "빈 가로줄"이 많고, 옆으로 누워 있으면 "빈 세로줄"이 많음.
  //   차이가 뚜렷하지 않으면 모양(가로가 길면 돌림)으로 판단
  function textSideways(src) {
    var sm = scaled(src, 600), w = sm.width, h = sm.height;
    var d = sm.getContext('2d').getImageData(0, 0, w, h).data;
    var x0 = Math.round(w * 0.06), x1 = Math.round(w * 0.94), y0 = Math.round(h * 0.06), y1 = Math.round(h * 0.94);
    var hist = new Uint32Array(256), n = 0, x, y, L;
    for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) { var i = (y * w + x) * 4; hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++; n++; }
    // 밝은 쪽(종이) 기준에서 충분히 어두운 점을 글자로 봄
    var acc = 0, paper = 255;
    for (L = 255; L >= 0; L--) { acc += hist[L]; if (acc > n * 0.5) { paper = L; break; } }
    var thr = paper * 0.62;
    var rows = new Float64Array(y1 - y0), cols = new Float64Array(x1 - x0), dark = 0;
    for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) {
      var j = (y * w + x) * 4;
      if (((d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8) < thr) { rows[y - y0]++; cols[x - x0]++; dark++; }
    }
    if (dark < n * 0.003 || dark > n * 0.35) return w > h;   // 글자가 거의 없거나, 종이가 아닌 부분이 많음
    // 글자 영역 안에서 "빈 줄"(글자 점이 거의 없는 줄)의 비율. 글자 줄 방향으로는 줄 사이 여백 때문에 빈 줄이 많음
    function gaps(a) {
      var max = 0, k, first = -1, last = -1;
      for (k = 0; k < a.length; k++) if (a[k] > max) max = a[k];
      var lim = max * 0.04;
      for (k = 0; k < a.length; k++) if (a[k] > lim) { if (first < 0) first = k; last = k; }
      if (last - first < 8) return 0;
      var empty = 0;
      for (k = first; k <= last; k++) if (a[k] <= lim) empty++;
      return empty / (last - first + 1);
    }
    var rg = gaps(rows), cg = gaps(cols);
    if (cg > rg + 0.08) return true;
    if (rg > cg + 0.08) return false;
    return w > h;
  }

  window.RSImaging = {
    textSideways: textSideways,
    open: open, warp: warp, enhance: enhance, rotate: rotate, scaled: scaled, jpeg: jpeg, order: order, canvas: canvas
  };
})();
