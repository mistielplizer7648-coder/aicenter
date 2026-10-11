const $ = (id) => document.getElementById(id);
const BROWSER_HOST_ORIGINS = ['http://*/*', 'https://*/*'];
let session = null;
let pending = null;

async function bg(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...extra });
  if (!response?.ok) throw new Error(response?.error || '操作失败');
  return response.result;
}

function setResult(value) {
  $('commandResult').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function requireUiSession() {
  if (!session) await refreshSession();
  if (!session) throw new Error('请先点击“仅查看”或“查看 + 操作”授权当前标签页或当前浏览器会话');
  return session;
}

function showUiError(error, alertUser = false) {
  const message = String(error?.message || error || '操作失败');
  setResult({ ok: false, error: message });
  if (alertUser) alert(message);
}

async function safeUi(fn, { alertUser = false } = {}) {
  try {
    return await fn();
  } catch (error) {
    showUiError(error, alertUser);
    return null;
  }
}

function render() {
  const on = !!session;
  $('unauthorized').classList.toggle('hidden', on);
  $('authorized').classList.toggle('hidden', !on);
  $('statusDot').classList.toggle('on', on && !session?.paused);
  if (session) {
    $('modeSelect').value = session.mode;
    $('sessionStatus').textContent = session.paused ? '已暂停' : '已授权';
    if ($('scopeStatus')) $('scopeStatus').textContent = session.scope === 'browser' ? '当前浏览器会话' : '当前标签页';
    $('pageTitle').textContent = session.title || session.url || '';
    $('pauseBtn').textContent = session.paused ? '继续' : '暂停';
    $('revokeBtn').textContent = session.scope === 'browser' ? '结束浏览器会话授权' : '结束当前标签页授权';
    pending = session.pendingAction || pending;
  }
  $('pendingCard').classList.toggle('hidden', !pending);
  $('pendingSummary').textContent = pending?.summary || '';
}

function renderBridge(state = {}) {
  const text = state.connected
    ? 'Connector 桥：已连接'
    : state.pairingState === 'pending_approval'
      ? 'Connector 桥：等待本机允许'
      : state.lastError
        ? `Connector 桥：${state.lastError}`
        : 'Connector 桥：未连接';
  $('nativeState').textContent = text;
  $('nativeBtn').textContent = state.connected ? '已连接' : state.pairingState === 'pending_approval' ? '等待确认' : '连接';
  $('nativeBtn').disabled = !!state.connected;
}

async function refreshBridge() {
  try { renderBridge(await bg('GET_BRIDGE_STATE')); } catch (e) { $('nativeState').textContent = `Connector 桥：${e.message}`; }
}

async function refreshSession() {
  try { session = await bg('GET_CURRENT_SESSION'); } catch { session = null; }
  render();
}

function updateScopeDescription() {
  const browserScope = $('scopeSelect')?.value === 'browser';
  if (!$('scopeDescription')) return;
  $('scopeDescription').textContent = browserScope
    ? '当前浏览器会话：你确认一次网站访问权限后，普通 http/https 网页、新分页和跨网站跳转会自动继续协作；结束会话时会撤销该权限。'
    : '当前标签页：只限当前网站，跨网站后需要重新授权。';
}

async function authorize(mode) {
  const scope = $('scopeSelect')?.value === 'browser' ? 'browser' : 'tab';
  if (scope === 'browser') {
    const granted = await chrome.permissions.request({ origins: BROWSER_HOST_ORIGINS });
    if (!granted) throw new Error('你没有允许访问普通网站，浏览器会话授权未开启');
  }
  session = await bg('AUTHORIZE_CURRENT_TAB', { mode, scope });
  render();
  await snapshot();
  await refreshBridge();
}

async function snapshot() {
  await requireUiSession();
  const result = await bg('EXECUTE_CURRENT_COMMAND', { command: { action: 'snapshot' } });
  const page = result?.page || {};
  const lines = [
    `标题: ${page.title || ''}`,
    `网址: ${page.url || ''}`,
    '',
    '可操作元素:',
    ...(page.elements || []).slice(0, 80).map((e) => `${e.ref} [${e.role}] ${e.name || '(无名称)'}${e.type ? ` type=${e.type}` : ''}`),
    '',
    '页面正文:',
    page.text || ''
  ];
  $('snapshot').value = lines.join('\n');
  return result;
}

async function executeTest(action) {
  const command = { action };
  if (action !== 'scroll') command.ref = $('refInput').value.trim();
  if (action === 'fill') command.value = $('valueInput').value;
  if (action === 'scroll') command.y = 650;
  const result = await bg('EXECUTE_CURRENT_COMMAND', { command });
  if (result?.confirmationRequired) {
    pending = result.pendingAction;
    render();
  }
  setResult(result);
}

$('scopeSelect')?.addEventListener('change', updateScopeDescription);
$('viewBtn').addEventListener('click', () => safeUi(() => authorize('view'), { alertUser: true }));
$('interactBtn').addEventListener('click', () => safeUi(() => authorize('interact'), { alertUser: true }));
$('snapshotBtn').addEventListener('click', () => safeUi(() => snapshot(), { alertUser: true }));
$('revokeBtn').addEventListener('click', () => safeUi(async () => {
  if (session?.scope === 'browser') await bg('REVOKE_BROWSER_SESSION');
  else await bg('REVOKE_CURRENT_TAB');
  session = null;
  pending = null;
  $('snapshot').value = '';
  render();
}));
$('pauseBtn').addEventListener('click', () => safeUi(async () => {
  await requireUiSession();
  session = await bg('SET_SESSION_PAUSED', { paused: !session.paused });
  render();
}));
$('modeSelect').addEventListener('change', (e) => safeUi(async () => {
  await requireUiSession();
  session = await bg('SET_SESSION_MODE', { mode: e.target.value });
  render();
}));
$('confirmBtn').addEventListener('click', () => safeUi(async () => {
  if (!pending?.token) throw new Error('当前没有待确认操作');
  const result = await bg('CONFIRM_PENDING', { token: pending.token });
  pending = null;
  render();
  setResult(result);
}, { alertUser: true }));
$('cancelPendingBtn').addEventListener('click', () => { pending = null; render(); });
document.querySelectorAll('[data-cmd]').forEach((btn) => btn.addEventListener('click', () => safeUi(() => executeTest(btn.dataset.cmd))));
$('nativeBtn').addEventListener('click', () => safeUi(async () => {
  renderBridge(await bg('CONNECT_BRIDGE'));
  setTimeout(refreshBridge, 1200);
}));

(async () => {
  updateScopeDescription();
  await refreshSession();
  try { renderBridge(await bg('AUTO_CONNECT_BRIDGE')); } catch {}
  await refreshBridge();
  setInterval(refreshBridge, 1500);
})();
