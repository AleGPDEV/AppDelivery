// Se carga en <head>, antes de pintar, para no hacer flash del tema
// equivocado. Sin elección guardada, sigue la preferencia del sistema
// (@media prefers-color-scheme en style.css); con un click en el botón de
// la barra de navegación, se guarda una elección explícita que la pisa.
//
// La paleta (Ajustes -> Diseño -> Estilo) es un mecanismo aparte, mismo
// criterio de persistencia (localStorage, por dispositivo) -- a pedido
// explícito, para tener más variantes de color que el marrón oscuro/blanco
// claro de siempre. window.setPalette/getPalette quedan expuestos para que
// settings.js los use, mismo patrón que window.applyBranding en branding.js.
//
// `window.TRACKING_PAGE_DEFAULT_PALETTE` (opcional, seteado inline antes de
// este script) permite que una página sin selector propio de paleta
// (seguimiento.html, driver.html -- las abre el cliente/delivery en un
// dispositivo que nunca pasó por Ajustes) arranque en otra paleta que no
// sea la marrón de siempre, sin pisar una elección explícita guardada
// (incluida "Cálido" a propósito, si alguna vez se elige a mano).
(function () {
  const THEME_KEY = 'tracking.theme';
  const PALETTE_KEY = 'tracking.palette';
  const DEFAULT_PALETTE = 'warm';
  const PAGE_DEFAULT_PALETTE = window.TRACKING_PAGE_DEFAULT_PALETTE || DEFAULT_PALETTE;

  function getStored() {
    return localStorage.getItem(THEME_KEY);
  }

  function effectiveTheme() {
    const stored = getStored();
    if (stored) return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  const stored = getStored();
  if (stored) document.documentElement.dataset.theme = stored;

  function getPalette() {
    return localStorage.getItem(PALETTE_KEY) || PAGE_DEFAULT_PALETTE;
  }

  function setPalette(name) {
    localStorage.setItem(PALETTE_KEY, name);
    if (name === DEFAULT_PALETTE) delete document.documentElement.dataset.palette;
    else document.documentElement.dataset.palette = name;
  }

  const storedPalette = getPalette();
  if (storedPalette !== DEFAULT_PALETTE) document.documentElement.dataset.palette = storedPalette;
  else delete document.documentElement.dataset.palette;

  window.getPalette = getPalette;
  window.setPalette = setPalette;

  function wireToggle() {
    const btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;
    function updateIcon() {
      btn.textContent = effectiveTheme() === 'dark' ? '☀️' : '🌙';
    }
    updateIcon();
    btn.addEventListener('click', () => {
      const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      document.documentElement.dataset.theme = next;
      updateIcon();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireToggle);
  } else {
    wireToggle();
  }
})();
