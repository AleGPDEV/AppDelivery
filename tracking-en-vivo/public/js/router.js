// Router chico del lado del cliente para las 7 pestañas de admin. Registro
// path -> vista, intercepta los clicks del nav (pushState en vez de
// navegación real), maneja atrás/adelante del navegador, y llama
// mount()/unmount() de la vista saliente/entrante contra un único
// contenedor (#view-root) en vez de recargar el documento entero.

const routes = new Map();
let current = null; // { path, view }
let viewRootEl = null;
let headerEl = null;

function getViewRoot() {
  if (!viewRootEl) viewRootEl = document.getElementById('view-root');
  return viewRootEl;
}

function setActiveTab(path) {
  document.querySelectorAll('.tabs a.tab-btn[href]').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === path);
  });
}

function setChrome(view) {
  if (!headerEl) headerEl = document.getElementById('page-header');
  headerEl.className = view.wide ? 'wide' : '';
}

async function mountPath(path) {
  const view = routes.get(path);
  if (!view) {
    // Ruta desconocida (no es ninguna de las 7 pestañas de admin) — no es
    // responsabilidad de este router, se deja como navegación real.
    window.location.href = path;
    return;
  }
  if (current) {
    try {
      current.view.unmount();
    } catch (err) {
      console.error(`Error al desmontar la vista "${current.path}":`, err);
    }
  }
  const root = getViewRoot();
  root.innerHTML = view.template;
  document.title = view.title || document.title;
  setChrome(view);
  setActiveTab(path);
  current = { path, view };
  try {
    await view.mount(root);
  } catch (err) {
    console.error(`Error al montar la vista "${path}":`, err);
  }
}

function navigate(path) {
  history.pushState({ path }, '', path);
  mountPath(path);
}

function onNavClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('.tabs a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!routes.has(href)) return; // no es una de las 7 rutas de la SPA
  e.preventDefault();
  if (href === current?.path) return;
  navigate(href);
}

document.addEventListener('click', onNavClick);

window.addEventListener('popstate', () => {
  mountPath(location.pathname);
});

export const Router = {
  register(path, view) {
    routes.set(path, view);
  },
  start() {
    mountPath(location.pathname);
  },
};
