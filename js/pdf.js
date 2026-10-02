/* A4 PDF 만들기(4단계 4번)
   - RSLayout 배치 결과대로 영수증 사진(JPEG)을 A4 페이지에 놓은 PDF를 직접 씀(외부 라이브러리 없음)
   - 해상도 200dpi(설계서). 사진이 그보다 작으면 키우지 않음
   - 10MB(인트라넷 첨부 한도)를 넘으면 화질을 낮춰 다시 만듦 */
(function () {
  'use strict';

  var MM = 72 / 25.4;              // mm → pt
  var LIMIT = 9.5 * 1024 * 1024;   // 10MB보다 조금 작게

  function enc(s) { return new TextEncoder().encode(s); }

  // pages: RSLayout 결과, items: id→영수증, getImage(it) → Promise<HTMLImageElement>
  async function build(pages, byId, getImage, onStep) {
    var tries = [{ dpi: 200, q: 0.85 }, { dpi: 170, q: 0.75 }, { dpi: 150, q: 0.65 }];
    var decoded = {}, last = null;
    for (var t = 0; t < tries.length; t++) {
      var opt = tries[t], imgs = {}, n = 0, total = pages.reduce(function (a, p) { return a + p.boxes.length; }, 0);
      for (var p = 0; p < pages.length; p++) {
        for (var b = 0; b < pages[p].boxes.length; b++) {
          var box = pages[p].boxes[b], it = byId[box.id];
          n++;
          onStep && onStep('PDF를 만드는 중 ' + n + ' / ' + total + (t ? ' (용량을 줄이는 중)' : ''));
          if (!decoded[box.id]) decoded[box.id] = await getImage(it);
          imgs[box.id] = await jpegFor(decoded[box.id], it.rot || 0, box, opt);
        }
      }
      last = write(pages, imgs);
      if (last.size <= LIMIT) return { blob: last, dpi: opt.dpi, reduced: t > 0 };
    }
    return { blob: last, dpi: tries[tries.length - 1].dpi, reduced: true, tooBig: true };
  }

  // 칸 크기(mm)에 맞춰 dpi 기준 픽셀로 줄이고 회전 적용 → JPEG 바이트
  async function jpegFor(img, rot, box, opt) {
    var odd = rot % 2 === 1;
    var needW = Math.round(box.w / 25.4 * opt.dpi), needH = Math.round(box.h / 25.4 * opt.dpi);
    var srcW = img.naturalWidth || img.width, srcH = img.naturalHeight || img.height; // 사진(img) 또는 갑지(canvas)
    var outW = odd ? srcH : srcW, outH = odd ? srcW : srcH;          // 회전 뒤 크기
    var s = Math.min(1, needW / outW, needH / outH);
    var cw = Math.max(1, Math.round(outW * s)), ch = Math.max(1, Math.round(outH * s));
    var c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    var g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch);
    g.imageSmoothingQuality = 'high';
    g.translate(cw / 2, ch / 2);
    g.rotate(rot * Math.PI / 2);
    var dw = odd ? ch : cw, dh = odd ? cw : ch;
    g.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    var blob = await new Promise(function (res) { c.toBlob(res, 'image/jpeg', box.sheet ? Math.max(opt.q, 0.9) : opt.q); });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w: cw, h: ch };
  }

  // PDF 1.4 파일 쓰기: 1 카탈로그, 2 페이지 목록, 이후 페이지·내용·이미지
  function write(pages, imgs) {
    var parts = [], offsets = [], pos = 0, objs = 2;
    var push = function (x) { var u = typeof x === 'string' ? enc(x) : x; parts.push(u); pos += u.length; };
    var start = function (n) { offsets[n] = pos; push(n + ' 0 obj\n'); };
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

    var pageIds = [], plan = pages.map(function (pg) {
      var page = ++objs, content = ++objs, list = pg.boxes.map(function (b) { return { b: b, obj: ++objs }; });
      pageIds.push(page);
      return { pg: pg, page: page, content: content, list: list };
    });

    start(1); push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    start(2); push('<< /Type /Pages /Count ' + pageIds.length + ' /Kids [' + pageIds.map(function (i) { return i + ' 0 R'; }).join(' ') + '] >>\nendobj\n');

    plan.forEach(function (pl) {
      var W = (210 * MM).toFixed(2), H = (297 * MM).toFixed(2);
      var xo = pl.list.map(function (x, i) { return '/Im' + i + ' ' + x.obj + ' 0 R'; }).join(' ');
      start(pl.page);
      push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Resources << /XObject << ' + xo + ' >> >> /Contents ' + pl.content + ' 0 R >>\nendobj\n');
      var cs = pl.list.map(function (x, i) {
        var b = x.b, w = b.w * MM, h = b.h * MM, px = b.x * MM, py = (297 - b.y - b.h) * MM; // PDF는 왼쪽 아래가 원점
        return 'q ' + w.toFixed(2) + ' 0 0 ' + h.toFixed(2) + ' ' + px.toFixed(2) + ' ' + py.toFixed(2) + ' cm /Im' + i + ' Do Q';
      }).join('\n');
      var csb = enc(cs);
      start(pl.content); push('<< /Length ' + csb.length + ' >>\nstream\n'); push(csb); push('\nendstream\nendobj\n');
      pl.list.forEach(function (x) {
        var im = imgs[x.b.id];
        start(x.obj);
        push('<< /Type /XObject /Subtype /Image /Width ' + im.w + ' /Height ' + im.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.bytes.length + ' >>\nstream\n');
        push(im.bytes); push('\nendstream\nendobj\n');
      });
    });

    var xref = pos, total = objs + 1;
    var x = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (var i = 1; i < total; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    push(x);
    push('trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    return new Blob(parts, { type: 'application/pdf' });
  }

  window.RSPdf = { build: build, LIMIT: LIMIT };
})();
