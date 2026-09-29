pdf.js 3.11.174 (pdfjs-dist, build/pdf.min.js · build/pdf.worker.min.js · cmaps)
https://github.com/mozilla/pdf.js — Apache License 2.0 (LICENSE)
도면 PDF 를 화면에 그리고(렌더링), 텍스트 레이어에서 품번 후보와 그 위치(좌표)를 뽑는 데 씁니다.
로컬 파일(file://)로 열면 Worker 가 막히므로 pdf.worker.min.js 를 일반 스크립트로 먼저 읽어 메인 스레드에서 돌립니다.
