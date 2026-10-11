const BRIDGE_BASE = 'http://127.0.0.1:17361';
const BRIDGE_RECONNECT_ALARM = 'penguin-bridge-reconnect-v1';
const BRIDGE_RECONNECT_PERIOD_MINUTES = 0.5;
const BRIDGE_PAIRING_USER_ACTION_KEY = 'penguinBridgePairingNeedsUserActionV1';
const ADAPTER_ID = 'com.qienet.penguin.browser.extension';
const APP_ID = 'browser';
const BRIDGE_CAPABILITIES = ['status','open','read','element_image','click','visual_click','fill','select','press','sequence','find','scroll','back','forward','reload','screenshot','download','upload','tab_list','tab_new','tab_switch','tab_close','tab_batch','webmcp_discover','webmcp_call','bookmark_list','bookmark_search','bookmark_open','terminal_read','terminal_input','close'];

const sessions = new Map();
const SESSION_STORAGE_KEY = 'penguinAuthorizedSessionsV1';
const BROWSER_GRANT_STORAGE_KEY = 'penguinBrowserSessionGrantV1';
const BROWSER_HOST_ORIGINS = ['http://*/*', 'https://*/*'];
const HWCR_PRELOAD_SCRIPT_ID = 'penguin-hwcr-preload-0410';
const HWCR_PRELOAD_MATCHES = ['http://m.hwcr.vip/*', 'https://m.hwcr.vip/*', 'http://*.hwcr.vip/*', 'https://*.hwcr.vip/*'];
let sessionsRestored = false;
let browserGrantRestored = false;
let browserGrant = null;

async function persistBrowserGrant() {
  if (browserGrant) {
    await chrome.storage.session.set({ [BROWSER_GRANT_STORAGE_KEY]: browserGrant });
  } else {
    await chrome.storage.session.remove([BROWSER_GRANT_STORAGE_KEY]);
  }
}

async function restoreBrowserGrantOnce() {
  if (browserGrantRestored) return browserGrant;
  browserGrantRestored = true;
  try {
    const stored = await chrome.storage.session.get([BROWSER_GRANT_STORAGE_KEY]);
    const raw = stored?.[BROWSER_GRANT_STORAGE_KEY];
    const hostPermission = await chrome.permissions.contains({ origins: BROWSER_HOST_ORIGINS });
    if (raw?.scope === 'browser' && ['view', 'interact'].includes(raw.mode) && hostPermission) {
      browserGrant = {
        scope: 'browser',
        mode: raw.mode,
        createdAt: Number(raw.createdAt || now()),
        paused: !!raw.paused
      };
      await ensureHwcrPreloadRegistered().catch(() => {});
    } else {
      browserGrant = null;
      await chrome.storage.session.remove([BROWSER_GRANT_STORAGE_KEY]).catch(() => {});
      await unregisterHwcrPreload().catch(() => {});
    }
  } catch {
    browserGrant = null;
    await unregisterHwcrPreload().catch(() => {});
  }
  return browserGrant;
}

async function persistSessions() {
  const records = [...sessions.values()].map((session) => ({
    tabId: session.tabId,
    origin: session.origin,
    url: session.url,
    title: session.title,
    mode: session.mode,
    scope: session.scope === 'browser' ? 'browser' : 'tab',
    createdAt: session.createdAt,
    expiresAt: session.expiresAt || 0,
    paused: !!session.paused,
    suspendedOrigin: session.suspendedOrigin || null
  }));
  await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: records });
}

async function restoreSessionsOnce() {
  if (sessionsRestored) return;
  sessionsRestored = true;
  await restoreBrowserGrantOnce();
  let records = [];
  try {
    const stored = await chrome.storage.session.get([SESSION_STORAGE_KEY]);
    records = Array.isArray(stored?.[SESSION_STORAGE_KEY]) ? stored[SESSION_STORAGE_KEY] : [];
  } catch {
    sessionsRestored = false;
    return;
  }
  let changed = false;
  for (const raw of records) {
    try {
      const scope = raw?.scope === 'browser' ? 'browser' : 'tab';
      if (!raw?.tabId || !raw?.origin) { changed = true; continue; }
      if (scope === 'browser' && !browserGrant) { changed = true; continue; }
      const tab = await chrome.tabs.get(Number(raw.tabId));
      if (!tab?.url || !/^https?:\/\//i.test(tab.url)) { changed = true; continue; }
      const currentOrigin = new URL(tab.url).origin;
      const restored = {
        tabId: Number(raw.tabId),
        origin: scope === 'browser' ? currentOrigin : raw.origin,
        url: tab.url,
        title: tab.title || raw.title || '',
        mode: scope === 'browser' ? browserGrant.mode : (raw.mode === 'interact' ? 'interact' : 'view'),
        scope,
        createdAt: scope === 'browser' ? browserGrant.createdAt : Number(raw.createdAt || now()),
        expiresAt: 0,
        paused: scope === 'browser' ? !!browserGrant.paused : !!raw.paused,
        suspendedOrigin: scope === 'browser' ? null : (currentOrigin === raw.origin ? null : currentOrigin),
        pendingAction: null
      };
      if (Number(raw.expiresAt || 0) !== 0) changed = true;
      sessions.set(restored.tabId, restored);
    } catch { changed = true; }
  }
  if (changed) await persistSessions().catch(() => {});
}

let bridgeState = {
  connected: false,
  pairingState: 'unknown',
  lastError: null,
  clientId: null,
  bridgeVersion: null,
  polling: false,
  lastSeenAt: null
};
let bridgeLoopRunning = false;
let pairingLoopRunning = false;
let bridgeEnsurePromise = null;

function now() { return Date.now(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function publicSession(session) {
  if (!session) return null;
  return {
    tabId: session.tabId,
    origin: session.origin,
    url: session.url,
    title: session.title,
    mode: session.mode,
    scope: session.scope === 'browser' ? 'browser' : 'tab',
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    paused: !!session.paused,
    suspendedOrigin: session.suspendedOrigin || null,
    pendingAction: session.pendingAction || null
  };
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('找不到当前标签页');
  return tab;
}

function assertAllowedUrl(url = '') {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('当前页面不是可授权的 http/https 网页（chrome://、扩展页和本地特殊页不能直接授权）');
  }
}

function isHwcrUrl(value = '') {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'm.hwcr.vip' || host.endsWith('.hwcr.vip');
  } catch {
    return false;
  }
}


async function ensureHwcrPreloadRegistered() {
  const hostPermission = await chrome.permissions.contains({ origins: BROWSER_HOST_ORIGINS });
  if (!hostPermission) return { registered: false, reason: 'host_permission_missing' };
  const desired = {
    id: HWCR_PRELOAD_SCRIPT_ID,
    matches: HWCR_PRELOAD_MATCHES,
    js: ['hwcr_preload.js'],
    runAt: 'document_start',
    world: 'MAIN',
    persistAcrossSessions: true
  };
  const current = await chrome.scripting.getRegisteredContentScripts({ ids: [HWCR_PRELOAD_SCRIPT_ID] }).catch(() => []);
  if (current?.length) {
    await chrome.scripting.updateContentScripts([desired]);
    return { registered: true, updated: true };
  }
  await chrome.scripting.registerContentScripts([desired]);
  return { registered: true, updated: false };
}

async function unregisterHwcrPreload() {
  const current = await chrome.scripting.getRegisteredContentScripts({ ids: [HWCR_PRELOAD_SCRIPT_ID] }).catch(() => []);
  if (!current?.length) return { registered: false };
  await chrome.scripting.unregisterContentScripts({ ids: [HWCR_PRELOAD_SCRIPT_ID] });
  return { registered: false };
}

function readHwcrPreloadBridge() {
  const host = String(location.hostname || '').toLowerCase();
  if (!(host === 'm.hwcr.vip' || host.endsWith('.hwcr.vip'))) {
    return { installed: false, records: [], diagnostics: { status: 'not_ready', error: null, preload_status: 'wrong_host' } };
  }
  const bridge = window.__penguinHwcrConvenienceBridgeV1;
  if (!bridge || typeof bridge.snapshot !== 'function') {
    return { installed: false, records: [], diagnostics: { status: 'not_ready', error: null, preload_status: 'missing' } };
  }
  try {
    const records = Array.isArray(bridge.snapshot()) ? bridge.snapshot().slice(0, 400) : [];
    const diagnostics = typeof bridge.diagnosticsSnapshot === 'function'
      ? bridge.diagnosticsSnapshot()
      : { status: records.length ? 'ready' : 'no_data', error: null };
    return {
      installed: true,
      version: bridge.version || null,
      records,
      diagnostics: { ...diagnostics, preload_status: 'installed' }
    };
  } catch (error) {
    return {
      installed: true,
      version: bridge.version || null,
      records: [],
      diagnostics: {
        status: 'error',
        error: String(error?.message || error || 'HWCR preload bridge failed').slice(0, 500),
        preload_status: 'installed'
      }
    };
  }
}

function installHwcrFrontendBridge() {
  const host = String(location.hostname || '').toLowerCase();
  if (!(host === 'm.hwcr.vip' || host.endsWith('.hwcr.vip'))) {
    return { installed: false, records: [], diagnostics: { status: 'not_ready', error: null } };
  }

  const BRIDGE_KEY = '__penguinHwcrFrontendBridgeV3';
  const existing = window[BRIDGE_KEY];
  if (existing && typeof existing.snapshot === 'function') {
    try { existing.scanKnownState?.(); } catch {}
    return {
      installed: true,
      records: existing.snapshot(),
      diagnostics: existing.diagnosticsSnapshot?.() || { status: 'no_data', error: null }
    };
  }

  const MAX_RECORDS = 160;
  const MAX_DEPTH = 8;
  const MAX_NODES = 5000;
  const MAX_JSON_CHARS = 2_000_000;
  const records = new Map();
  let activePageUrl = location.href;
  let walkedNodes = 0;
  const diagnostics = {
    status: 'not_ready',
    vue_card_count: 0,
    vue_post_count: 0,
    state_scan_count: 0,
    response_capture_count: 0,
    last_error: null
  };

  const clean = (value, max = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const scalar = (value, max = 500) => {
    if (value == null) return '';
    if (Array.isArray(value)) {
      for (const item of value) {
        const candidate = scalar(item, max);
        if (candidate) return candidate;
      }
      return '';
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return clean(value, max);
    }
    return '';
  };
  const hash = (value) => {
    let result = 2166136261;
    for (const ch of String(value || '')) {
      result ^= ch.charCodeAt(0);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(16).padStart(8, '0');
  };
  const allowedUrl = (value) => {
    try {
      const parsed = new URL(value, location.href);
      const candidateHost = parsed.hostname.toLowerCase();
      return candidateHost === 'm.hwcr.vip' || candidateHost.endsWith('.hwcr.vip');
    } catch {
      return false;
    }
  };
  const normalizeUrl = (value) => {
    try {
      const parsed = new URL(value, location.href);
      parsed.hash = '';
      for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'from']) {
        parsed.searchParams.delete(key);
      }
      return parsed.href;
    } catch {
      return clean(value, 600);
    }
  };
  const inferCategory = (textValue, urlValue = '') => {
    const value = (String(textValue || '') + '\n' + String(urlValue || '')).toLowerCase();
    if (/求职|找工作|求工作|个人求职|应聘|job\s*seeker|looking\s+for\s+(a\s+)?job/.test(value)) return 'jobseeker';
    if (/房屋出租|房屋租赁|租房|出租房|房源|整租|合租|单间|公寓出租|店面出租|办公室出租|room\s+for\s+rent|for\s+rent|housing\s+rental/.test(value)) return 'housing_rental';
    if (/招聘|招工|诚聘|招聘职位|招聘岗位|招聘启事|请人|急聘|hiring|job\s+opening|recruitment/.test(value)) return 'recruitment';
    return null;
  };
  const pageCategory = () => inferCategory(document.title || '', location.href);
  const directValue = (obj, keys, max = 500) => {
    if (!obj || typeof obj !== 'object') return '';
    for (const key of keys) {
      try {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
        const candidate = scalar(obj[key], max);
        if (candidate) return candidate;
      } catch {}
    }
    return '';
  };
  const valueFrom = (obj, keys, max = 500, nested = false) => {
    const direct = directValue(obj, keys, max);
    if (direct || !nested) return direct;
    for (const containerKey of ['contact', 'contacts', 'contact_info', 'contactInfo']) {
      let container;
      try { container = obj?.[containerKey]; } catch { container = null; }
      if (Array.isArray(container)) container = container[0];
      const candidate = directValue(container, keys, max);
      if (candidate) return candidate;
    }
    return '';
  };
  const sourceIdFromUrl = (value) => {
    try {
      const parsed = new URL(value, location.href);
      for (const key of ['id', 'infoid', 'info_id', 'sid', 'postid', 'post_id', 'jobid', 'job_id', 'houseid', 'house_id']) {
        const candidate = parsed.searchParams.get(key);
        if (candidate && /^[A-Za-z0-9_-]{2,80}$/.test(candidate)) return candidate;
      }
      return parsed.pathname.match(/(?:^|\/)(\d{3,})(?:\.[a-z]+)?\/?$/i)?.[1] || '';
    } catch {
      return '';
    }
  };
  const ensurePage = () => {
    if (activePageUrl === location.href) return;
    activePageUrl = location.href;
    records.clear();
    diagnostics.status = 'not_ready';
    diagnostics.vue_card_count = 0;
    diagnostics.vue_post_count = 0;
    diagnostics.state_scan_count = 0;
    diagnostics.response_capture_count = 0;
    diagnostics.last_error = null;
  };


  const unwrapVueValue = (value) => {
    if (!value || typeof value !== 'object') return value;
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'value') && Object.keys(value).length <= 8) {
        const inner = value.value;
        if (inner && typeof inner === 'object') return inner;
      }
    } catch {}
    return value;
  };

  const postDataEntries = (obj) => {
    const result = [];
    const data = unwrapVueValue(obj?.data);
    if (!Array.isArray(data)) return result;
    for (const item of data.slice(0, 120)) {
      if (!item || typeof item !== 'object') continue;
      const name = clean(item.name ?? item.key ?? item.label ?? item.title, 120).replace(/[：:]\s*$/, '');
      const value = clean(item.value ?? item.val ?? item.content ?? item.text, 800);
      if (name && value) result.push({ name, value });
    }
    return result;
  };

  const postDataValue = (entries, names, max = 500) => {
    for (const entry of entries) {
      if (names.includes(entry.name)) return clean(entry.value, max);
    }
    for (const entry of entries) {
      if (names.some((name) => entry.name.includes(name))) return clean(entry.value, max);
    }
    return '';
  };

  const labeledContentValue = (content, names, max = 800) => {
    const raw = String(content || '');
    if (!raw) return '';
    for (const name of names) {
      const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const match = raw.match(new RegExp('(?:【\\s*' + escaped + '\\s*】|' + escaped + ')\\s*[:：]\\s*([^\\n\\r【]{1,800})', 'i'));
      if (match?.[1]) return clean(match[1], max);
    }
    return '';
  };

  const parseExplicitContact = (rawValue) => {
    const raw = clean(rawValue, 800);
    if (!raw || /^(联系超人|查看联系方式|点击查看|contact)$/i.test(raw)) {
      return { raw: '', phone: '', wechat: '', email: '' };
    }
    const phone = clean(raw.match(/(?:\+?1[\s.\-]?)?(?:\(?\d{3}\)?[\s.\-]?)\d{3}[\s.\-]?\d{4}/)?.[0] || '', 100);
    const email = clean(raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '', 180);
    let wechat = clean(raw.match(/(?:微信|wechat|weixin)\s*[:：]?\s*([A-Za-z][A-Za-z0-9_-]{5,30})/i)?.[1] || '', 120);
    if (!wechat && !phone && !email && /^[A-Za-z][A-Za-z0-9_-]{5,30}$/.test(raw)) wechat = raw;
    return { raw, phone, wechat, email };
  };

  const normalizePostContactFields = (obj, entries, body) => {
    const contactNames = ['联系方式', '联系电话', '电话', '手机', '微信', 'Wechat', 'WeChat', 'Weixin'];
    const rawPieces = [];
    for (const entry of entries) {
      if (contactNames.some((name) => entry.name === name || entry.name.includes(name))) rawPieces.push(entry.value);
    }
    const labeled = labeledContentValue(body, contactNames, 800);
    if (labeled) rawPieces.push(labeled);
    const directPhone = valueFrom(obj, ['contact_phone', 'contactPhone', 'phone', 'mobile', 'tel', 'telephone', 'phone_number', 'phoneNumber'], 100, true);
    const directWechat = valueFrom(obj, ['contact_wechat', 'contactWechat', 'wechat', 'weixin', 'wx', 'wechat_id', 'wechatId'], 120, true);
    const directEmail = valueFrom(obj, ['contact_email', 'contactEmail', 'email', 'mail', 'email_address', 'emailAddress'], 180, true);
    const contactRaw = clean([...new Set(rawPieces.map((value) => clean(value, 800)).filter(Boolean))].join(' | '), 1200);
    const parsed = parseExplicitContact(contactRaw);
    return {
      contact_raw: contactRaw || null,
      phone: directPhone || parsed.phone || '',
      wechat: directWechat || parsed.wechat || '',
      email: directEmail || parsed.email || ''
    };
  };

  const postObjectFromVueInstance = (instance) => {
    if (!instance || typeof instance !== 'object') return null;
    const candidates = [
      instance.props?.post,
      instance.setupState?.post,
      instance.ctx?.post,
      instance.data?.post,
      instance.proxy?.post,
      instance.vnode?.props?.post,
      instance.$props?.post,
      instance.$data?.post,
      instance.post
    ];
    for (const candidate of candidates) {
      const value = unwrapVueValue(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    }
    return null;
  };

  const scanVuePostCards = () => {
    ensurePage();
    const cards = [...document.querySelectorAll('article.post-card')].slice(0, 200);
    diagnostics.vue_card_count = cards.length;
    let found = 0;
    const seenPosts = new WeakSet();
    for (const card of cards) {
      const nodes = [card, card.parentElement, card.parentElement?.parentElement].filter(Boolean);
      let post = null;
      for (const node of nodes) {
        try {
          let instance = node.__vueParentComponent;
          for (let depth = 0; instance && depth < 6 && !post; depth += 1) {
            post = postObjectFromVueInstance(instance);
            instance = instance.parent;
          }
          if (!post) post = postObjectFromVueInstance(node.__vue__);
        } catch {}
        if (post) break;
      }
      if (!post || seenPosts.has(post)) continue;
      seenPosts.add(post);
      found += 1;
      absorb(post, location.href);
    }
    diagnostics.vue_post_count = found;
    return found;
  };


  const normalizeRecord = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

    const entries = postDataEntries(obj);
    const dataText = entries.map((entry) => entry.name + '：' + entry.value).join('\n');
    const rawBody = valueFrom(obj, ['content', 'body', 'description', 'desc', 'detail', 'text', 'job_description', 'jobDescription'], 4000);
    const title = valueFrom(obj, ['title', 'subject', 'job_title', 'jobTitle', 'position', 'position_name', 'positionName'], 240)
      || postDataValue(entries, ['招聘岗位', '岗位', '职位', '职位名称', '工作岗位', '求职意向', '标题'], 240);
    const description = postDataValue(entries, ['岗位描述', '职位描述', '工作内容', '描述', '详情', '要求'], 2400);
    const body = rawBody || description || dataText;
    let detailUrl = valueFrom(obj, ['detail_url', 'detailUrl', 'url', 'link', 'href'], 700);
    detailUrl = detailUrl ? normalizeUrl(detailUrl) : '';
    const sourceId = valueFrom(
      obj,
      ['source_id', 'sourceId', 'id', '_id', 'infoid', 'info_id', 'postid', 'post_id', 'jobid', 'job_id', 'article_id', 'articleId', 'tid', 'aid'],
      100
    ) || sourceIdFromUrl(detailUrl);

    const contacts = normalizePostContactFields(obj, entries, rawBody || body);
    const phone = contacts.phone;
    const wechat = contacts.wechat;
    const email = contacts.email;
    const city = valueFrom(
      obj,
      ['city', 'location', 'area', 'region', 'address', 'city_name', 'cityName', 'location_text'],
      240
    ) || postDataValue(entries, ['办公地点', '工作地点', '地点', '地址', '城市', '地区', '区域'], 240);
    const salary = valueFrom(obj, ['salary', 'salary_text', 'salaryText', 'price', 'wage'], 180)
      || postDataValue(entries, ['薪资待遇', '薪资', '工资', '待遇'], 180);
    const time = valueFrom(
      obj,
      ['time', 'date', 'created_at', 'createdAt', 'create_time', 'createTime', 'publish_time', 'publishTime', 'published_at', 'publishedAt', 'updated_at', 'updatedAt'],
      160
    );

    const combined = clean(title + '\n' + dataText + '\n' + body, 5200);
    const category = inferCategory(combined, detailUrl) || pageCategory() || (entries.length ? 'work_unknown' : null);
    const hasContact = !!(contacts.contact_raw || phone || wechat || email);
    const hasPostIdentity = !!(sourceId || detailUrl);
    const hasPostContent = !!title || body.length >= 12 || entries.length >= 2;
    if (!category || (!hasPostIdentity && !hasPostContent)) return null;

    const key = sourceId
      ? 'id:' + sourceId
      : (detailUrl ? 'url:' + detailUrl : 'hash:' + hash(category + '|' + title + '|' + city + '|' + body.slice(0, 500)));
    return {
      key,
      source_id: sourceId || null,
      category,
      title,
      body,
      detail_url: detailUrl || null,
      contact_raw: contacts.contact_raw,
      contact_phone: phone || null,
      contact_wechat: wechat || null,
      contact_email: email || null,
      city: city || null,
      salary: salary || null,
      time: time || null,
      contact_source: hasContact ? 'frontend_data' : null
    };
  };

  const scanKnownState = () => {
    ensurePage();
    diagnostics.last_error = null;
    diagnostics.state_scan_count = 0;
    diagnostics.response_capture_count = 0;
    try {
      scanVuePostCards();
    } catch (error) {
      diagnostics.last_error = clean(error?.message || error, 500);
    }
    diagnostics.status = records.size ? 'ready' : (diagnostics.last_error ? 'error' : 'no_data');
  };

  const diagnosticsSnapshot = () => {
    ensurePage();
    const status = records.size ? 'ready' : (diagnostics.last_error ? 'error' : diagnostics.status || 'not_ready');
    return {
      status,
      error: diagnostics.last_error || null,
      vue_card_count: diagnostics.vue_card_count,
      vue_post_count: diagnostics.vue_post_count,
      state_scan_count: 0,
      response_capture_count: 0,
      fallback_scope: 'vue_post_cards_only'
    };
  };

  const snapshot = () => {
    ensurePage();
    return [...records.values()].slice(0, MAX_RECORDS).map((record) => ({ ...record }));
  };

  window[BRIDGE_KEY] = {
    version: '0.4.10',
    scanKnownState,
    snapshot,
    diagnosticsSnapshot
  };
  scanKnownState();
  return { installed: true, records: snapshot(), diagnostics: diagnosticsSnapshot() };
}

async function collectHwcrFrontendRecords(tabId, url = '') {
  if (!isHwcrUrl(url)) return { records: [], diagnostics: { status: 'not_ready', error: null, preload_status: 'wrong_host' } };

  let preloadResult = null;
  try {
    const preloadExecution = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: readHwcrPreloadBridge
    });
    preloadResult = preloadExecution?.[0]?.result || null;
  } catch (error) {
    preloadResult = {
      installed: false,
      records: [],
      diagnostics: {
        status: 'error',
        error: String(error?.message || error || 'HWCR preload read failed').slice(0, 500),
        preload_status: 'read_error'
      }
    };
  }

  const preloadRecords = Array.isArray(preloadResult?.records) ? preloadResult.records.slice(0, 400) : [];
  const preloadDiagnostics = preloadResult?.diagnostics && typeof preloadResult.diagnostics === 'object'
    ? { ...preloadResult.diagnostics }
    : { status: preloadRecords.length ? 'ready' : 'not_ready', error: null, preload_status: preloadResult?.installed ? 'installed' : 'missing' };

  if (preloadRecords.length) {
    return {
      records: preloadRecords,
      diagnostics: {
        ...preloadDiagnostics,
        bridge_source: 'convenience_list_preload',
        preload_version: preloadResult?.version || null
      }
    };
  }

  const fallbackExecution = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: installHwcrFrontendBridge
  });
  const fallbackResult = fallbackExecution?.[0]?.result;
  const fallbackRecords = Array.isArray(fallbackResult?.records) ? fallbackResult.records.slice(0, 200) : [];
  const fallbackDiagnostics = fallbackResult?.diagnostics && typeof fallbackResult.diagnostics === 'object'
    ? { ...fallbackResult.diagnostics }
    : { status: fallbackRecords.length ? 'ready' : 'no_data', error: null };

  return {
    records: fallbackRecords,
    diagnostics: {
      ...fallbackDiagnostics,
      bridge_source: fallbackRecords.length ? 'vue_fallback' : 'none',
      preload_status: preloadDiagnostics.preload_status || (preloadResult?.installed ? 'installed' : 'missing'),
      preload_status_detail: preloadDiagnostics.status || null,
      preload_error: preloadDiagnostics.error || null
    }
  };
}

async function injectAgent(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    await injectAgent(tabId);
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

function assertContentResponse(response) {
  if (!response) throw new Error('CONTENT_BRIDGE_NO_RESPONSE: 页面脚本没有返回结果');
  if (response.ok === false && !response.confirmationRequired) {
    throw new Error(response.error || 'CONTENT_BRIDGE_ERROR');
  }
  return response;
}

async function syncSessionToTab(session) {
  if (!session) throw new Error('当前标签页尚未授权');
  await injectAgent(session.tabId).catch(() => {});
  const response = await sendToTab(session.tabId, {
    type: 'PENGUIN_SESSION_STATE',
    authorized: true,
    mode: session.mode,
    scope: session.scope === 'browser' ? 'browser' : 'tab',
    session: {
      origin: session.origin,
      expiresAt: session.expiresAt,
      scope: session.scope === 'browser' ? 'browser' : 'tab'
    }
  });
  assertContentResponse(response);
  return session;
}

async function ensureBrowserSessionForTab(tabOrId, sync = true) {
  await restoreBrowserGrantOnce();
  if (!browserGrant) return null;
  const tab = typeof tabOrId === 'number' ? await chrome.tabs.get(tabOrId) : tabOrId;
  if (!tab?.id || !tab?.url || !/^https?:\/\//i.test(tab.url)) return null;
  const origin = new URL(tab.url).origin;
  const existing = sessions.get(tab.id);
  const session = existing?.scope === 'browser' ? existing : {
    tabId: tab.id,
    origin,
    url: tab.url,
    title: tab.title || '',
    mode: browserGrant.mode,
    scope: 'browser',
    createdAt: browserGrant.createdAt,
    expiresAt: 0,
    paused: !!browserGrant.paused,
    suspendedOrigin: null,
    pendingAction: null
  };
  session.origin = origin;
  session.url = tab.url;
  session.title = tab.title || session.title || '';
  session.mode = browserGrant.mode;
  session.scope = 'browser';
  session.createdAt = browserGrant.createdAt;
  session.expiresAt = 0;
  session.paused = !!browserGrant.paused;
  session.suspendedOrigin = null;
  sessions.set(tab.id, session);
  await persistSessions().catch(() => {});
  if (sync && tab.status === 'complete') await syncSessionToTab(session).catch(() => {});
  return session;
}

async function authorizeBrowserSession(mode = 'view') {
  if (!['view', 'interact'].includes(mode)) throw new Error('无效授权模式');
  const hostPermission = await chrome.permissions.contains({ origins: BROWSER_HOST_ORIGINS });
  if (!hostPermission) {
    throw new Error('BROWSER_SCOPE_HOST_PERMISSION_REQUIRED: 请先允许企鹅助理访问普通网站，再启用当前浏览器会话授权');
  }
  browserGrant = { scope: 'browser', mode, createdAt: now(), paused: false };
  browserGrantRestored = true;
  await persistBrowserGrant();
  await ensureHwcrPreloadRegistered().catch(() => {});

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab?.url || !/^https?:\/\//i.test(tab.url)) continue;
    await ensureBrowserSessionForTab(tab, true).catch(() => {});
  }
  await persistSessions().catch(() => {});
  const tab = await currentTab();
  const session = await ensureBrowserSessionForTab(tab, true);
  if (!session) throw new Error('当前页面不是可授权的 http/https 网页');
  ensureBridgeReconnectAlarm().catch(() => {});
ensureBridgeConnection().catch(() => {});
  return publicSession(session);
}

async function authorizeCurrentTab(mode = 'view', scope = 'tab') {
  if (scope === 'browser') return await authorizeBrowserSession(mode);
  const tab = await currentTab();
  assertAllowedUrl(tab.url || '');
  if (!['view', 'interact'].includes(mode)) throw new Error('无效授权模式');
  await injectAgent(tab.id);
  const url = new URL(tab.url);
  const session = {
    tabId: tab.id,
    origin: url.origin,
    url: tab.url,
    title: tab.title || '',
    mode,
    scope: 'tab',
    createdAt: now(),
    expiresAt: 0,
    paused: false,
    suspendedOrigin: null,
    pendingAction: null
  };
  sessions.set(tab.id, session);
  await persistSessions();
  await sendToTab(tab.id, { type: 'PENGUIN_SESSION_STATE', authorized: true, mode, scope: 'tab' });
  ensureBridgeConnection().catch(() => {});
  return publicSession(session);
}

async function revoke(tabId) {
  const id = tabId || (await currentTab()).id;
  sessions.delete(id);
  await persistSessions().catch(() => {});
  try { await sendToTab(id, { type: 'PENGUIN_SESSION_STATE', authorized: false }); } catch {}
  return { ok: true };
}

async function revokeBrowserSession() {
  await restoreSessionsOnce();
  const browserTabIds = [...sessions.values()]
    .filter((session) => session.scope === 'browser')
    .map((session) => session.tabId);
  for (const tabId of browserTabIds) {
    sessions.delete(tabId);
    try { await sendToTab(tabId, { type: 'PENGUIN_SESSION_STATE', authorized: false }); } catch {}
  }
  browserGrant = null;
  browserGrantRestored = true;
  await persistBrowserGrant().catch(() => {});
  await persistSessions().catch(() => {});
  await unregisterHwcrPreload().catch(() => {});
  await chrome.permissions.remove({ origins: BROWSER_HOST_ORIGINS }).catch(() => false);
  return { ok: true, scope: 'browser', revoked_tabs: browserTabIds.length };
}

async function getSession(tabId) {
  await restoreSessionsOnce();
  const id = tabId || (await currentTab()).id;
  let session = sessions.get(id);
  if (session?.scope === 'browser') {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab?.url || !/^https?:\/\//i.test(tab.url)) {
      sessions.delete(id);
      await persistSessions().catch(() => {});
      return null;
    }
  }
  if (!session && browserGrant) {
    session = await ensureBrowserSessionForTab(id, true).catch(() => null);
  }
  if (!session) return null;
  return session;
}

function requireSession(session, requireInteract = false) {
  if (!session) throw new Error('当前标签页尚未授权');
  if (session.paused) throw new Error('当前标签页授权已暂停');
  if (requireInteract && session.mode !== 'interact') throw new Error('当前授权为仅查看模式，不能操作网页');
}

function commandNeedsInteract(command) {
  return ['click', 'clickPoint', 'fill', 'select', 'scroll', 'highlight', 'key', 'terminal_input', 'sequence'].includes(command?.action);
}

async function executeCommand(command, tabId) {
  const session = await getSession(tabId);
  requireSession(session, commandNeedsInteract(command));
  const tab = await chrome.tabs.get(session.tabId);
  const currentOrigin = new URL(tab.url).origin;
  if (currentOrigin !== session.origin) {
    session.url = tab.url;
    session.title = tab.title || session.title;
    if (session.scope === 'browser') {
      session.origin = currentOrigin;
      session.suspendedOrigin = null;
      await persistSessions().catch(() => {});
    } else {
      session.suspendedOrigin = currentOrigin;
      await persistSessions().catch(() => {});
      throw new Error(`CROSS_ORIGIN_SUSPENDED: 当前页面已进入 ${currentOrigin}，原 ${session.origin} 授权已暂停；当前是单标签页授权，返回原网站后自动恢复。`);
    }
  }
  session.suspendedOrigin = null;
  session.url = tab.url;
  session.title = tab.title || session.title;
  await syncSessionToTab(session);

  if (['snapshot', 'read'].includes(command?.action) && isHwcrUrl(tab.url || session.url || '')) {
    let frontendPayload;
    try {
      frontendPayload = await collectHwcrFrontendRecords(session.tabId, tab.url || session.url || '');
    } catch (error) {
      frontendPayload = {
        records: [],
        diagnostics: {
          status: 'error',
          error: String(error?.message || error || 'HWCR bridge failed').slice(0, 500)
        }
      };
    }
    await sendToTab(session.tabId, {
      type: 'PENGUIN_HWCR_FRONTEND_DATA',
      records: frontendPayload.records,
      diagnostics: frontendPayload.diagnostics
    }).catch(() => {});
  }

  const response = assertContentResponse(await sendToTab(session.tabId, { type: 'PENGUIN_COMMAND', command }));
  if (response?.confirmationRequired) {
    session.pendingAction = {
      token: crypto.randomUUID(),
      createdAt: now(),
      summary: response.summary,
      command
    };
    return { ok: false, confirmationRequired: true, pendingAction: session.pendingAction };
  }
  return response;
}

async function confirmPending(tabId, token) {
  const session = await getSession(tabId);
  requireSession(session, true);
  if (!session.pendingAction || session.pendingAction.token !== token) {
    throw new Error('确认请求不存在或已失效');
  }
  if (now() - session.pendingAction.createdAt > 2 * 60 * 1000) {
    session.pendingAction = null;
    throw new Error('确认请求已过期');
  }
  const command = { ...session.pendingAction.command, confirmed: true };
  session.pendingAction = null;
  return await executeCommand(command, session.tabId);
}

async function storageGet(keys) { return await chrome.storage.local.get(keys); }
async function storageSet(values) { await chrome.storage.local.set(values); }
async function storageRemove(keys) { await chrome.storage.local.remove(keys); }

async function bridgeFetch(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
  try {
    const response = await fetch(`${BRIDGE_BASE}${path}`, {
      method: options.method || 'GET',
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
      signal: controller.signal
    });
    let data = {};
    try { data = await response.json(); } catch {}
    return { status: response.status, ok: response.ok, data };
  } finally {
    clearTimeout(timeout);
  }
}

function pairingResponseMessage(response) {
  return String(response?.data?.error || response?.data?.message || '').trim();
}

function pairingResponseWasExplicitlyDenied(response) {
  if (Number(response?.status || 0) !== 403) return false;
  return /拒绝|不同意|denied|declined|rejected|user[ _-]?denied|approval[ _-]?denied/i.test(pairingResponseMessage(response));
}

function pairingChoiceRequiresManualAction(choice) {
  if (!choice || choice === true) return false;
  if (typeof choice !== 'object') return false;
  return choice.reason === 'user_denied';
}

async function clearBridgePairing(error = null, requireUserAction = false) {
  await storageRemove(['bridgeToken', 'bridgeRefreshToken', 'bridgeClientId', 'pairingRequestId', 'pairingSecret']);
  if (requireUserAction) {
    await storageSet({
      [BRIDGE_PAIRING_USER_ACTION_KEY]: {
        version: 2,
        reason: 'user_denied',
        error: String(error || '').slice(0, 500),
        created_at: now()
      }
    });
  } else {
    await storageRemove([BRIDGE_PAIRING_USER_ACTION_KEY]);
  }
  bridgeState = {
    connected: false,
    pairingState: 'unpaired',
    lastError: error,
    clientId: null,
    bridgeVersion: bridgeState.bridgeVersion,
    polling: false,
    lastSeenAt: null
  };
}

async function savePaired(result) {
  if (!result?.token || !result?.refresh_token || !result?.client_id) {
    throw new Error('Connector 未返回完整的配对凭据');
  }
  await storageSet({ bridgeToken: result.token, bridgeRefreshToken: result.refresh_token, bridgeClientId: result.client_id });
  await storageRemove(['pairingRequestId', 'pairingSecret', BRIDGE_PAIRING_USER_ACTION_KEY]);
  bridgeState = {
    connected: true,
    pairingState: 'paired',
    lastError: null,
    clientId: result.client_id,
    bridgeVersion: result.bridge_version || bridgeState.bridgeVersion,
    polling: true,
    lastSeenAt: now()
  };
  startBridgeLoop().catch(() => {});
}

function pairingBody(extra = {}) {
  const manifest = chrome.runtime.getManifest();
  return {
    pairing_mode: 'async',
    app_id: APP_ID,
    app_name: 'Chrome / Edge 当前浏览器',
    app_version: navigator.userAgent || '',
    adapter_id: ADAPTER_ID,
    adapter_name: '企鹅助理浏览器扩展',
    adapter_version: manifest.version,
    platform: 'chromium-extension',
    driver_kind: 'browser_extension',
    priority: 200,
    capabilities: BRIDGE_CAPABILITIES,
    ...extra
  };
}

async function startPairingLoop() {
  if (pairingLoopRunning) return;
  pairingLoopRunning = true;
  try {
    while (true) {
      const saved = await storageGet(['pairingRequestId', 'pairingSecret']);
      if (!saved.pairingRequestId || !saved.pairingSecret) return;
      bridgeState.pairingState = 'pending_approval';
      const response = await bridgeFetch('/v1/pair', {
        method: 'POST',
        body: pairingBody({ request_id: saved.pairingRequestId, pairing_secret: saved.pairingSecret }),
        timeoutMs: 8000
      });
      if (response.status === 200 && response.data?.token) {
        await savePaired(response.data);
        return;
      }
      if (response.status === 202) {
        await sleep(Math.max(800, Number(response.data?.retry_after_seconds || 1) * 1000));
        continue;
      }
      if ([403, 404, 408, 409].includes(response.status)) {
        const explicitlyDenied = pairingResponseWasExplicitlyDenied(response);
        await clearBridgePairing(
          response.data?.error || `配对失败 (${response.status})`,
          explicitlyDenied
        );
        if (!explicitlyDenied) {
          setTimeout(() => ensureBridgeConnection().catch(() => {}), 0);
        }
        return;
      }
      bridgeState.lastError = response.data?.error || `Connector 配对响应异常 (${response.status})`;
      await sleep(1500);
    }
  } catch (error) {
    bridgeState.lastError = String(error?.message || error);
  } finally {
    pairingLoopRunning = false;
  }
}

async function beginPairing() {
  const response = await bridgeFetch('/v1/pair', { method: 'POST', body: pairingBody(), timeoutMs: 8000 });
  bridgeState.bridgeVersion = response.data?.bridge_version || bridgeState.bridgeVersion;
  if (response.status === 200 && response.data?.token) {
    await savePaired(response.data);
    return bridgeState;
  }
  if (response.status === 202) {
    if (!response.data?.request_id) throw new Error('Connector 未返回配对请求 ID');
    if (!response.data?.pairing_secret) {
      bridgeState.pairingState = 'pending_approval';
      bridgeState.lastError = 'Connector 中已有旧的待确认配对请求；请先在 Connector 中允许/拒绝该请求，或等待其过期后重试。';
      return bridgeState;
    }
    await storageSet({ pairingRequestId: response.data.request_id, pairingSecret: response.data.pairing_secret });
    bridgeState.pairingState = 'pending_approval';
    bridgeState.lastError = null;
    startPairingLoop().catch(() => {});
    return bridgeState;
  }
  throw new Error(response.data?.error || `无法发起 Connector 配对 (${response.status})`);
}

async function browserRuntimeTelemetry() {
  await restoreSessionsOnce();
  const hostPermission = await chrome.permissions.contains({ origins: BROWSER_HOST_ORIGINS });
  const tabsPermission = await chrome.permissions.contains({ permissions: ['tabs'] });
  const broadGrant = !!(browserGrant && !browserGrant.paused && hostPermission);
  const authorized = [...sessions.values()]
    .filter((session) => session && !session.paused && !session.suspendedOrigin)
    .sort((left, right) => Number(left.tabId) - Number(right.tabId));
  const current = await currentTab().catch(() => null);
  const active = authorized.find((session) => Number(session.tabId) === Number(current?.id));
  const revisionInput = JSON.stringify({
    browser: browserGrant ? [browserGrant.createdAt, browserGrant.mode, !!browserGrant.paused, hostPermission] : null,
    tabs: [...sessions.values()].sort((left, right) => Number(left.tabId) - Number(right.tabId))
      .map((session) => [session.tabId, session.origin, session.mode, session.scope,
        session.createdAt, !!session.paused, session.suspendedOrigin || null])
  });
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(revisionInput)));
  const revision = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
  return {
    runtime_permissions: {
      dom: authorized.length > 0 || broadGrant,
      navigation: authorized.length > 0 || broadGrant,
      screenshot: authorized.length > 0 || broadGrant,
      click: authorized.some((session) => session.mode === 'interact') || !!(broadGrant && browserGrant.mode === 'interact'),
      tabs: !!tabsPermission
    },
    runtime_grants: {
      active_tab_granted: !!active,
      all_urls_granted: broadGrant,
      authorized_tabs: authorized.slice(0, 64).map((session) => String(session.tabId)),
      screenshot_authorized_tabs: authorized.slice(0, 64).map((session) => String(session.tabId)),
      screenshot_permission_source: broadGrant ? 'host_permission' : (authorized.length ? 'activeTab' : 'none'),
      authorization_revision: revision,
      grant_revision: revision,
      authorization_source: 'extension_heartbeat',
      browser_session_id: bridgeState.clientId || 'extension',
      tab_id: active ? String(active.tabId) : 'active'
    }
  };
}

async function heartbeat(token) {
  // Diagnostic grant facts are derived from the extension's own session
  // ledger. Never send URLs, page text, cookies or pairing credentials.
  const telemetry = await browserRuntimeTelemetry().catch(() => null);
  const response = await bridgeFetch('/v1/heartbeat', {
    method: 'POST',
    token,
    body: {
      app_version: navigator.userAgent || '',
      adapter_version: chrome.runtime.getManifest().version,
      capabilities: BRIDGE_CAPABILITIES,
      ...(telemetry || {})
    },
    timeoutMs: 7000
  });
  if (response.status === 401) {
    // Keep the refresh proof until the caller has attempted renewal.
    return false;
  }
  if (!response.ok) throw new Error(response.data?.error || `heartbeat ${response.status}`);
  bridgeState.connected = true;
  bridgeState.pairingState = 'paired';
  bridgeState.clientId = response.data?.client_id || bridgeState.clientId;
  bridgeState.lastError = null;
  bridgeState.lastSeenAt = now();
  return true;
}

async function renewBridgePairing(saved) {
  if (!saved?.bridgeRefreshToken || !saved?.bridgeClientId) return false;
  const response = await bridgeFetch('/v1/pair', {
    method: 'POST',
    body: pairingBody({
      pairing_mode: 'renew',
      client_id: saved.bridgeClientId,
      refresh_token: saved.bridgeRefreshToken
    }),
    timeoutMs: 8000
  });
  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok) throw new Error(response.data?.error || `Connector 续签失败 (${response.status})`);
  if (!response.data?.token || !response.data?.refresh_token || !response.data?.client_id) {
    throw new Error('Connector 续签响应缺少配对凭据');
  }
  await savePaired(response.data);
  return true;
}

async function activeAuthorizedSession(preferredTabId = null) {
  await restoreSessionsOnce();
  const hasExplicitTab = preferredTabId !== null && preferredTabId !== undefined && String(preferredTabId).trim() !== '';
  if (hasExplicitTab) {
    return await resolveAuthorizedSession(preferredTabId);
  }
  const current = await currentTab().catch(() => null);
  if (current?.id) {
    const currentSession = await getSession(current.id).catch(() => null);
    if (currentSession) return currentSession;
  }
  const valid = [];
  for (const [tabId] of sessions) {
    const session = await getSession(tabId);
    if (session) valid.push(session);
  }
  valid.sort((a, b) => b.createdAt - a.createdAt);
  if (!valid.length) throw new Error('CURRENT_TAB_NOT_AUTHORIZED: 请先授权当前标签页，或启用“当前浏览器会话”授权');
  return valid[0];
}

async function authorizedTabSummaries() {
  await restoreSessionsOnce();
  const current = await currentTab().catch(() => null);
  const output = [];
  for (const [tabId] of sessions) {
    const session = await getSession(tabId);
    if (!session) continue;
    try {
      const tab = await chrome.tabs.get(tabId);
      output.push({
        tab_id: tabId,
        title: tab.title || session.title || '',
        url: tab.url || session.url || '',
        active: !!tab.active,
        current: current?.id === tabId,
        window_id: tab.windowId,
        authorization_mode: session.mode,
        authorization_scope: session.scope === 'browser' ? 'browser' : 'tab',
        expires_at: session.expiresAt || null
      });
    } catch {}
  }
  output.sort((a, b) => Number(b.current) - Number(a.current) || Number(b.active) - Number(a.active) || a.tab_id - b.tab_id);
  return output;
}

async function resolveAuthorizedSession(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('TAB_ID_REQUIRED: 需要有效的已授权 tab_id');
  const session = await getSession(id);
  if (!session) throw new Error('TAB_NOT_AUTHORIZED: 只能操作用户已授权的标签页');
  return session;
}

function snapshotForConnector(snapshot, session) {
  const page = snapshot?.page || {};
  const allInteractive = page.elements || [];
  const ordered = [];
  const seenRefs = new Set();
  const add = (item) => {
    const ref = String(item?.ref || '');
    if (!ref || seenRefs.has(ref)) return;
    seenRefs.add(ref);
    ordered.push(item);
  };

  for (const item of allInteractive) if (item.focused && item.editable) add(item);
  for (const item of allInteractive) if (item.editable) add(item);
  for (const item of allInteractive) add(item);

  const interactive = ordered.slice(0, 120).map((item) => ({
    ref: item.ref,
    tag: item.tag || '',
    role: item.role || '',
    type: item.type || '',
    text: item.name || '',
    label: item.name || '',
    placeholder: item.placeholder || '',
    value: item.value ?? '',
    selected_label: item.selected_label || '',
    options: Array.isArray(item.options) ? item.options : [],
    editable: !!item.editable,
    focused: !!item.focused,
    adapter: item.adapter || null,
    terminal: !!item.terminal,
    terminal_output: item.terminal_output || '',
    disabled: !!item.disabled,
    href: item.href || '',
    bounds: item.bounds || null
  }));
  return {
    browser_open: true,
    channel: 'chrome-extension',
    tab_id: session.tabId,
    title: page.title || session.title || '',
    url: page.url || session.url || '',
    page_revision: page.page_revision || null,
    page_generation: page.page_generation || null,
    frame_generation: page.frame_generation || 1,
    viewport: page.viewport || null,
    frames: page.frames || [],
    text: page.text || '',
    selection: page.selection || '',
    content: page.content || { text: page.text || '', media: page.media || [], headings: [] },
    task_region: page.task_region || null,
    visual: page.visual || { available: Array.isArray(page.media) && page.media.length > 0, refs: page.media || [], delivery: 'element_image_or_viewport_screenshot' },
    media: Array.isArray(page.media) ? page.media : [],
    media_count: Array.isArray(page.media) ? page.media.length : 0,
    interactive,
    interactive_count: interactive.length,
    interactive_total_count: allInteractive.length,
    interactive_truncated: allInteractive.length > interactive.length,
    harvest: page.harvest || null,
    harvest_record_count: Number(page.harvest?.record_count || 0),
    authorized: true,
    authorization_mode: session.mode,
    instruction: page.harvest
      ? "后续点击/输入使用 interactive 中的 ref；采集优先读取 harvest.records，并用 stable_key/source_id/detail_url 去重；翻页优先使用 harvest.navigation.next_ref，或按 can_scroll_more 增量滚动。当前标签页由用户显式授权。"
      : "后续点击/输入使用 interactive 中的 ref；可编辑控件优先返回。当前标签页由用户显式授权。"
  };
}

async function waitTabComplete(tabId, timeoutMs = 10000) {
  const started = now();
  while (now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return tab;
    await sleep(150);
  }
  return await chrome.tabs.get(tabId);
}

async function bridgeRead(session, maxChars = 9000) {
  let result = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const snap = await executeCommand({ action: 'snapshot' }, session.tabId);
    result = snapshotForConnector(snap, session);
    if (result.text || result.interactive_total_count > 0 || attempt === 5) break;
    await sleep(200 + attempt * 120);
  }
  result.text = String(result.text || '').slice(0, Math.max(1000, Math.min(Number(maxChars || 9000), 16000)));
  return result;
}

async function prepareCaptureTab(session) {
  const tab = await chrome.tabs.get(session.tabId);
  if (!tab.active) await chrome.tabs.update(session.tabId, { active: true });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await sleep(80);
  return await chrome.tabs.get(session.tabId);
}

function isScreenshotPermissionError(error) {
  const message = String(error?.message || error || '');
  return /activeTab|<all_urls>|permission|not been granted|cannot capture|may not be accessed/i.test(message);
}

async function captureVisibleTabForSession(session, tab, options = { format: 'png' }) {
  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, options);
  } catch (error) {
    if (isScreenshotPermissionError(error)) {
      throw new Error(
        'SCREENSHOT_PERMISSION_REQUIRED: Extension 截图需要 activeTab 或当前网站 Host Permission；' +
        '请在目标标签页打开企鹅助理并授权一次，或启用“当前浏览器会话”授权。'
      );
    }
    throw error;
  }
}

async function captureScreenshot(session, fullPage = false) {
  const tab = await prepareCaptureTab(session);
  const baseline = await bridgeRead(session, 1200);
  const viewport = baseline.viewport || {};
  if (!fullPage) {
    const imageDataUrl = await captureVisibleTabForSession(session, tab, { format: 'png' });
    return {
      browser_open: true,
      channel: 'chrome-extension',
      tab_id: session.tabId,
      url: baseline.url,
      title: baseline.title,
      page_revision: baseline.page_revision,
      viewport,
      image_data_url: imageDataUrl,
      full_page: false
    };
  }

  const viewportHeight = Math.max(1, Number(viewport.height || 1));
  const pageHeight = Math.max(viewportHeight, Number(viewport.scrollHeight || viewportHeight));
  const originalY = Math.max(0, Number(viewport.scrollY || 0));
  const maxTiles = 12;
  const positions = [];
  for (let y = 0; y < pageHeight && positions.length < maxTiles; y += viewportHeight) positions.push(y);
  const lastY = Math.max(0, pageHeight - viewportHeight);
  if (positions.length < maxTiles && positions[positions.length - 1] !== lastY) positions.push(lastY);
  const tiles = [];
  try {
    for (const y of positions) {
      await executeCommand({ action: 'scroll', y, absolute: true, behavior: 'instant' }, session.tabId);
      await sleep(70);
      const current = await bridgeRead(session, 400);
      const imageDataUrl = await captureVisibleTabForSession(session, tab, { format: 'png' });
      tiles.push({
        index: tiles.length,
        scroll_y: Number(current.viewport?.scrollY || y),
        page_revision: current.page_revision,
        viewport: current.viewport,
        image_data_url: imageDataUrl
      });
    }
  } finally {
    await executeCommand({ action: 'scroll', y: originalY, absolute: true, behavior: 'instant' }, session.tabId).catch(() => {});
  }
  return {
    browser_open: true,
    channel: 'chrome-extension',
    tab_id: session.tabId,
    url: baseline.url,
    title: baseline.title,
    page_revision: baseline.page_revision,
    viewport,
    full_page: positions.length * viewportHeight >= pageHeight,
    page_height: pageHeight,
    tile_count: tiles.length,
    truncated: positions.length >= maxTiles && positions[positions.length - 1] < lastY,
    tiles
  };
}

async function captureElementImage(session, args = {}) {
  const ref = String(args.target || args.ref || '').trim();
  if (!ref) throw new Error('BROWSER_ELEMENT_IMAGE_TARGET_REQUIRED: 请先读取页面并指定图像 ref');
  const probe = await executeCommand({
    action: 'elementImage',
    ref,
    expected_page_revision: args.expected_page_revision || args.page_revision || null,
    expected_page_generation: args.expected_page_generation || args.page_generation || null
  }, session.tabId);
  const baseline = await bridgeRead(session, 1000);
  const maxBytes = Math.max(64 * 1024, Math.min(Number(args.image_max_bytes || 4 * 1024 * 1024), 8 * 1024 * 1024));
  if (probe?.image_data_url) {
    const encoded = String(probe.image_data_url).split(',', 2)[1] || '';
    const bytes = Math.floor(encoded.length * 3 / 4);
    if (bytes > maxBytes) throw new Error(`BROWSER_IMAGE_TOO_LARGE: ${bytes} > ${maxBytes}`);
    return {
      browser_open: true, channel: 'chrome-extension', operation: 'element_image', target: ref,
      tab_id: session.tabId, url: baseline.url, title: baseline.title, page_revision: baseline.page_revision,
      page_generation: baseline.page_generation || null, frame_id: 'main', image_data_url: probe.image_data_url,
      image_delivery: 'element', image_bytes: bytes, metadata: probe.metadata || {}, verified: true
    };
  }
  const tab = await prepareCaptureTab(session);
  const imageDataUrl = await captureVisibleTabForSession(session, tab, { format: 'png' });
  const encoded = String(imageDataUrl).split(',', 2)[1] || '';
  const bytes = Math.floor(encoded.length * 3 / 4);
  if (bytes > maxBytes) throw new Error(`BROWSER_IMAGE_TOO_LARGE: ${bytes} > ${maxBytes}`);
  return {
    browser_open: true, channel: 'chrome-extension', operation: 'element_image', target: ref,
    tab_id: session.tabId, url: baseline.url, title: baseline.title, page_revision: baseline.page_revision,
    page_generation: baseline.page_generation || null, frame_id: 'main', image_data_url: imageDataUrl,
    image_delivery: 'viewport_capture', image_bounds: probe.metadata?.bounds || null,
    image_bytes: bytes, metadata: probe.metadata || {}, verified: true,
    visual_note: '元素图像无法直接提取，已返回当前可见视口截图及目标 bounds。'
  };
}

async function waitDownload(downloadId, timeoutMs = 20000) {
  const started = now();
  let last = null;
  while (now() - started < timeoutMs) {
    const items = await chrome.downloads.search({ id: downloadId });
    last = items?.[0] || null;
    if (!last) break;
    if (last.state === 'complete' || last.state === 'interrupted') break;
    await sleep(200);
  }
  if (!last) {
    return { download_id: downloadId, state: 'unknown', verified: false };
  }
  return {
    download_id: downloadId,
    state: last.state || 'unknown',
    verified: last.state === 'complete',
    filename: last.filename || null,
    url: last.finalUrl || last.url || null,
    mime: last.mime || null,
    bytes_received: Number(last.bytesReceived || 0),
    total_bytes: Number(last.totalBytes || 0),
    error: last.error || null,
    paused: !!last.paused,
    danger: last.danger || null
  };
}

function bookmarkSummary(node) {
  return {
    bookmark_id: String(node?.id || ''),
    parent_id: node?.parentId ? String(node.parentId) : null,
    title: String(node?.title || ''),
    url: node?.url || null,
    type: node?.url ? 'bookmark' : 'folder',
    date_added: node?.dateAdded || null
  };
}

function flattenBookmarkTree(nodes, output = []) {
  for (const node of nodes || []) {
    output.push(bookmarkSummary(node));
    if (Array.isArray(node.children)) flattenBookmarkTree(node.children, output);
  }
  return output;
}

async function listBookmarks(limit = 200, includeFolders = false) {
  const tree = await chrome.bookmarks.getTree();
  const max = Math.max(1, Math.min(Number(limit || 200), 500));
  const items = flattenBookmarkTree(tree).filter((item) => includeFolders || !!item.url).slice(0, max);
  return { bookmarks: items, bookmark_count: items.length, truncated: items.length >= max };
}

async function searchBookmarks(query, limit = 50, includeFolders = false) {
  const q = String(query || '').trim();
  if (!q) throw new Error('BOOKMARK_QUERY_REQUIRED: 需要书签名称或 URL 关键字');
  const max = Math.max(1, Math.min(Number(limit || 50), 200));
  const raw = await chrome.bookmarks.search(q);
  const items = (raw || []).map(bookmarkSummary).filter((item) => includeFolders || !!item.url).slice(0, max);
  return { query: q, bookmarks: items, bookmark_count: items.length, truncated: items.length >= max };
}

async function resolveBookmark(args = {}) {
  const bookmarkId = String(args.bookmark_id || '').trim();
  if (bookmarkId) {
    const found = await chrome.bookmarks.get(bookmarkId);
    const node = found?.[0];
    if (!node?.url) throw new Error('BOOKMARK_NOT_OPENABLE: 指定书签不存在或不是网页书签');
    return node;
  }
  const q = String(args.query || args.value || args.title || '').trim();
  if (!q) throw new Error('BOOKMARK_QUERY_REQUIRED: bookmark_open 需要 bookmark_id 或 query');
  const found = (await chrome.bookmarks.search(q)).filter((node) => !!node.url);
  if (!found.length) throw new Error(`BOOKMARK_NOT_FOUND: 未找到书签 ${q}`);
  const needle = q.toLocaleLowerCase();
  return found.find((node) => String(node.title || '').toLocaleLowerCase() === needle)
    || found.find((node) => String(node.title || '').toLocaleLowerCase().includes(needle))
    || found[0];
}

async function openBookmark(args = {}) {
  const node = await resolveBookmark(args);
  assertAllowedUrl(node.url || '');
  let tab;
  if (args.new_tab === false) {
    const current = await currentTab();
    tab = await chrome.tabs.update(current.id, { url: node.url, active: true });
  } else {
    tab = await chrome.tabs.create({ url: node.url, active: args.active !== false });
  }
  await waitTabComplete(tab.id);
  const opened = await chrome.tabs.get(tab.id);
  const existingSession = await getSession(tab.id).catch(() => null);
  return {
    ok: true,
    browser_open: true,
    channel: 'chrome-extension',
    bookmark: bookmarkSummary(node),
    opened_tab_id: tab.id,
    title: opened.title || node.title || '',
    url: opened.url || node.url,
    authorized: !!existingSession && !existingSession.suspendedOrigin,
    authorization_mode: existingSession?.mode || null,
    reauthorization_required: !existingSession || !!existingSession.suspendedOrigin,
    instruction: existingSession && !existingSession.suspendedOrigin
      ? '书签已打开，目标标签页已具有有效的同站授权。'
      : '书签已打开；如需读取或操作目标网页，请在该标签页对企鹅助理执行一次“查看 + 操作”授权。'
  };
}

async function handleBridgeTask(task) {
  const operation = String(task?.operation || '').toLowerCase();
  const args = task?.args || {};
  const explicitTabId = args.tab_id ?? args.target_tab_id ?? task?.tab_id ?? task?.target_tab_id ?? null;

  if (operation === 'tab_list') {
    const tabs = await authorizedTabSummaries();
    if (!tabs.length) throw new Error('CURRENT_TAB_NOT_AUTHORIZED: 请先在企鹅助理扩展中授权至少一个标签页');
    return { browser_open: true, channel: 'chrome-extension', tabs, tab_count: tabs.length };
  }
  if (operation === 'tab_batch') {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    if (!steps.length || steps.length > 16) throw new Error('TAB_BATCH_INVALID: 1-16 steps required');
    const results = [];
    for (const step of steps) {
      const stepOperation = String(step?.operation || step?.action || '').toLowerCase();
      if (!['tab_list', 'tab_switch', 'tab_close'].includes(stepOperation)) {
        throw new Error(`TAB_BATCH_UNSUPPORTED_OPERATION:${stepOperation}`);
      }
      if (stepOperation === 'tab_list') {
        results.push({ operation: stepOperation, tabs: await authorizedTabSummaries() });
        continue;
      }
      const target = await resolveAuthorizedSession(step.target_tab_id || step.target || step.tab_id);
      if (stepOperation === 'tab_switch') {
        const tab = await chrome.tabs.get(target.tabId);
        await chrome.tabs.update(target.tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        await syncSessionToTab(target);
        results.push({ operation: stepOperation, tab_id: target.tabId, switched: true });
        continue;
      }
      sessions.delete(target.tabId);
      await persistSessions().catch(() => {});
      await chrome.tabs.remove(target.tabId);
      results.push({ operation: stepOperation, tab_id: target.tabId, closed: true });
    }
    return {
      browser_open: true,
      channel: 'chrome-extension',
      results,
      tabs: await authorizedTabSummaries(),
      tab_count: (await authorizedTabSummaries()).length
    };
  }
  if (operation === 'webmcp_discover') {
    const session = await activeAuthorizedSession(explicitTabId);
    const injected = await chrome.scripting.executeScript({
      target: { tabId: session.tabId },
      func: () => {
        const context = globalThis.navigator?.modelContext || globalThis.modelContext || null;
        const tools = context?.tools || globalThis.__webmcpTools || [];
        if (!Array.isArray(tools)) return { available: false, tools: [] };
        return {
          available: true,
          tools: tools.map((tool) => ({
            name: String(tool?.name || tool?.id || ''),
            description: String(tool?.description || '').slice(0, 1000),
            inputSchema: tool?.inputSchema || tool?.schema || null,
            read_only: tool?.readOnly === true || tool?.read_only === true
          })).filter((tool) => tool.name)
        };
      }
    });
    const value = injected?.[0]?.result || { available: false, tools: [] };
    return {
      browser_open: true,
      channel: 'chrome-extension',
      tab_id: session.tabId,
      webmcp: { protocol: 'penguin-webmcp/1', ...value, invocation_enabled: false }
    };
  }
  if (operation === 'webmcp_call') {
    const session = await activeAuthorizedSession(explicitTabId);
    const toolName = String(args.tool_name || '').trim();
    if (!toolName) throw new Error('WEBMCP_TOOL_REQUIRED');
    const injected = await chrome.scripting.executeScript({
      target: { tabId: session.tabId },
      func: async (name, toolArgs) => {
        const safeName = String(name || '').toLowerCase();
        const safePrefix = /(^|\.)(get|list|search|find|inspect|describe|status)(\.|$)/.test(safeName);
        if (!safePrefix || /(send|publish|submit|delete|update|create|pay|unlock)/.test(safeName)) {
          throw new Error('WEBMCP_EFFECT_REQUIRES_RUNTIME_GATE');
        }
        const context = globalThis.navigator?.modelContext || globalThis.modelContext || null;
        const tools = context?.tools || globalThis.__webmcpTools || [];
        const descriptor = Array.isArray(tools) ? tools.find((item) => String(item?.name || item?.id || '') === name) : null;
        if (!descriptor) throw new Error('WEBMCP_TOOL_NOT_DISCOVERED');
        if (descriptor.readOnly !== true && descriptor.read_only !== true) {
          throw new Error('WEBMCP_EFFECT_REQUIRES_RUNTIME_GATE');
        }
        const invoker = context?.callTool || context?.invokeTool || context?.executeTool;
        if (typeof invoker === 'function') return await invoker.call(context, name, toolArgs || {});
        if (typeof descriptor.call === 'function') return await descriptor.call(toolArgs || {});
        if (typeof descriptor.invoke === 'function') return await descriptor.invoke(toolArgs || {});
        throw new Error('WEBMCP_INVOCATION_UNSUPPORTED_BY_PAGE');
      },
      args: [toolName, args.arguments || {}]
    });
    return {
      browser_open: true,
      channel: 'chrome-extension',
      tab_id: session.tabId,
      webmcp: { protocol: 'penguin-webmcp/1', tool_name: toolName, read_only: true, result: injected?.[0]?.result }
    };
  }
  if (operation === 'bookmark_list') {
    const result = await listBookmarks(args.limit, !!args.include_folders);
    return { browser_open: true, channel: 'chrome-extension', ...result };
  }
  if (operation === 'bookmark_search') {
    const result = await searchBookmarks(args.query || args.value || args.title, args.limit, !!args.include_folders);
    return { browser_open: true, channel: 'chrome-extension', ...result };
  }
  if (operation === 'bookmark_open') {
    return await openBookmark(args);
  }

  const session = await activeAuthorizedSession(explicitTabId);

  if (operation === 'status' || operation === 'read') {
    return await bridgeRead(session, operation === 'status' ? Math.min(Number(args.max_chars || 3000), 3000) : args.max_chars);
  }
  if (operation === 'sequence') {
    requireSession(session, true);
    const steps = Array.isArray(args.steps) ? args.steps : [];
    if (!steps.length) throw new Error('SEQUENCE_STEPS_REQUIRED: sequence 至少需要一个步骤');
    if (steps.length > 32) throw new Error('SEQUENCE_TOO_LARGE: sequence 最多 32 个步骤');
    const requestedTimeout = Number(args.timeout_ms || args.limits?.total_timeout_ms || 8000);
    const result = await executeCommand({
      action: 'sequence',
      steps,
      timeout_ms: Math.max(250, Math.min(requestedTimeout, 20000))
    }, session.tabId);
    if (result?.confirmationRequired) {
      throw new Error(`USER_CONFIRMATION_REQUIRED: ${result.pendingAction?.summary || result.summary || 'sequence 中包含需要用户确认的敏感操作'}`);
    }
    if (!result?.verified || !result?.snapshot) {
      throw new Error('SEQUENCE_NOT_VERIFIED: 本地 sequence 未返回最终验证快照');
    }
    const page = snapshotForConnector(result.snapshot, session);
    page.text = String(page.text || '').slice(0, Math.max(1000, Math.min(Number(args.max_chars || 9000), 16000)));
    page.sequence_action = {
      verified: true,
      completed_steps: Number(result.completed_steps || 0),
      total_steps: Number(result.total_steps || steps.length),
      duration_ms: Number(result.duration_ms || 0),
      results: Array.isArray(result.results) ? result.results : []
    };
    return page;
  }
  if (operation === 'terminal_read') {
    const terminalResult = await executeCommand({
      action: 'terminal_read',
      ref: args.target || args.ref || null,
      max_chars: args.max_chars
    }, session.tabId);
    const page = await bridgeRead(session, Math.min(Number(args.max_chars || 4000), 8000));
    page.terminals = terminalResult.terminals || [];
    page.terminal_count = page.terminals.length;
    return page;
  }
  if (operation === 'terminal_input') {
    requireSession(session, true);
    const result = await executeCommand({
      action: 'terminal_input',
      ref: args.target || args.ref,
      value: args.value,
      press_enter: !!args.press_enter,
      confirmed: !!args.confirmed,
      max_chars: args.max_chars
    }, session.tabId);
    if (result?.confirmationRequired) {
      throw new Error(`USER_CONFIRMATION_REQUIRED: ${result.pendingAction?.summary || '在网页终端按 Enter 执行命令需要用户确认'}`);
    }
    if (args.press_enter) await sleep(300);
    const terminalResult = await executeCommand({
      action: 'terminal_read',
      ref: args.target || args.ref,
      max_chars: args.max_chars
    }, session.tabId);
    const page = await bridgeRead(session, Math.min(Number(args.max_chars || 4000), 8000));
    page.terminals = terminalResult.terminals || [];
    page.terminal_count = page.terminals.length;
    page.terminal_action = {
      adapter: 'xterm',
      target: args.target || args.ref || null,
      value_length: String(args.value ?? '').length,
      executed: !!args.press_enter
    };
    return page;
  }
  if (operation === 'click') {
    requireSession(session, true);
    const before = await bridgeRead(session, 1200);
    const result = await executeCommand({ action: 'click', ref: args.target, confirmed: !!args.confirmed, effect: args.effect || 'normal' }, session.tabId);
    if (result?.confirmationRequired) {
      throw new Error(`USER_CONFIRMATION_REQUIRED: ${result.pendingAction?.summary || '需要用户在浏览器扩展中允许一次'}`);
    }
    await executeCommand({ action: 'waitForChange', page_revision: before.page_revision, url: before.url, timeout_ms: 1600 }, session.tabId).catch(() => {});
    return await bridgeRead(await getSession(session.tabId), args.max_chars);
  }
  if (operation === 'visual_click') {
    requireSession(session, true);
    const before = await bridgeRead(session, 1200);
    const result = await executeCommand({ action: 'clickPoint', x: args.x, y: args.y, confirmed: !!args.confirmed, effect: args.effect || 'normal' }, session.tabId);
    if (result?.confirmationRequired) {
      throw new Error(`USER_CONFIRMATION_REQUIRED: ${result.pendingAction?.summary || '视觉点击命中敏感操作，需要用户允许一次'}`);
    }
    await executeCommand({ action: 'waitForChange', page_revision: before.page_revision, url: before.url, timeout_ms: 1600 }, session.tabId).catch(() => {});
    const after = await bridgeRead(await getSession(session.tabId), args.max_chars);
    after.visual_action = result;
    return after;
  }
  if (operation === 'find') {
    const found = await executeCommand({ action: 'find', query: args.query || args.value || '', role: args.role || '' }, session.tabId);
    return {
      browser_open: true,
      channel: 'chrome-extension',
      tab_id: session.tabId,
      url: session.url,
      title: session.title,
      matches: found.matches || [],
      match_count: (found.matches || []).length
    };
  }
  if (operation === 'scroll') {
    requireSession(session, true);
    const result = await executeCommand({
      action: 'scroll',
      ref: args.target || args.ref || null,
      x: args.x,
      y: args.y,
      to: args.to,
      absolute: !!args.absolute,
      behavior: args.behavior || 'instant',
      block: args.block || 'center'
    }, session.tabId);
    const after = await bridgeRead(session, args.max_chars);
    after.scroll_result = result;
    return after;
  }
  if (operation === 'fill') {
    requireSession(session, true);
    const fillResult = await executeCommand({
      action: 'fill',
      ref: args.target,
      value: args.value,
      press_enter: !!args.press_enter,
      confirmed: !!args.confirmed
    }, session.tabId);
    if (fillResult?.confirmationRequired) {
      throw new Error(`USER_CONFIRMATION_REQUIRED: ${fillResult.pendingAction?.summary || '在网页 Terminal/xterm 中按 Enter 执行需要用户确认'}`);
    }
    if (args.press_enter && fillResult?.adapter !== 'xterm') {
      await executeCommand({ action: 'key', ref: args.target, key: 'Enter', confirmed: !!args.confirmed, effect: args.effect || 'normal' }, session.tabId);
      await sleep(250);
    } else if (args.press_enter) {
      await sleep(250);
    }
    return await bridgeRead(session, args.max_chars);
  }
  if (operation === 'select') {
    requireSession(session, true);
    const selectResult = await executeCommand({
      action: 'select',
      ref: args.target || args.ref,
      value: args.value,
      label: args.label,
      blur: !!args.blur
    }, session.tabId);
    if (!selectResult?.verified) throw new Error('SELECT_VALUE_NOT_CHANGED: 原生 select 未返回 verified=true');
    const after = await bridgeRead(session, args.max_chars);
    after.select_action = selectResult;
    return after;
  }
  if (operation === 'press') {
    requireSession(session, true);
    const keyResult = await executeCommand({ action: 'key', ref: args.target || null, key: args.key, confirmed: !!args.confirmed, effect: args.effect || 'normal' }, session.tabId);
    await sleep(200);
    const after = await bridgeRead(session, args.max_chars);
    after.key_action = keyResult;
    return after;
  }
  if (operation === 'reload') {
    await chrome.tabs.reload(session.tabId);
    await waitTabComplete(session.tabId);
    return await bridgeRead(await getSession(session.tabId), args.max_chars);
  }
  if (operation === 'back') {
    await chrome.tabs.goBack(session.tabId);
    await waitTabComplete(session.tabId);
    const refreshed = await getSession(session.tabId);
    if (!refreshed) throw new Error('页面返回到了不同网站，原授权已自动失效，请重新授权');
    return await bridgeRead(refreshed, args.max_chars);
  }
  if (operation === 'forward') {
    await chrome.tabs.goForward(session.tabId);
    await waitTabComplete(session.tabId);
    const refreshed = await getSession(session.tabId);
    if (!refreshed) throw new Error('页面前进到了不同网站，原授权已自动失效，请重新授权');
    return await bridgeRead(refreshed, args.max_chars);
  }
  if (operation === 'tab_switch') {
    const target = await resolveAuthorizedSession(args.target_tab_id || args.target || args.tab_id);
    const tab = await chrome.tabs.get(target.tabId);
    await chrome.tabs.update(target.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    await syncSessionToTab(target);
    return await bridgeRead(target, args.max_chars);
  }
  if (operation === 'tab_new') {
    requireSession(session, true);
    const url = String(args.url || session.url || '').trim();
    assertAllowedUrl(url);
    const nextOrigin = new URL(url).origin;
    if (session.scope !== 'browser' && nextOrigin !== session.origin) {
      throw new Error('NAVIGATION_REAUTH_REQUIRED: 当前是单标签页授权；跨网站新标签需要启用“当前浏览器会话”授权');
    }
    const created = await chrome.tabs.create({ url, active: args.active !== false, openerTabId: session.tabId });
    await waitTabComplete(created.id);
    let inherited;
    if (session.scope === 'browser') {
      inherited = await ensureBrowserSessionForTab(await chrome.tabs.get(created.id), true);
    } else {
      inherited = {
        ...session,
        tabId: created.id,
        origin: nextOrigin,
        url,
        title: created.title || '',
        scope: 'tab',
        createdAt: now(),
        expiresAt: session.expiresAt,
        pendingAction: null
      };
      sessions.set(created.id, inherited);
      await persistSessions();
      await syncSessionToTab(inherited);
    }
    return await bridgeRead(inherited, args.max_chars);
  }
  if (operation === 'tab_close') {
    const target = await resolveAuthorizedSession(args.target_tab_id || args.target || args.tab_id || session.tabId);
    const closingId = target.tabId;
    sessions.delete(closingId);
    await persistSessions().catch(() => {});
    await chrome.tabs.remove(closingId);
    return {
      ok: true,
      browser_open: true,
      channel: 'chrome-extension',
      closed_tab_id: closingId,
      tabs: await authorizedTabSummaries(),
      tab_closed: true
    };
  }
  if (operation === 'open') {
    requireSession(session, true);
    const url = String(args.url || '').trim();
    assertAllowedUrl(url);
    const nextOrigin = new URL(url).origin;
    if (session.scope !== 'browser' && nextOrigin !== session.origin) {
      throw new Error('NAVIGATION_REAUTH_REQUIRED: 当前是单标签页授权；跨网站导航需要启用“当前浏览器会话”授权');
    }
    if (args.new_tab) {
      const created = await chrome.tabs.create({ url, active: true, openerTabId: session.tabId });
      await waitTabComplete(created.id);
      if (session.scope === 'browser') {
        const inherited = await ensureBrowserSessionForTab(await chrome.tabs.get(created.id), true);
        return await bridgeRead(inherited, args.max_chars);
      }
      const inherited = {
        ...session,
        tabId: created.id,
        origin: nextOrigin,
        url,
        title: created.title || '',
        scope: 'tab',
        createdAt: now(),
        pendingAction: null
      };
      sessions.set(created.id, inherited);
      await persistSessions();
      await syncSessionToTab(inherited);
      return await bridgeRead(inherited, args.max_chars);
    }
    await chrome.tabs.update(session.tabId, { url });
    await waitTabComplete(session.tabId);
    let refreshed = await getSession(session.tabId);
    if (session.scope === 'browser' && refreshed) {
      refreshed.origin = nextOrigin;
      refreshed.suspendedOrigin = null;
      await persistSessions().catch(() => {});
    }
    await syncSessionToTab(refreshed);
    return await bridgeRead(refreshed, args.max_chars);
  }
  if (operation === 'screenshot') {
    return await captureScreenshot(session, !!args.full_page);
  }
  if (operation === 'element_image') {
    return await captureElementImage(session, args);
  }
  if (operation === 'download') {
    requireSession(session, true);
    const url = String(args.url || '').trim();
    if (!url) throw new Error('DOWNLOAD_URL_REQUIRED: 当前版本下载操作需要明确 URL');
    assertAllowedUrl(url);
    const filename = String(args.save_path || '').split(/[\\/]/).pop() || undefined;
    const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
    const verified = await waitDownload(downloadId, Math.max(1000, Math.min(Number(args.timeout_ms || 20000), 60000)));
    return {
      ok: verified.verified,
      browser_open: true,
      channel: 'chrome-extension',
      requested_url: url,
      requested_filename: filename || null,
      ...verified
    };
  }
  if (operation === 'upload') {
    requireSession(session, true);
    const target = String(args.target || '').trim();
    if (!target) throw new Error('UPLOAD_TARGET_REQUIRED: 需要先读取页面并指定 file input 的 ref');
    const page = await bridgeRead(session, 800);
    const input = page.interactive.find((item) => item.ref === target);
    if (!input || input.type !== 'file') throw new Error('UPLOAD_TARGET_NOT_FILE_INPUT: 指定目标不是文件上传控件');
    throw new Error('UPLOAD_REQUIRES_DESKTOP_PICKER: 普通 Chrome 扩展不能把任意本地路径直接写入 file input；需要由企鹅 Connector 的桌面文件选择器通道在用户授权后完成。');
  }
  if (operation === 'close') {
    if (session.scope === 'browser') {
      const revoked = await revokeBrowserSession();
      return { ok: true, browser_open: false, ai_session_closed: true, tab_closed: false, authorization_scope: 'browser', revoked_tabs: revoked.revoked_tabs };
    }
    await revoke(session.tabId);
    return { ok: true, browser_open: false, ai_session_closed: true, tab_closed: false, authorization_scope: 'tab' };
  }
  throw new Error(`UNSUPPORTED_OPERATION:${operation}`);
}

async function postTaskResult(token, task, ok, resultOrError) {
  return await bridgeFetch(`/v1/tasks/${encodeURIComponent(task.task_id || task.id)}/result`, {
    method: 'POST',
    token,
    body: ok ? { ok: true, result: resultOrError } : { ok: false, error: String(resultOrError) },
    timeoutMs: 8000
  });
}

async function startBridgeLoop() {
  if (bridgeLoopRunning) return;
  bridgeLoopRunning = true;
  bridgeState.polling = true;
  try {
    while (true) {
      const saved = await storageGet(['bridgeToken']);
      const token = saved.bridgeToken;
      if (!token) return;
      try {
        if (!await heartbeat(token)) {
          const credentials = await storageGet(['bridgeRefreshToken', 'bridgeClientId']);
          if (await renewBridgePairing(credentials)) continue;
          await clearBridgePairing('Connector 配对凭据已失效，正在重新建立配对', false);
          setTimeout(() => ensureBridgeConnection().catch(() => {}), 0);
          return;
        }
        const response = await bridgeFetch('/v1/tasks/next?wait=5', { token, timeoutMs: 9000 });
        if (response.status === 401) {
          const credentials = await storageGet(['bridgeRefreshToken', 'bridgeClientId']);
          if (await renewBridgePairing(credentials)) continue;
          await clearBridgePairing('Connector 配对凭据已失效，正在重新建立配对', false);
          setTimeout(() => ensureBridgeConnection().catch(() => {}), 0);
          return;
        }
        if (!response.ok) throw new Error(response.data?.error || `tasks/next ${response.status}`);
        const task = response.data?.task;
        if (task) {
          try {
            const result = await handleBridgeTask(task);
            await postTaskResult(token, task, true, result);
          } catch (error) {
            await postTaskResult(token, task, false, String(error?.message || error));
          }
        }
      } catch (error) {
        bridgeState.connected = false;
        bridgeState.lastError = String(error?.message || error);
        await sleep(1200);
      }
    }
  } finally {
    bridgeLoopRunning = false;
    bridgeState.polling = false;
  }
}

async function ensureBridgeConnectionOnce() {
  try {
    const status = await bridgeFetch('/v1/status', { timeoutMs: 5000 });
    if (!status.ok) throw new Error(`Connector LocalAppBridge HTTP ${status.status}`);
    bridgeState.bridgeVersion = status.data?.bridge_version || null;
    if (bridgeLoopRunning) return bridgeState;
    const saved = await storageGet(['bridgeToken', 'bridgeRefreshToken', 'bridgeClientId', 'pairingRequestId', 'pairingSecret']);
    if (saved.bridgeToken) {
      bridgeState.clientId = saved.bridgeClientId || null;
      if (await heartbeat(saved.bridgeToken)) {
        startBridgeLoop().catch(() => {});
        return bridgeState;
      }
      if (await renewBridgePairing(saved)) {
        startBridgeLoop().catch(() => {});
        return bridgeState;
      }
      await clearBridgePairing('Connector 配对凭据已失效，正在重新建立配对', false);
      return await beginPairing();
    }
    if (saved.pairingRequestId && saved.pairingSecret) {
      bridgeState.pairingState = 'pending_approval';
      startPairingLoop().catch(() => {});
      return bridgeState;
    }
    const pairingChoice = await storageGet([BRIDGE_PAIRING_USER_ACTION_KEY]);
    const pairingLatch = pairingChoice[BRIDGE_PAIRING_USER_ACTION_KEY];
    if (pairingChoiceRequiresManualAction(pairingLatch)) {
      bridgeState.pairingState = 'unpaired';
      bridgeState.lastError = '上次配对被用户明确拒绝；如需重新连接，请在插件中点击“连接”';
      return bridgeState;
    }
    if (pairingLatch) {
      // 0.4.12 and earlier stored a bare boolean for many recoverable failures.
      // Connector is reachable now, so migrate that stale latch away and retry.
      await storageRemove([BRIDGE_PAIRING_USER_ACTION_KEY]);
    }
    return await beginPairing();
  } catch (error) {
    bridgeState.connected = false;
    bridgeState.lastError = String(error?.message || error);
    if (bridgeState.pairingState === 'unknown') bridgeState.pairingState = 'unreachable';
    return bridgeState;
  }
}

async function ensureBridgeConnection() {
  // MV3 may restart the service worker without firing onInstalled/onStartup.
  // Reconcile the alarm on every single-flight wake so Connector restarts are
  // recovered even when the worker was suspended between events.
  ensureBridgeReconnectAlarm().catch(() => {});
  if (bridgeEnsurePromise) return await bridgeEnsurePromise;
  bridgeEnsurePromise = ensureBridgeConnectionOnce();
  try {
    return await bridgeEnsurePromise;
  } finally {
    bridgeEnsurePromise = null;
  }
}

async function ensureBridgeReconnectAlarm() {
  try {
    const current = await chrome.alarms.get(BRIDGE_RECONNECT_ALARM);
    if (!current || Number(current.periodInMinutes || 0) !== BRIDGE_RECONNECT_PERIOD_MINUTES) {
      await chrome.alarms.create(BRIDGE_RECONNECT_ALARM, {
        delayInMinutes: BRIDGE_RECONNECT_PERIOD_MINUTES,
        periodInMinutes: BRIDGE_RECONNECT_PERIOD_MINUTES
      });
    }
  } catch (error) {
    bridgeState.lastError = String(error?.message || error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureBridgeReconnectAlarm().catch(() => {});
  ensureBridgeConnection().catch(() => {});
  restoreBrowserGrantOnce().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== BRIDGE_RECONNECT_ALARM) return;
  ensureBridgeConnection().catch(() => {});
});

chrome.tabs.onActivated.addListener(() => {
  // A user switching tabs is a natural MV3 wake-up point. Reconnect is
  // single-flight, so this is cheap when the bridge is already healthy.
  ensureBridgeConnection().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  // Browser startup must not actively revoke permissions or delete grants.
  // Rehydrate whatever Chrome still considers part of the current extension session.
  ensureBridgeReconnectAlarm().catch(() => {});
  ensureBridgeConnection().catch(() => {});
  sessions.clear();
  sessionsRestored = false;
  browserGrant = null;
  browserGrantRestored = false;
  restoreSessionsOnce().then(async () => {
    if (!browserGrant) return;
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab?.url || !/^https?:\/\//i.test(tab.url)) continue;
      await ensureBrowserSessionForTab(tab, tab.status === 'complete').catch(() => {});
    }
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (sessions.delete(tabId)) persistSessions().catch(() => {});
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await restoreSessionsOnce();
  try {
    const currentUrl = changeInfo.url || tab?.url || sessions.get(tabId)?.url || '';
    let session = sessions.get(tabId);
    if (!session && browserGrant && /^https?:\/\//i.test(currentUrl)) {
      session = await ensureBrowserSessionForTab({ ...tab, id: tabId, url: currentUrl }, false);
    }
    if (!session) return;
    if (currentUrl && /^https?:\/\//i.test(currentUrl)) {
      const nextOrigin = new URL(currentUrl).origin;
      session.url = currentUrl;
      if (session.scope === 'browser') {
        session.origin = nextOrigin;
        session.suspendedOrigin = null;
      } else if (nextOrigin !== session.origin) {
        session.suspendedOrigin = nextOrigin;
        if (tab?.title) session.title = tab.title;
        await persistSessions().catch(() => {});
        return;
      } else {
        session.suspendedOrigin = null;
      }
    }
    if (tab?.title) session.title = tab.title;
    await persistSessions().catch(() => {});
    if (changeInfo.status === 'complete' && /^https?:\/\//i.test(currentUrl)) {
      await syncSessionToTab(session);
    }
  } catch {
    // Navigation/content-script races are transient. onRemoved is authoritative
    // for tab closure, so keep the existing grant when one synchronization fails.
  }
});

async function handleTopNavigation(details) {
  if (!details || details.frameId !== 0 || !details.tabId || !details.url) return;
  await restoreSessionsOnce();
  try {
    if (!/^https?:\/\//i.test(details.url)) return;
    let session = sessions.get(details.tabId);
    if (!session && browserGrant) {
      session = await ensureBrowserSessionForTab(details.tabId, false).catch(() => null);
    }
    if (!session) return;
    const nextOrigin = new URL(details.url).origin;
    session.url = details.url;
    if (session.scope === 'browser') {
      session.origin = nextOrigin;
      session.suspendedOrigin = null;
    } else if (nextOrigin !== session.origin) {
      session.suspendedOrigin = nextOrigin;
      await persistSessions().catch(() => {});
      return;
    } else {
      session.suspendedOrigin = null;
    }
    await persistSessions().catch(() => {});
    if (isHwcrUrl(details.url)) {
      await collectHwcrFrontendRecords(details.tabId, details.url).catch(() => []);
    }
    await syncSessionToTab(session).catch(() => {});
  } catch {}
}

chrome.webNavigation.onCommitted.addListener((details) => { handleTopNavigation(details).catch(() => {}); });
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => { handleTopNavigation(details).catch(() => {}); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'AUTHORIZE_CURRENT_TAB':
        return await authorizeCurrentTab(message.mode || 'view', message.scope || 'tab');
      case 'REVOKE_CURRENT_TAB':
        return await revoke();
      case 'REVOKE_BROWSER_SESSION':
        return await revokeBrowserSession();
      case 'GET_CURRENT_SESSION': {
        const tab = await currentTab();
        return publicSession(await getSession(tab.id));
      }
      case 'SET_SESSION_MODE': {
        const tab = await currentTab();
        const session = await getSession(tab.id);
        requireSession(session, false);
        if (!['view', 'interact'].includes(message.mode)) throw new Error('无效模式');
        if (session.scope === 'browser') {
          await restoreBrowserGrantOnce();
          if (!browserGrant) throw new Error('浏览器会话授权已失效');
          browserGrant.mode = message.mode;
          await persistBrowserGrant();
          for (const candidate of sessions.values()) {
            if (candidate.scope !== 'browser') continue;
            candidate.mode = message.mode;
            await syncSessionToTab(candidate).catch(() => {});
          }
        } else {
          session.mode = message.mode;
          await sendToTab(tab.id, { type: 'PENGUIN_SESSION_STATE', authorized: true, mode: message.mode, scope: 'tab' });
        }
        await persistSessions();
        return publicSession(await getSession(tab.id));
      }
      case 'SET_SESSION_PAUSED': {
        const tab = await currentTab();
        const session = await getSession(tab.id);
        requireSession(session, false);
        const paused = !!message.paused;
        if (session.scope === 'browser') {
          await restoreBrowserGrantOnce();
          if (!browserGrant) throw new Error('浏览器会话授权已失效');
          browserGrant.paused = paused;
          await persistBrowserGrant();
          for (const candidate of sessions.values()) {
            if (candidate.scope !== 'browser') continue;
            candidate.paused = paused;
          }
        } else {
          session.paused = paused;
        }
        await persistSessions();
        return publicSession(await getSession(tab.id));
      }
      case 'EXECUTE_CURRENT_COMMAND': {
        const tab = await currentTab();
        return await executeCommand(message.command || {}, tab.id);
      }
      case 'CONFIRM_PENDING': {
        const tab = await currentTab();
        return await confirmPending(tab.id, message.token);
      }
      case 'CONNECT_BRIDGE':
        await storageRemove([BRIDGE_PAIRING_USER_ACTION_KEY]);
        return await ensureBridgeConnection();
      case 'AUTO_CONNECT_BRIDGE':
        return await ensureBridgeConnection();
      case 'GET_BRIDGE_STATE':
        return { ...bridgeState };
      case 'RESET_BRIDGE':
        await clearBridgePairing(null);
        return await ensureBridgeConnection();
      default:
        throw new Error('未知消息类型');
    }
  })().then((result) => sendResponse({ ok: true, result })).catch((error) => {
    sendResponse({ ok: false, error: String(error?.message || error) });
  });
  return true;
});

ensureBridgeReconnectAlarm().catch(() => {});
ensureBridgeConnection().catch(() => {});
