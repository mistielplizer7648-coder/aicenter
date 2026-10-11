(() => {
  'use strict';

  const host = String(location.hostname || '').toLowerCase();
  if (!(host === 'm.hwcr.vip' || host.endsWith('.hwcr.vip'))) return;

  const BRIDGE_KEY = '__penguinHwcrConvenienceBridgeV1';
  const existing = window[BRIDGE_KEY];
  if (existing?.version === '0.4.10' && typeof existing.snapshot === 'function') return;

  const TARGET_METHOD = 'convenience.getConvenienceList';
  const MAX_RECORDS = 400;
  const MAX_JSON_CHARS = 3_000_000;
  const records = new Map();
  let activePageUrl = location.href;

  const diagnostics = {
    status: 'not_ready',
    target_response_count: 0,
    parsed_post_count: 0,
    contact_record_count: 0,
    last_error: null
  };

  const clean = (value, max = 600) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const scalar = (value, max = 600) => {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return clean(value, max);
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
  const ensurePage = () => {
    if (activePageUrl === location.href) return;
    activePageUrl = location.href;
    records.clear();
    diagnostics.status = 'not_ready';
    diagnostics.target_response_count = 0;
    diagnostics.parsed_post_count = 0;
    diagnostics.contact_record_count = 0;
    diagnostics.last_error = null;
  };
  const decode = (value) => {
    const raw = String(value || '');
    try { return decodeURIComponent(raw); } catch { return raw; }
  };
  const isTargetRequest = (url = '', body = '') => {
    const combined = decode(String(url || '') + '\n' + String(body || '')).toLowerCase();
    return combined.includes(TARGET_METHOD.toLowerCase());
  };
  const bodyText = (body) => {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    try {
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        return [...body.entries()].map(([key, value]) => key + '=' + scalar(value, 1000)).join('&');
      }
    } catch {}
    return '';
  };
  const fieldEntries = (post) => {
    const result = [];
    const data = post?.data;
    if (!Array.isArray(data)) return result;
    for (const item of data.slice(0, 120)) {
      if (!item || typeof item !== 'object') continue;
      const name = clean(item.name ?? item.key ?? item.label ?? item.title, 120).replace(/[：:]\s*$/, '');
      const value = clean(item.value ?? item.val ?? item.content ?? item.text, 1200);
      if (name && value) result.push({ name, value });
    }
    return result;
  };
  const valueByNames = (entries, names, max = 600) => {
    for (const entry of entries) {
      if (names.includes(entry.name)) return clean(entry.value, max);
    }
    for (const entry of entries) {
      if (names.some((name) => entry.name.includes(name))) return clean(entry.value, max);
    }
    return '';
  };
  const labeledValue = (content, names, max = 1200) => {
    const raw = String(content || '');
    if (!raw) return '';
    for (const name of names) {
      const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const match = raw.match(new RegExp('(?:【\\s*' + escaped + '\\s*】|' + escaped + ')\\s*[:：]\\s*([^\\n\\r【]{1,1200})', 'i'));
      if (match?.[1]) return clean(match[1], max);
    }
    return '';
  };
  const parseContact = (rawValue) => {
    const raw = clean(rawValue, 1200);
    if (!raw || /^(联系超人|查看联系方式|点击查看|contact)$/i.test(raw)) {
      return { raw: '', phone: '', wechat: '', email: '' };
    }
    const phone = clean(raw.match(/(?:\+?1[\s.\-]?)?(?:\(?\d{3}\)?[\s.\-]?)\d{3}[\s.\-]?\d{4}/)?.[0] || '', 100);
    const email = clean(raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '', 180);
    let wechat = clean(raw.match(/(?:微信|wechat|weixin)\s*[:：]?\s*([A-Za-z][A-Za-z0-9_-]{5,30})/i)?.[1] || '', 120);
    if (!wechat && !phone && !email && /^[A-Za-z][A-Za-z0-9_-]{5,30}$/.test(raw)) wechat = raw;
    return { raw, phone, wechat, email };
  };
  const inferCategory = (textValue) => {
    const value = String(textValue || '').toLowerCase();
    if (/求职|找工作|求工作|个人求职|应聘|job\s*seeker/.test(value)) return 'jobseeker';
    if (/招聘|招工|诚聘|招聘职位|招聘岗位|招聘启事|请人|急聘|hiring|recruitment/.test(value)) return 'recruitment';
    if (/房屋出租|租房|出租房|房源|整租|合租|单间|room\s+for\s+rent|housing\s+rental/.test(value)) return 'housing_rental';
    return 'work_unknown';
  };
  const safeUrl = (value) => {
    const raw = scalar(value, 800);
    if (!raw) return '';
    try {
      const parsed = new URL(raw, location.href);
      const candidateHost = parsed.hostname.toLowerCase();
      if (!(candidateHost === 'm.hwcr.vip' || candidateHost.endsWith('.hwcr.vip'))) return '';
      parsed.hash = '';
      return parsed.href;
    } catch {
      return '';
    }
  };

  const sanitizePost = (post) => {
    if (!post || typeof post !== 'object' || Array.isArray(post)) return null;
    const sourceId = scalar(post.id ?? post._id ?? post.info_id ?? post.post_id, 100);
    const entries = fieldEntries(post);
    const content = scalar(post.content ?? post.body ?? post.description ?? post.desc, 5000);
    const title = scalar(post.title ?? post.subject ?? post.name ?? post.job_title ?? post.position, 240)
      || valueByNames(entries, ['招聘岗位', '岗位', '职位', '职位名称', '工作岗位', '求职意向', '标题'], 240);
    const description = valueByNames(entries, ['岗位描述', '职位描述', '工作内容', '描述', '详情', '要求'], 2600);
    const body = content || description || entries.map((entry) => entry.name + '：' + entry.value).join('\n');
    const city = scalar(post.city ?? post.location ?? post.area ?? post.region ?? post.address, 240)
      || valueByNames(entries, ['办公地点', '工作地点', '地点', '地址', '城市', '地区', '区域'], 240);
    const salary = scalar(post.salary ?? post.salary_text ?? post.price ?? post.wage, 180)
      || valueByNames(entries, ['薪资待遇', '期望薪资', '薪资', '工资', '待遇'], 180);
    const time = scalar(
      post.time ?? post.date ?? post.created_at ?? post.create_time ?? post.publish_time ?? post.published_at ?? post.updated_at,
      160
    );
    const detailUrl = safeUrl(post.detail_url ?? post.detailUrl ?? post.url ?? post.link ?? post.href);

    const contactNames = ['联系方式', '联系电话', '电话', '手机', '微信', 'Wechat', 'WeChat', 'Weixin', '邮箱', 'Email'];
    const contactPieces = [];
    for (const entry of entries) {
      if (contactNames.some((name) => entry.name === name || entry.name.includes(name))) contactPieces.push(entry.value);
    }
    const fromContent = labeledValue(content, contactNames, 1200);
    if (fromContent) contactPieces.push(fromContent);
    const contactRaw = clean([...new Set(contactPieces.filter(Boolean))].join(' | '), 1600);
    const contact = parseContact(contactRaw);

    const combined = clean(title + '\n' + body + '\n' + entries.map((entry) => entry.name + '：' + entry.value).join('\n'), 7000);
    const hasPostShape = entries.length >= 2 || content.length >= 12 || description.length >= 12;
    if (!hasPostShape) return null;
    if (!sourceId && !title) return null;

    const key = sourceId
      ? 'id:' + sourceId
      : 'hash:' + hash(title + '|' + city + '|' + body.slice(0, 600));

    return {
      key,
      source_id: sourceId || null,
      category: inferCategory(combined),
      title,
      body,
      detail_url: detailUrl || null,
      city: city || null,
      salary: salary || null,
      time: time || null,
      contact_raw: contact.raw || null,
      contact_phone: contact.phone || null,
      contact_wechat: contact.wechat || null,
      contact_email: contact.email || null,
      contact_source: contact.raw ? 'convenience_list' : null
    };
  };

  const absorbTargetPayload = (payload) => {
    ensurePage();
    let parsedPosts = 0;
    const seen = new WeakSet();
    const stack = [payload];
    let nodes = 0;
    while (stack.length && records.size < MAX_RECORDS && nodes < 8000) {
      const value = stack.pop();
      if (!value || typeof value !== 'object') continue;
      if (seen.has(value)) continue;
      seen.add(value);
      nodes += 1;

      if (!Array.isArray(value)) {
        try {
          const record = sanitizePost(value);
          if (record) {
            const previous = records.get(record.key);
            records.set(record.key, previous ? { ...previous, ...record } : record);
            parsedPosts += 1;
          }
        } catch {}
      }

      if (Array.isArray(value)) {
        for (let index = Math.min(value.length, 500) - 1; index >= 0; index -= 1) {
          const child = value[index];
          if (child && typeof child === 'object') stack.push(child);
        }
        continue;
      }

      for (const [key, child] of Object.entries(value)) {
        if (!child || typeof child !== 'object') continue;
        if (/^(user|users|user_?info|member|members|member_?info|account|accounts|profile|profiles|publisher|author|creator|owner|auth|session|sessions|credential|credentials|password|password_hash|login_ip|last_login_ip|token|tokens)$/i.test(key)) continue;
        stack.push(child);
      }
    }

    diagnostics.parsed_post_count = records.size;
    diagnostics.contact_record_count = [...records.values()].filter((record) => (
      record.contact_raw || record.contact_phone || record.contact_wechat || record.contact_email
    )).length;
    diagnostics.status = records.size ? 'ready' : 'no_data';
    return parsedPosts;
  };

  const captureJsonText = (raw) => {
    const text = String(raw || '').trim();
    if (!text || text.length > MAX_JSON_CHARS || !/^[\[{]/.test(text)) return false;
    try {
      const payload = JSON.parse(text);
      absorbTargetPayload(payload);
      diagnostics.target_response_count += 1;
      diagnostics.last_error = null;
      return true;
    } catch (error) {
      diagnostics.status = records.size ? 'ready' : 'error';
      diagnostics.last_error = clean(error?.message || error, 500);
      return false;
    }
  };

  const originalFetch = typeof window.fetch === 'function' ? window.fetch : null;
  if (originalFetch) {
    window.fetch = function penguinHwcrConvenienceFetch(...args) {
      const sourcePageUrl = location.href;
      const input = args[0];
      const init = args[1] || {};
      const requestUrl = scalar(typeof input === 'string' ? input : input?.url, 1200);
      let requestBodyPromise = Promise.resolve(bodyText(init?.body));
      try {
        if (!bodyText(init?.body) && typeof Request !== 'undefined' && input instanceof Request) {
          requestBodyPromise = input.clone().text().catch(() => '');
        }
      } catch {}

      const responsePromise = originalFetch.apply(this, args);
      return Promise.resolve(responsePromise).then((response) => {
        Promise.resolve(requestBodyPromise).then(async (requestBody) => {
          try {
            if (sourcePageUrl !== location.href) return;
            const responseUrl = scalar(response?.url || requestUrl, 1200);
            if (!isTargetRequest(requestUrl || responseUrl, requestBody) && !isTargetRequest(responseUrl, requestBody)) return;
            const clone = response.clone();
            captureJsonText(await clone.text());
          } catch (error) {
            diagnostics.last_error = clean(error?.message || error, 500);
            if (!records.size) diagnostics.status = 'error';
          }
        }).catch(() => {});
        return response;
      });
    };
  }

  try {
    const xhrProto = window.XMLHttpRequest?.prototype;
    const originalOpen = xhrProto?.open;
    const originalSend = xhrProto?.send;
    if (xhrProto && originalOpen && originalSend) {
      xhrProto.open = function penguinHwcrConvenienceOpen(method, url, ...rest) {
        this.__penguinHwcrConvenienceUrl = scalar(url, 1200);
        this.__penguinHwcrConveniencePageUrl = location.href;
        return originalOpen.call(this, method, url, ...rest);
      };
      xhrProto.send = function penguinHwcrConvenienceSend(body, ...rest) {
        try {
          const requestBody = bodyText(body);
          this.__penguinHwcrConvenienceTarget = isTargetRequest(this.__penguinHwcrConvenienceUrl || '', requestBody);
          if (!this.__penguinHwcrConvenienceListener) {
            this.__penguinHwcrConvenienceListener = true;
            this.addEventListener('load', function penguinHwcrConvenienceLoad() {
              try {
                if (this.__penguinHwcrConveniencePageUrl !== location.href) return;
                const responseUrl = scalar(this.responseURL || this.__penguinHwcrConvenienceUrl || '', 1200);
                if (!this.__penguinHwcrConvenienceTarget && !isTargetRequest(responseUrl, '')) return;
                if (this.responseType === 'json') {
                  absorbTargetPayload(this.response);
                  diagnostics.target_response_count += 1;
                  diagnostics.last_error = null;
                } else if (!this.responseType || this.responseType === 'text') {
                  captureJsonText(this.responseText);
                }
              } catch (error) {
                diagnostics.last_error = clean(error?.message || error, 500);
                if (!records.size) diagnostics.status = 'error';
              }
            });
          }
        } catch {}
        return originalSend.call(this, body, ...rest);
      };
    }
  } catch {}

  const snapshot = () => {
    ensurePage();
    return [...records.values()].slice(0, MAX_RECORDS).map((record) => ({ ...record }));
  };
  const diagnosticsSnapshot = () => {
    ensurePage();
    return {
      status: records.size ? 'ready' : diagnostics.status,
      error: diagnostics.last_error || null,
      target_response_count: diagnostics.target_response_count,
      parsed_post_count: diagnostics.parsed_post_count,
      contact_record_count: diagnostics.contact_record_count
    };
  };

  const bridge = Object.freeze({
    version: '0.4.10',
    snapshot,
    diagnosticsSnapshot
  });
  try {
    Object.defineProperty(window, BRIDGE_KEY, {
      value: bridge,
      configurable: true,
      enumerable: false,
      writable: false
    });
  } catch {
    window[BRIDGE_KEY] = bridge;
  }
})();
