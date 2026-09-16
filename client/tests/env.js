// ===========================================================================
//  Env pengujian UI: jsdom + fetch ke API.
//  Dipakai oleh ui-smoke.mjs (entry di-bundle esbuild sehingga react &
//  react-dom yang dipakai halaman = react yang sama dengan react yang me-render).
// ===========================================================================
import { JSDOM } from 'jsdom';

export const BASE = process.env.KASIR_API || 'http://127.0.0.1:4100';

const dom = new JSDOM('<!doctype html><html lang="id"><head></head><body></body></html>', {
  url: 'http://localhost:5173/', pretendToBeVisual: true,
});
const COPY = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement',
  'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage',
  'requestAnimationFrame', 'cancelAnimationFrame', 'DOMRect', 'location', 'Image', 'MutationObserver', 'Response'];
for (const k of COPY) {
  if (dom.window[k] === undefined) continue;
  try { globalThis[k] = dom.window[k]; } catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true }); }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.print = () => {};
dom.window.open = () => ({ document: { write() {}, close() {}, readyState: 'complete' }, focus() {}, print() {}, close() {} });
const RO = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = RO;
dom.window.ResizeObserver = RO;
// jsdom tidak punya createObjectURL (dipakai unduh CSV) -> stub agar tidak melempar
if (!dom.window.URL.createObjectURL) {
  dom.window.URL.createObjectURL = () => 'blob:stub';
  dom.window.URL.revokeObjectURL = () => {};
}

export { dom };
