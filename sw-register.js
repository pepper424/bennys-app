/* stackNtrack - service worker registration + auto-update.
   Kept in its own file so the Content-Security-Policy can forbid
   inline scripts entirely. */
if ("serviceWorker" in navigator) {
  // If a controller already exists, a controller change means a NEW
  // version just took over - reload once so the user sees it now.
  var hadController = !!navigator.serviceWorker.controller;
  var reloading = false;
  if (hadController) {
    navigator.serviceWorker.addEventListener("controllerchange",
      function () {
        if (reloading) return;
        reloading = true;
        location.reload();
      });
  }
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").then(function (reg) {
      // Check again whenever the app is brought back to the front.
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) { try { reg.update(); } catch (e) {} }
      });
    }).catch(function () {});
  });
}
