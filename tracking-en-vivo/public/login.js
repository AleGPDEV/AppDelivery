const userEl = document.getElementById('login-user');
const passEl = document.getElementById('login-pass');
const btnEl = document.getElementById('login-btn');
const statusEl = document.getElementById('login-status');

async function doLogin() {
  const username = userEl.value.trim();
  const password = passEl.value;
  if (!username || !password) {
    statusEl.textContent = 'Completá usuario y contraseña.';
    statusEl.className = 'status error';
    return;
  }
  btnEl.disabled = true;
  statusEl.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');
    window.location.href = 'pedidos.html';
  } catch (e) {
    statusEl.textContent = e.message;
    statusEl.className = 'status error';
    btnEl.disabled = false;
  }
}

btnEl.addEventListener('click', doLogin);
[userEl, passEl].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); }));
