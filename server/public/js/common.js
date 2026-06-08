'use strict';

/**
 * Helpers compartidos por las páginas admin (dashboard, users, device).
 * Script plano (sin módulos): define funciones globales.
 */

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
