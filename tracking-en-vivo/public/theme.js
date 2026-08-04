// Se carga en <head>, antes de pintar, para no hacer flash del tema
// equivocado. Sin elección guardada, sigue la preferencia del sistema
// (@media prefers-color-scheme en style.css); con un click en el botón de
// la barra de navegación, se guarda una elección explícita que la pisa.
(function () {
  const KEY = 'tracking.theme';

  function getStored() {
    return localStorage.getItem(KEY);
  }

  function effectiveTheme() {
    const stored = getStored();
    if (stored) return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  const stored = getStored();
  if (stored) document.documentElement.dataset.theme = stored;

  function wireToggle() {
    const btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;
    function updateIcon() {
      btn.textContent = effectiveTheme() === 'dark' ? '☀️' : '🌙';
    }
    updateIcon();
    btn.addEventListener('click', () => {
      const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      localStorage.setItem(KEY, next);
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
