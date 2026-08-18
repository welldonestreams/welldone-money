// Theme before first paint: explicit choice wins, else OS preference.
//
// This lived as an inline <script> in index.html, where the app's own CSP
// (script-src 'self', no hash or nonce) blocked it outright — so the theme was
// never applied before paint and the attribute was never set. Loading it as a
// file satisfies the policy without relaxing it. Kept parser-blocking and
// ahead of the stylesheet so it still runs before anything renders.
(function () {
  try {
    var t = localStorage.getItem('wmd_theme');
    if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
  } catch (e) { document.documentElement.dataset.theme = 'dark'; }
})();
