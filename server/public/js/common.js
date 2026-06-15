'use strict';

/**
 * Helpers compartidos por las páginas admin (dashboard, users, device).
 * Script plano (sin módulos): define funciones globales.
 */

// Devuelve el HTML de un icono Material Symbols (decorativo).
// `extra` añade clases opcionales. Ej.: icon('edit') -> <span ...>edit</span>.
function icon(name, extra) {
  return `<span class="material-symbols-outlined${extra ? ' ' + extra : ''}" aria-hidden="true">${name}</span>`;
}

// Escapa texto para insertarlo de forma segura en HTML.
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Fecha relativa legible ("hace 5s", "hace 3 min") o fecha local.
function fmtFecha(iso) {
  if (!iso) return 'Nunca';
  const d = new Date(iso);
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60) return `hace ${diffSec}s`;
  if (diffSec < 3600) return `hace ${Math.floor(diffSec / 60)} min`;
  return d.toLocaleString('es');
}

// Tamaño de archivo legible.
function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

// Duración en segundos -> "MM:SS" o "H:MM:SS".
function fmtDuration(seg) {
  seg = Math.max(0, Math.round(Number(seg) || 0));
  const h = Math.floor(seg / 3600);
  const m = Math.floor((seg % 3600) / 60);
  const s = seg % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Línea de metadatos de un archivo de biblioteca (omite lo que falte).
// Ej.: "1920×1080 · 24.3 MB · 0:32 · 07/06/2026".
function mediaMetaLine(item) {
  if (!item || typeof item !== 'object') return '';
  const parts = [];
  if (item.width && item.height) parts.push(`${item.width}×${item.height}`);
  if (item.bytes != null) parts.push(humanSize(item.bytes));
  if (item.duration != null) parts.push(fmtDuration(item.duration));
  if (item.mtime) parts.push(new Date(item.mtime).toLocaleDateString('es'));
  return parts.join(' · ');
}

// Reloj en el elemento indicado (hora local, refresco 1 s).
function startClock(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const tick = () => { el.textContent = new Date().toLocaleTimeString('es'); };
  setInterval(tick, 1000); tick();
}

// Conecta el botón de cerrar sesión.
function wireLogout(btnId) {
  const b = document.getElementById(btnId);
  if (!b) return;
  b.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/login.html';
  });
}

/**
 * Verifica la sesión. Redirige a login si no hay; a superadmin si el rol es
 * super_admin. Devuelve el objeto { usuario, rol, empresaId, empresaNombre } o
 * null si redirigió.
 */
async function getMe() {
  const res = await fetch('/api/me');
  if (!res.ok) { location.href = '/login.html'; return null; }
  const me = await res.json();
  if (me.rol === 'super_admin') { location.href = '/superadmin.html'; return null; }
  return me;
}

/* ----------------- Modales (sustituyen a alert/confirm/prompt nativos) ----------------- */
// Regla del proyecto: nunca usar alert()/confirm()/prompt(); siempre <dialog>.

// Inyecta una sola vez el <dialog> genérico de mensaje/confirmación.
let _msgModal = null;
function _ensureMsgModal() {
  if (_msgModal) return _msgModal;
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  dlg.innerHTML =
    '<form method="dialog" class="modal-card">' +
    '  <h3 class="modal-title"></h3>' +
    '  <div class="modal-msg"></div>' +
    '  <div class="modal-actions">' +
    '    <button type="submit" value="cancel" class="btn ghost" data-cancel>Cancelar</button>' +
    '    <button type="submit" value="ok" class="btn" data-ok>Aceptar</button>' +
    '  </div>' +
    '</form>';
  document.body.appendChild(dlg);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('cancel'); });
  _msgModal = {
    dlg,
    title: dlg.querySelector('.modal-title'),
    msg: dlg.querySelector('.modal-msg'),
    ok: dlg.querySelector('[data-ok]'),
    cancel: dlg.querySelector('[data-cancel]'),
  };
  return _msgModal;
}

/**
 * Modal genérico. Devuelve Promise<boolean> (true = aceptar).
 * - Confirmación: pasar `cancelText` para mostrar el botón Cancelar.
 * - Informativo (estilo alert): omitir `cancelText` -> solo botón de aceptar.
 * - `items`: lista opcional de líneas (insertadas como texto: sin riesgo de XSS).
 */
function showModal({ title = '', message = '', items = null, confirmText = 'Aceptar', cancelText = null, danger = false } = {}) {
  const m = _ensureMsgModal();
  m.title.textContent = title;
  m.title.style.display = title ? '' : 'none';
  m.msg.textContent = '';
  if (message) {
    const p = document.createElement('p');
    p.className = 'modal-line';
    p.textContent = message;
    m.msg.appendChild(p);
  }
  if (Array.isArray(items) && items.length) {
    const ul = document.createElement('ul');
    ul.className = 'modal-list';
    items.forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
    m.msg.appendChild(ul);
  }
  m.ok.textContent = confirmText;
  m.ok.className = 'btn' + (danger ? ' danger' : '');
  m.cancel.textContent = cancelText || 'Cancelar';
  m.cancel.style.display = cancelText ? '' : 'none';
  return new Promise((resolve) => {
    m.dlg.returnValue = 'cancel';
    m.dlg.addEventListener('close', () => resolve(m.dlg.returnValue === 'ok'), { once: true });
    m.dlg.showModal();
  });
}

// Atajos: confirmModal -> Promise<boolean>; alertModal -> Promise<void>.
function confirmModal(message, opts = {}) {
  return showModal({ title: 'Confirmar', confirmText: 'Aceptar', cancelText: 'Cancelar', ...opts, message });
}
function alertModal(message, opts = {}) {
  return showModal({ confirmText: 'Entendido', ...opts, message, cancelText: null });
}

// Modal con un campo de texto (sustituye a prompt). Devuelve string (recortado) o null.
let _inputModal = null;
function _ensureInputModal() {
  if (_inputModal) return _inputModal;
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  dlg.innerHTML =
    '<form method="dialog" class="modal-card">' +
    '  <h3 class="modal-title"></h3>' +
    '  <label for="_inputModalField" data-label></label>' +
    '  <input type="text" id="_inputModalField" />' +
    '  <div class="modal-actions">' +
    '    <button type="submit" value="cancel" class="btn ghost" formnovalidate>Cancelar</button>' +
    '    <button type="submit" value="ok" class="btn" data-ok>Aceptar</button>' +
    '  </div>' +
    '</form>';
  document.body.appendChild(dlg);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('cancel'); });
  _inputModal = {
    dlg,
    title: dlg.querySelector('.modal-title'),
    label: dlg.querySelector('[data-label]'),
    input: dlg.querySelector('#_inputModalField'),
    ok: dlg.querySelector('[data-ok]'),
  };
  return _inputModal;
}

function promptModal({ title = '', label = '', value = '', placeholder = '', confirmText = 'Aceptar', required = true } = {}) {
  const m = _ensureInputModal();
  m.title.textContent = title;
  m.title.style.display = title ? '' : 'none';
  m.label.textContent = label;
  m.label.style.display = label ? '' : 'none';
  m.input.value = value;
  m.input.placeholder = placeholder;
  m.input.required = required;
  m.ok.textContent = confirmText;
  return new Promise((resolve) => {
    m.dlg.returnValue = 'cancel';
    m.dlg.addEventListener('close', () => {
      resolve(m.dlg.returnValue === 'ok' ? m.input.value.trim() : null);
    }, { once: true });
    m.dlg.showModal();
    m.input.focus();
    m.input.select();
  });
}

/**
 * Pinta el menú superior en el contenedor #topnav. `active` es la clave de la
 * página actual ('dispositivos' | 'usuarios'). "Usuarios" solo se muestra a admin.
 */
function renderTopnav(active, rol) {
  const nav = document.getElementById('topnav');
  if (!nav) return;
  const items = [{ key: 'dispositivos', label: 'Dispositivos', href: '/dashboard.html' }];
  if (rol === 'admin') items.push({ key: 'usuarios', label: 'Usuarios', href: '/users.html' });
  nav.innerHTML = items.map((it) =>
    `<a href="${it.href}" class="${it.key === active ? 'active' : ''}">${esc(it.label)}</a>`
  ).join('');
}
