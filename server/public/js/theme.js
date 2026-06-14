'use strict';

/**
 * Gestión del tema claro/oscuro.
 *
 * Cárgalo en el <head> SIN defer/async para que el tema se aplique antes de
 * pintar la página (evita el parpadeo). Funciona en todas las vistas, incluso
 * en las que no usan common.js (login, superadmin).
 *
 *  - Preferencia guardada en localStorage ('digisignage-theme').
 *  - Si no hay preferencia, respeta el sistema (prefers-color-scheme).
 *  - Cualquier botón con [data-theme-toggle] alterna el tema y muestra su icono.
 */
(function () {
  var KEY = 'digisignage-theme';
  var root = document.documentElement;

  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function current() {
    return root.getAttribute('data-theme') || stored() || systemTheme();
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    updateToggles(theme);
  }

  function updateToggles(theme) {
    var btns = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">' +
        (theme === 'dark' ? 'light_mode' : 'dark_mode') + '</span>';
      b.setAttribute('title', theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
      b.setAttribute('aria-label', b.getAttribute('title'));
    }
  }

  function setTheme(theme) {
    try { localStorage.setItem(KEY, theme); } catch (e) {}
    apply(theme);
  }

  function toggle() {
    setTheme(current() === 'dark' ? 'light' : 'dark');
  }

  // Aplica de inmediato (antes del render) para evitar el flash.
  apply(current());

  // Cablea los botones cuando el DOM esté listo.
  function wire() {
    updateToggles(current());
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-theme-toggle]');
      if (btn) { e.preventDefault(); toggle(); }
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  // Si el usuario no eligió manualmente, sigue los cambios del sistema.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
      if (!stored()) apply(e.matches ? 'dark' : 'light');
    });
  }

  // API pública por si se necesita desde otras vistas.
  window.DigiTheme = { toggle: toggle, set: setTheme, current: current };
})();
