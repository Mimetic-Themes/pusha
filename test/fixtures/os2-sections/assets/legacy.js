window.themeGlobals = window.themeGlobals || {};

document.addEventListener('DOMContentLoaded', function () {
  window.themeGlobals.ready = true;
  initLegacyWidgets();
});

function initLegacyWidgets() {
  // module-level state that won't replay on a PJAX swap
}
