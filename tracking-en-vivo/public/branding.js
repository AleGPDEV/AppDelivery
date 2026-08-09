// Aplica la identidad visual del negocio (Ajustes -> Diseño: nombre de la
// tienda, color principal/secundario, logo) a la página actual. Se carga
// como script clásico en TODAS las páginas -- incluidas las que no tienen
// sesión de admin ni socket propio (login.html) -- por eso arranca con un
// fetch a GET /api/branding (público) en vez de depender de Socket.IO.
// Las páginas que sí tienen socket (admin, pedido-cliente, driver) llaman a
// window.applyBranding(...) de nuevo cuando llega un form-config:snapshot,
// para reflejar un cambio en vivo sin recargar.
//
// Elementos opcionales que cualquier página puede tener (se ignoran en
// silencio si no existen, así el mismo script sirve en las 4 páginas sin
// romper nada):
//   [data-branding="store-name"]  -- texto reemplazado por el nombre de la tienda
//   [data-branding="logo"]        -- <img> mostrada con el logo (oculta si no hay)
(function () {
  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return null;
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }

  // percent negativo oscurece (hacia negro), positivo aclara (hacia blanco) -- usado
  // para derivar el "hover/activo" (--primary-dark) a partir de un solo color elegido.
  function shadeColor(hex, percent) {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    const target = percent < 0 ? 0 : 255;
    const p = Math.abs(percent) / 100;
    const r = Math.round((target - rgb.r) * p + rgb.r);
    const g = Math.round((target - rgb.g) * p + rgb.g);
    const b = Math.round((target - rgb.b) * p + rgb.b);
    return `rgb(${r}, ${g}, ${b})`;
  }

  function rgba(hex, alpha) {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  }

  function applyBranding(branding) {
    if (!branding) return;
    const root = document.documentElement.style;

    if (branding.primaryColor) {
      root.setProperty('--primary', branding.primaryColor);
      root.setProperty('--primary-dark', shadeColor(branding.primaryColor, -18));
      root.setProperty('--primary-glow', rgba(branding.primaryColor, 0.25));
      root.setProperty('--primary-soft', rgba(branding.primaryColor, 0.14));
    }
    if (branding.secondaryColor) {
      root.setProperty('--secondary', branding.secondaryColor);
      root.setProperty('--secondary-soft', rgba(branding.secondaryColor, 0.14));
    }

    if (branding.storeName) {
      document.querySelectorAll('[data-branding="store-name"]').forEach((el) => {
        el.textContent = branding.storeName;
      });
    }

    if (branding.logoUrl) {
      document.querySelectorAll('[data-branding="logo"]').forEach((el) => {
        el.src = branding.logoUrl;
        el.style.display = '';
      });
      let favicon = document.querySelector('link[rel="icon"]');
      if (!favicon) {
        favicon = document.createElement('link');
        favicon.rel = 'icon';
        document.head.appendChild(favicon);
      }
      favicon.href = branding.logoUrl;
    }
  }

  window.applyBranding = applyBranding;

  fetch('/api/branding')
    .then((r) => r.json())
    .then((data) => applyBranding(data.branding))
    .catch(() => { /* sin branding cargado todavía, se queda con los defaults del CSS */ });
})();
