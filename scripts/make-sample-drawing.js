// 예시 도면 PDF 생성: node scripts/make-sample-drawing.js
// js/drawing-sample.js 의 그림 요소(가상)로 글자가 선택되는 벡터 PDF 1쪽씩 두 장을 만듭니다(라벨형 A · 부품표형 B).
//  - samples/예시도면_하네스_가상.pdf  : 내려받아 「도면 불러오기」로 직접 올려 볼 수 있는 파일
//  - samples/예시도면_부품표형_가상.pdf : 부품표형 예시(예시고객사B), js/drawing-sample-pdf-b.js 에 base64
//  - js/drawing-sample-pdf.js          : 같은 PDF 를 base64 로 담은 스크립트. 로컬 파일(file://)로 열면
//                                        브라우저가 fetch 를 막으므로 「예시 불러오기」는 이 파일을 씁니다.
// 외부 라이브러리 없이 PDF 구조(객체·xref)를 직접 씁니다. 글꼴은 PDF 기본 14종의 Helvetica(영문·숫자만).
const fs = require('fs');
const path = require('path');
const D = require('../js/drawing-sample.js');

const f = (n) => (Math.round(n * 100) / 100).toString();
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
function makePdf(shapes, page, title) {
  const H = page.h;
  const ops = ['0 0 0 RG 0 0 0 rg 1 J 1 j'];
  shapes.forEach((s) => {
    if (s.t === 'line') ops.push(`${f(s.wd)} w ${f(s.x1)} ${f(H - s.y1)} m ${f(s.x2)} ${f(H - s.y2)} l S`);
    else if (s.t === 'rect') ops.push(`${f(s.wd)} w ${f(s.x)} ${f(H - s.y - s.h)} ${f(s.w)} ${f(s.h)} re S`);
    else if (s.t === 'text') ops.push(`BT /F1 ${f(s.s)} Tf ${f(s.x)} ${f(H - s.y)} Td (${esc(s.text)}) Tj ET`);
  });
  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.w} ${page.h}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    `<< /Title (${title}) /Producer (data09-16 make-sample-drawing.js) >>`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => { pdf += `${String(o).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
const buf = makePdf(D.shapes, D.page, 'Sample harness drawing - fictitious');
const bufB = makePdf(D.shapesB, D.page, 'Sample harness drawing B table style - fictitious');

const root = path.join(__dirname, '..');
fs.writeFileSync(path.join(root, 'samples', '예시도면_하네스_가상.pdf'), buf);
fs.writeFileSync(path.join(root, 'samples', '예시도면_부품표형_가상.pdf'), bufB);
fs.writeFileSync(path.join(root, 'js', 'drawing-sample-pdf.js'),
  '/* 예시 도면 PDF(가상, scripts/make-sample-drawing.js 로 생성) — 로컬 파일로 열어도 「예시 불러오기」가 되도록 base64 로 담았습니다 */\n' +
  "(function (root) { root.DrawSamplePdf = '" + buf.toString('base64') + "'; })(typeof window !== 'undefined' ? window : this);\n");
fs.writeFileSync(path.join(root, 'js', 'drawing-sample-pdf-b.js'),
  '/* 예시 도면 B — 부품표형(가상, scripts/make-sample-drawing.js 로 생성). 로컬 파일로 열어도 「예시 불러오기」가 되도록 base64 로 담았습니다 */\n' +
  "(function (root) { root.DrawSamplePdfB = '" + bufB.toString('base64') + "'; })(typeof window !== 'undefined' ? window : this);\n");
console.log('예시 도면 PDF', buf.length, 'bytes · 부품표형', bufB.length, 'bytes');
