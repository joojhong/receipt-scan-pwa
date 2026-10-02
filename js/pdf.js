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
  async function build(pages, byId, getImage, onStep, limit) {
    var max = limit || LIMIT;
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
      if (last.size <= max) return { blob: last, dpi: opt.dpi, reduced: t > 0 };
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

  // ── 외부 도구(필요할 때만 CDN에서 불러옴, 무결성 해시로 확인) ──
  var LIBS = {
    pdflib: { url: 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js', sri: 'sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI', name: 'PDFLib' },
    pdfjs: { url: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js', sri: 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e', name: 'pdfjsLib' }
  };
  var PDFJS_WORKER = { url: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js', sri: 'sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2' };
  var loading = {};
  function lib(key) {
    var L = LIBS[key];
    if (window[L.name]) return Promise.resolve(window[L.name]);
    if (!loading[key]) loading[key] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = L.url; s.integrity = L.sri; s.crossOrigin = 'anonymous';
      s.onload = function () { res(window[L.name]); };
      s.onerror = function () { s.remove(); loading[key] = null; rej(new Error('PDF 도구를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요')); };
      document.head.appendChild(s);
    });
    return loading[key];
  }
  async function pdfjs() {
    var p = await lib('pdfjs');
    if (!p.GlobalWorkerOptions.workerSrc) {
      // 다른 주소의 작업 파일은 바로 쓸 수 없어 내려받아(무결성 확인) 이 페이지 주소로 바꿔 씀
      var r = await fetch(PDFJS_WORKER.url, { integrity: PDFJS_WORKER.sri });
      p.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([await r.text()], { type: 'text/javascript' }));
    }
    return p;
  }

  // 암호가 걸린 PDF인지(pdf-lib는 암호 PDF를 열지 못함)
  async function isEncrypted(buf) {
    var L = await lib('pdflib');
    try { await L.PDFDocument.load(buf); return false; }
    catch (e) {
      if (e && (e.name === 'EncryptedPDFError' || /encrypt/i.test(e.message || ''))) return true;
      var bad = new Error('PDF를 열 수 없습니다. 손상된 파일일 수 있습니다'); bad.bad = true; throw bad;
    }
  }

  // 암호를 풀어 암호 없는 PDF로 다시 만듦(쪽마다 그림으로 바꿔 담음). 비밀번호는 저장하지 않음
  // 실패: e.pw = 'need'(비밀번호 필요) | 'wrong'(틀림)
  async function unlock(buf, password, onStep) {
    var P = await pdfjs();
    var doc;
    try { doc = await P.getDocument({ data: new Uint8Array(buf.slice(0)), password: password || '', isEvalSupported: false }).promise; }
    catch (e) {
      if (e && e.name === 'PasswordException') { var x = new Error(e.code === 2 ? '비밀번호가 맞지 않습니다' : '비밀번호가 필요합니다'); x.pw = e.code === 2 ? 'wrong' : 'need'; throw x; }
      throw new Error('PDF를 열 수 없습니다');
    }
    var L = await lib('pdflib');
    var tries = [{ dpi: 200, q: 0.85 }, { dpi: 150, q: 0.72 }, { dpi: 120, q: 0.6 }], blob = null;
    for (var t = 0; t < tries.length; t++) {
      var out = await L.PDFDocument.create();
      for (var i = 1; i <= doc.numPages; i++) {
        onStep && onStep('암호 푸는 중 ' + i + ' / ' + doc.numPages + (t ? ' (용량 줄이는 중)' : ''));
        var page = await doc.getPage(i), base = page.getViewport({ scale: 1 });
        var s = Math.min(tries[t].dpi / 72, 3000 / Math.max(base.width, base.height));
        var vp = page.getViewport({ scale: s }), c = document.createElement('canvas');
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        var jb = await new Promise(function (res) { c.toBlob(res, 'image/jpeg', tries[t].q); });
        var img = await out.embedJpg(new Uint8Array(await jb.arrayBuffer()));
        out.addPage([base.width, base.height]).drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
        c.width = c.height = 0;
      }
      blob = new Blob([await out.save()], { type: 'application/pdf' });
      if (blob.size <= LIMIT) break;
    }
    doc.destroy();
    return blob;
  }

  window.RSPdf = { build: build, LIMIT: LIMIT, lib: lib, isEncrypted: isEncrypted, unlock: unlock };
})();
