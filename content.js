(() => {
  if (window.__penguinAssistantInjected) return;
  window.__penguinAssistantInjected = true;

  let authorized = false;
  let mode = 'view';
  let scope = 'tab';
  let refs = new Map();
  let mediaRefs = new Map();
  let pageGeneration = 1;
  let pageGenerationUrl = location.href;
  let overlay = null;
  let highlighted = null;
  let pageRevision = 1;
  let hwcrFrontendRecords = [];
  let hwcrFrontendDiagnostics = { status: 'not_ready', error: null };

  const mutationObserver = new MutationObserver((mutations) => {
    // Ref bookkeeping is Connector-owned metadata, not a page change. Do not
    // invalidate the very refs produced by the snapshot that added them.
    const meaningful = mutations.some((mutation) => (
      mutation.type !== 'attributes' ||
      !['data-ai-center-ref', 'data-ai-center-media-ref'].includes(mutation.attributeName)
    ));
    if (meaningful) pageRevision += 1;
  });
  mutationObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

  const REDACTED_INPUT_TYPES = new Set(['password', 'hidden']);
  const INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input', 'textarea', 'select',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="textbox"]', '[contenteditable="true"]', '[tabindex]',
    '.xterm'
  ].join(',');

  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    const view = el.ownerDocument?.defaultView || window;
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function cleanText(value, max = 240) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function harvestHash(value) {
    let hash = 2166136261;
    for (const ch of String(value || '')) {
      hash ^= ch.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function normalizedHarvestUrl(value) {
    try {
      const url = new URL(value, location.href);
      url.hash = '';
      for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'from']) {
        url.searchParams.delete(key);
      }
      return url.href;
    } catch {
      return cleanText(value, 500);
    }
  }

  function harvestCategory(text, url = '') {
    const value = `${text || ''}\n${url || ''}`.toLowerCase();
    if (/求职|找工作|求工作|个人求职|应聘|job\s*seeker|looking\s+for\s+(a\s+)?job/.test(value)) return 'jobseeker';
    if (/房屋出租|房屋租赁|租房|出租房|房源|整租|合租|单间|公寓出租|店面出租|办公室出租|room\s+for\s+rent|for\s+rent|housing\s+rental/.test(value)) return 'housing_rental';
    if (/招聘|招工|诚聘|招聘职位|招聘岗位|招聘启事|请人|急聘|hiring|job\s+opening|recruitment/.test(value)) return 'recruitment';
    return null;
  }

  function harvestRefForElement(el) {
    for (const [ref, candidate] of refs.entries()) if (candidate === el) return ref;
    return null;
  }

  function harvestRecordRoot(anchor) {
    let current = anchor;
    let best = anchor;
    for (let depth = 0; depth < 6 && current?.parentElement; depth += 1) {
      current = current.parentElement;
      const text = cleanText(current.innerText || '', 2600);
      if (text.length < 20 || text.length > 2600) continue;
      best = current;
      const tag = current.tagName?.toLowerCase();
      const cls = String(current.className || '').toLowerCase();
      if (['li', 'article', 'tr'].includes(tag) || /(card|item|row|post|entry|record|info[-_]?item|job[-_]?item|house[-_]?item)/.test(cls)) break;
    }
    return best;
  }

  function harvestLines(el) {
    return String(el?.innerText || el?.textContent || '')
      .split(/\n+/)
      .map((line) => cleanText(line, 320))
      .filter(Boolean);
  }

  function harvestSourceId(url) {
    try {
      const parsed = new URL(url, location.href);
      for (const key of ['id', 'infoid', 'info_id', 'sid', 'postid', 'post_id', 'jobid', 'job_id', 'houseid', 'house_id']) {
        const value = parsed.searchParams.get(key);
        if (value && /^[A-Za-z0-9_-]{2,80}$/.test(value)) return value;
      }
      const numeric = parsed.pathname.match(/(?:^|\/)(\d{3,})(?:\.[a-z]+)?\/?$/i);
      return numeric?.[1] || null;
    } catch {
      return null;
    }
  }


  function frontendField(value, max = 500) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const candidate = cleanText(item, max);
        if (candidate) return candidate;
      }
      return '';
    }
    return cleanText(value, max);
  }

  function mergeHwcrFrontendRecords(records, pageCategory) {
    if (!Array.isArray(hwcrFrontendRecords) || !hwcrFrontendRecords.length) return records;

    const bySourceId = new Map();
    const byDetailUrl = new Map();
    for (const record of records) {
      if (record?.source_id) bySourceId.set(String(record.source_id), record);
      if (record?.detail_url) byDetailUrl.set(normalizedHarvestUrl(record.detail_url), record);
    }

    for (const raw of hwcrFrontendRecords.slice(0, 160)) {
      if (!raw || typeof raw !== 'object') continue;
      const detailUrl = raw.detail_url ? normalizedHarvestUrl(raw.detail_url) : '';
      const explicitSourceId = frontendField(raw.source_id, 100);
      const sourceId = explicitSourceId || (detailUrl ? harvestSourceId(detailUrl) : null);
      const title = frontendField(raw.title, 220);
      const body = frontendField(raw.body || raw.summary, 2200);
      const category = frontendField(raw.category, 60) || harvestCategory(title + '\n' + body, detailUrl) || pageCategory;
      const phone = frontendField(raw.contact_phone, 100);
      const wechat = frontendField(raw.contact_wechat, 120);
      const email = frontendField(raw.contact_email, 180);
      const city = frontendField(raw.city || raw.location_text, 180);
      const time = frontendField(raw.time || raw.date_text, 120);
      const hasContact = !!(phone || wechat || email);

      let target = sourceId ? bySourceId.get(String(sourceId)) : null;
      if (!target && detailUrl) target = byDetailUrl.get(detailUrl) || null;

      if (target) {
        if (!target.source_id && sourceId) target.source_id = sourceId;
        if (!target.title && title) target.title = title;
        if (!target.category && category) target.category = category;
        if (!target.location_text && city) target.location_text = city;
        if (!target.date_text && time) target.date_text = time;
        if ((!target.summary || target.summary.length < 18) && body) {
          target.summary = body;
          target.text_length = body.length;
        }
        if (phone) target.contact_phone = phone;
        if (wechat) target.contact_wechat = wechat;
        if (email) target.contact_email = email;
        if (hasContact) target.contact_source = 'frontend_data';
        continue;
      }

      if (!category) continue;
      if (!sourceId && !detailUrl && !title && body.length < 18) continue;
      if (!hasContact && body.length < 18 && title.length < 4) continue;

      const summary = body || title;
      const stableKey = sourceId
        ? 'hwcr:' + sourceId
        : 'hwcr:' + harvestHash(category + '|' + detailUrl + '|' + title + '|' + summary.slice(0, 500));
      if (records.some((record) => record?.stable_key === stableKey)) continue;

      const added = {
        stable_key: stableKey,
        source_id: sourceId || null,
        category,
        title: title || cleanText(document.title, 220),
        detail_url: detailUrl || normalizedHarvestUrl(location.href),
        detail_ref: null,
        location_text: city,
        date_text: time,
        visible_phones: [],
        summary,
        text_length: summary.length
      };
      if (phone) added.contact_phone = phone;
      if (wechat) added.contact_wechat = wechat;
      if (email) added.contact_email = email;
      if (hasContact) added.contact_source = 'frontend_data';

      records.push(added);
      if (sourceId) bySourceId.set(String(sourceId), added);
      if (detailUrl) byDetailUrl.set(detailUrl, added);
      if (records.length >= 80) break;
    }
    return records;
  }

  function buildHarvestSnapshot() {
    const host = String(location.hostname || '').toLowerCase();
    if (!(host === 'm.hwcr.vip' || host.endsWith('.hwcr.vip'))) return null;

    const pageCategory = harvestCategory(`${document.title || ''}\n${location.href}`, location.href);
    const records = [];
    const seen = new Set();
    const anchors = [...document.querySelectorAll('a[href]')].filter(visible);

    for (const anchor of anchors) {
      const rawHref = anchor.href || anchor.getAttribute('href') || '';
      if (!rawHref || /^(javascript:|mailto:|tel:|#)/i.test(rawHref)) continue;
      const detailUrl = normalizedHarvestUrl(rawHref);
      let parsed;
      try { parsed = new URL(detailUrl); } catch { continue; }
      if (!/^https?:$/.test(parsed.protocol)) continue;

      const root = harvestRecordRoot(anchor);
      const lines = harvestLines(root);
      const text = cleanText(lines.join(' | '), 2200);
      const sourceId = harvestSourceId(detailUrl);
      const category = harvestCategory(text, detailUrl) || pageCategory;
      if (!category) continue;
      if (text.length < 18 && !sourceId) continue;

      const titleCandidate = cleanText(
        anchor.innerText || root.querySelector?.('h1,h2,h3,h4,strong,.title,[class*="title"]')?.innerText || lines[0] || '',
        220
      );
      if (!titleCandidate || /^(首页|主页|招聘|求职|租房|房屋出租|上一页|下一页|下页|更多|more|next)$/i.test(titleCandidate)) continue;

      const phones = [...text.matchAll(/(?:\+?1[\s.\-]?)?(?:\(?\d{3}\)?[\s.\-]?)\d{3}[\s.\-]?\d{4}/g)]
        .map((match) => cleanText(match[0], 40))
        .filter((value, index, all) => value && all.indexOf(value) === index)
        .slice(0, 4);
      const locationLine = lines.find((line) => /(?:城市|地区|地点|地址|区域|location|city)\s*[:：]?/i.test(line)) || '';
      const dateLine = lines.find((line) => /(?:发布时间|发布日期|更新|日期|今天|昨天|分钟前|小时前|\b20\d{2}[-/.年]\d{1,2})/i.test(line)) || '';
      const stableKey = sourceId ? `hwcr:${sourceId}` : `hwcr:${harvestHash(`${category}|${detailUrl}|${titleCandidate}|${text.slice(0, 500)}`)}`;
      if (seen.has(stableKey)) continue;
      seen.add(stableKey);

      records.push({
        stable_key: stableKey,
        source_id: sourceId,
        category,
        title: titleCandidate,
        detail_url: detailUrl,
        detail_ref: harvestRefForElement(anchor),
        location_text: cleanText(locationLine, 180),
        date_text: cleanText(dateLine, 120),
        visible_phones: phones,
        summary: text,
        text_length: text.length
      });
      if (records.length >= 80) break;
    }

    const bodyText = cleanText(document.body?.innerText || '', 12000);
    if (!records.length && pageCategory && bodyText.length >= 80) {
      const phones = [...bodyText.matchAll(/(?:\+?1[\s.\-]?)?(?:\(?\d{3}\)?[\s.\-]?)\d{3}[\s.\-]?\d{4}/g)]
        .map((match) => cleanText(match[0], 40))
        .filter((value, index, all) => value && all.indexOf(value) === index)
        .slice(0, 4);
      const currentUrl = normalizedHarvestUrl(location.href);
      const sourceId = harvestSourceId(currentUrl);
      records.push({
        stable_key: sourceId ? `hwcr:${sourceId}` : `hwcr:${harvestHash(`${pageCategory}|${currentUrl}|${document.title}`)}`,
        source_id: sourceId,
        category: pageCategory,
        title: cleanText(document.querySelector('h1,h2,h3')?.innerText || document.title, 220),
        detail_url: currentUrl,
        detail_ref: null,
        location_text: '',
        date_text: '',
        visible_phones: phones,
        summary: cleanText(bodyText, 2200),
        text_length: Math.min(bodyText.length, 2200)
      });
    }

    mergeHwcrFrontendRecords(records, pageCategory);

    const nextAnchor = anchors.find((anchor) => /^(下一页|下一頁|下页|next|›|»|>)$/i.test(cleanText(anchor.innerText || anchor.getAttribute('aria-label') || '', 30)));
    const counts = records.reduce((acc, record) => {
      acc[record.category] = (acc[record.category] || 0) + 1;
      return acc;
    }, {});
    const scrollHeight = Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
    const viewportBottom = Math.round(window.scrollY + window.innerHeight);

    return {
      site_profile: 'hwcr.vip.v2',
      page_type: records.length > 1 ? 'listing' : (records.length === 1 ? 'detail_or_single' : 'unknown'),
      page_category: pageCategory,
      record_count: records.length,
      category_counts: counts,
      records,
      navigation: {
        next_ref: nextAnchor ? harvestRefForElement(nextAnchor) : null,
        next_url: nextAnchor ? normalizedHarvestUrl(nextAnchor.href) : null,
        scroll_y: Math.round(window.scrollY),
        scroll_height: scrollHeight,
        viewport_bottom: viewportBottom,
        can_scroll_more: viewportBottom + 4 < scrollHeight
      },
      notes: '提取当前页面可见/已加载 DOM，并合并 hwcr.vip 页面自身已经加载的结构化帖子字段；仅输出招聘采集所需字段，不做通用网络抓包，也不会绕过登录、验证码或付费墙。'
    };
  }


  function hwcrNormalizeMatch(value, max = 320) {
    return cleanText(value, max).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  }

  function hwcrCardFieldMap(card) {
    const fields = {};
    for (const field of [...card.querySelectorAll('.pc-field')]) {
      const key = cleanText(field.querySelector('.pc-field-key')?.innerText || '', 120).replace(/[：:]\s*$/, '');
      const valueEl = field.querySelector('.pc-field-val,.pc-price-val');
      const value = cleanText(valueEl?.innerText || '', 500);
      if (key && value && !fields[key]) fields[key] = value;
    }
    return fields;
  }

  function hwcrFieldValue(fields, names) {
    for (const name of names) {
      if (fields[name]) return fields[name];
    }
    for (const [key, value] of Object.entries(fields)) {
      if (names.some((name) => key.includes(name))) return value;
    }
    return '';
  }

  function hwcrContactParts(rawValue) {
    const raw = cleanText(rawValue, 500);
    if (!raw || /^(联系超人|查看联系方式|点击查看|contact)$/i.test(raw)) {
      return { raw: '', phone: '', wechat: '', email: '' };
    }
    const phone = cleanText(raw.match(/(?:\+?1[\s.\-]?)?(?:\(?\d{3}\)?[\s.\-]?)\d{3}[\s.\-]?\d{4}/)?.[0] || '', 100);
    const email = cleanText(raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '', 180);
    let wechat = cleanText(raw.match(/(?:微信|wechat|weixin)\s*[:：]?\s*([A-Za-z][A-Za-z0-9_-]{5,30})/i)?.[1] || '', 120);
    if (!wechat && !phone && !email && /^[A-Za-z][A-Za-z0-9_-]{5,30}$/.test(raw)) wechat = raw;
    return { raw, phone, wechat, email };
  }

  function hwcrRealDetailAnchor(card) {
    const anchors = [...card.querySelectorAll('a[href]')];
    for (const anchor of anchors) {
      const raw = anchor.href || anchor.getAttribute('href') || '';
      if (!raw || /^(javascript:|mailto:|tel:|#)/i.test(raw)) continue;
      try {
        const url = new URL(raw, location.href);
        const host = url.hostname.toLowerCase();
        if (!(host === 'm.hwcr.vip' || host.endsWith('.hwcr.vip'))) continue;
        if (url.href === location.href) continue;
        if (harvestSourceId(url.href) || /(?:detail|post|info|job|view|show)/i.test(url.pathname)) return anchor;
      } catch {}
    }
    return null;
  }

  function hwcrCardSourceId(card, detailUrl = '') {
    const attrs = [
      card.getAttribute('data-id'),
      card.getAttribute('data-post-id'),
      card.getAttribute('data-info-id'),
      card.querySelector('[data-id]')?.getAttribute('data-id'),
      card.querySelector('[data-post-id]')?.getAttribute('data-post-id'),
      card.querySelector('[data-info-id]')?.getAttribute('data-info-id')
    ];
    for (const value of attrs) {
      const clean = cleanText(value, 100);
      if (clean && /^[A-Za-z0-9_-]{2,100}$/.test(clean)) return clean;
    }
    return detailUrl ? harvestSourceId(detailUrl) : null;
  }

  function hwcrMatchSignature(title, locationText, body) {
    const t = hwcrNormalizeMatch(title, 220);
    const l = hwcrNormalizeMatch(locationText, 180);
    const b = hwcrNormalizeMatch(body, 420);
    if (!t || (!l && b.length < 12)) return '';
    return harvestHash(t + '|' + l + '|' + b.slice(0, 160));
  }

  function mergeHwcrFrontendRecords0410(records, pageCategory) {
    const frontend = Array.isArray(hwcrFrontendRecords) ? hwcrFrontendRecords.slice(0, 200) : [];
    const bySourceId = new Map();
    const byDetailUrl = new Map();
    const bySignature = new Map();

    for (const record of records) {
      if (record?.source_id) bySourceId.set(String(record.source_id), record);
      if (record?.detail_url) byDetailUrl.set(normalizedHarvestUrl(record.detail_url), record);
      const signature = hwcrMatchSignature(record?.title, record?.location_text, record?.description_text || record?.summary);
      if (signature) {
        const bucket = bySignature.get(signature) || [];
        bucket.push(record);
        bySignature.set(signature, bucket);
      }
    }

    let mergedCount = 0;
    for (const raw of frontend) {
      if (!raw || typeof raw !== 'object') continue;
      const sourceId = frontendField(raw.source_id || raw.id || raw._id, 100);
      const detailUrl = raw.detail_url ? normalizedHarvestUrl(raw.detail_url) : '';
      const title = frontendField(raw.title, 220);
      const body = frontendField(raw.body || raw.summary, 2400);
      const city = frontendField(raw.city || raw.location_text, 180);
      const category = frontendField(raw.category, 60) || harvestCategory(title + '\n' + body, detailUrl) || pageCategory || 'work_unknown';
      const phone = frontendField(raw.contact_phone, 100);
      const wechat = frontendField(raw.contact_wechat, 120);
      const email = frontendField(raw.contact_email, 180);
      const contactRaw = frontendField(raw.contact_raw, 500);
      const contactSource = frontendField(raw.contact_source, 80) || 'frontend_data';
      const time = frontendField(raw.time || raw.date_text, 120);
      const salary = frontendField(raw.salary || raw.salary_text, 180);

      let target = sourceId ? bySourceId.get(String(sourceId)) : null;
      if (!target && detailUrl) target = byDetailUrl.get(detailUrl) || null;
      if (!target) {
        const signature = hwcrMatchSignature(title, city, body);
        const bucket = signature ? (bySignature.get(signature) || []) : [];
        if (bucket.length === 1) target = bucket[0];
      }

      if (target) {
        if (!target.source_id && sourceId) target.source_id = sourceId;
        if (!target.location_text && city) target.location_text = city;
        if (!target.date_text && time) target.date_text = time;
        if (!target.salary_text && salary) target.salary_text = salary;
        if ((!target.summary || target.summary.length < 18) && body) target.summary = body;
        if (contactRaw) target.contact_raw = contactRaw;
        if (phone) target.contact_phone = phone;
        if (wechat) target.contact_wechat = wechat;
        if (email) target.contact_email = email;
        if (contactRaw || phone || wechat || email) target.contact_source = contactSource;
        target.record_source = 'dom+frontend';
        target.merge_status = 'merged';
        mergedCount += 1;
        continue;
      }

      if (!sourceId && !detailUrl && !title && body.length < 18) continue;
      const stableKey = sourceId
        ? 'hwcr:' + sourceId
        : 'hwcr:frontend:' + harvestHash(category + '|' + title + '|' + city + '|' + body.slice(0, 500));
      if (records.some((record) => record.stable_key === stableKey)) continue;
      const added = {
        stable_key: stableKey,
        source_id: sourceId || null,
        category,
        title,
        detail_url: detailUrl || null,
        source_url: normalizedHarvestUrl(location.href),
        detail_ref: null,
        location_text: city,
        date_text: time,
        salary_text: salary,
        visible_phones: [],
        summary: body || title,
        text_length: (body || title).length,
        record_source: 'frontend',
        merge_status: 'unmatched_frontend'
      };
      if (contactRaw) added.contact_raw = contactRaw;
      if (phone) added.contact_phone = phone;
      if (wechat) added.contact_wechat = wechat;
      if (email) added.contact_email = email;
      if (contactRaw || phone || wechat || email) added.contact_source = contactSource;
      records.push(added);
    }
    return mergedCount;
  }

  function buildHarvestSnapshot0410() {
    const host = String(location.hostname || '').toLowerCase();
    if (!(host === 'm.hwcr.vip' || host.endsWith('.hwcr.vip'))) return null;

    const sourceUrl = normalizedHarvestUrl(location.href);
    const decodedSearch = (() => {
      try { return decodeURIComponent(location.search || ''); } catch { return location.search || ''; }
    })();
    const pageCategory = harvestCategory((document.title || '') + '\n' + decodedSearch, location.href);
    const cards = [...document.querySelectorAll('article.post-card')];
    const records = [];
    const seen = new Set();

    for (const card of cards.slice(0, 160)) {
      const fields = hwcrCardFieldMap(card);
      const title = cleanText(card.querySelector('.pc-title')?.innerText || '', 220);
      const position = hwcrFieldValue(fields, ['招聘岗位', '岗位', '职位', '职位名称', '工作岗位', '求职意向']);
      const salary = cleanText(card.querySelector('.pc-price-val')?.innerText || hwcrFieldValue(fields, ['薪资待遇', '薪资', '工资', '待遇']), 180);
      const locationText = hwcrFieldValue(fields, ['办公地点', '工作地点', '地点', '地址', '城市', '地区', '区域']);
      const description = hwcrFieldValue(fields, ['岗位描述', '职位描述', '工作内容', '描述', '详情', '要求']);
      const sourceText = cleanText(card.querySelector('.pc-source')?.innerText || '', 220);
      const dateText = cleanText(card.querySelector('.pc-time')?.innerText || '', 120);
      const contactElement = card.querySelector('.pc-contact-val');
      const contactText = cleanText(contactElement?.innerText || '', 500);
      const contactHint = /联系超人/.test(contactText || cleanText(card.innerText, 800)) ? '联系超人' : '';
      const contact = hwcrContactParts(contactText);

      const detailAnchor = hwcrRealDetailAnchor(card);
      const detailUrl = detailAnchor ? normalizedHarvestUrl(detailAnchor.href) : null;
      const sourceId = hwcrCardSourceId(card, detailUrl || '');
      const cardText = cleanText(card.innerText || '', 2600);
      const category = harvestCategory(cardText, location.href) || pageCategory || 'work_unknown';
      const summary = description || cleanText(cardText, 2200);
      const stableKey = sourceId
        ? 'hwcr:' + sourceId
        : 'hwcr:dom:' + harvestHash(category + '|' + title + '|' + position + '|' + locationText + '|' + summary.slice(0, 500) + '|' + sourceText);
      if (seen.has(stableKey)) continue;
      seen.add(stableKey);

      const record = {
        stable_key: stableKey,
        source_id: sourceId,
        category,
        title: title || position,
        position_text: position,
        salary_text: salary,
        detail_url: detailUrl,
        source_url: sourceUrl,
        detail_ref: detailAnchor ? harvestRefForElement(detailAnchor) : null,
        location_text: locationText,
        description_text: description,
        source_text: sourceText,
        date_text: dateText,
        contact_hint: contactHint,
        visible_phones: contact.phone ? [contact.phone] : [],
        summary,
        text_length: summary.length,
        record_source: 'dom',
        merge_status: 'dom_only'
      };
      if (contact.raw) record.contact_raw = contact.raw;
      if (contact.phone) record.contact_phone = contact.phone;
      if (contact.wechat) record.contact_wechat = contact.wechat;
      if (contact.email) record.contact_email = contact.email;
      if (contact.raw || contact.phone || contact.wechat || contact.email) record.contact_source = 'visible_dom';
      records.push(record);
    }

    if (!cards.length) {
      const legacy = buildHarvestSnapshot();
      if (legacy) {
        legacy.site_profile = 'hwcr.vip.v4';
        legacy.diagnostics = {
          dom_card_count: 0,
          frontend_record_count: Array.isArray(hwcrFrontendRecords) ? hwcrFrontendRecords.length : 0,
          merged_record_count: 0,
          contact_record_count: (legacy.records || []).filter((record) => (
            (record.visible_phones || []).length || record.contact_phone || record.contact_wechat || record.contact_email || record.contact_raw
          )).length,
          bridge_status: hwcrFrontendDiagnostics?.status || 'not_ready',
          bridge_error: hwcrFrontendDiagnostics?.error || null,
          bridge_source: hwcrFrontendDiagnostics?.bridge_source || null,
          preload_status: hwcrFrontendDiagnostics?.preload_status || null,
          preload_status_detail: hwcrFrontendDiagnostics?.preload_status_detail || null,
          preload_version: hwcrFrontendDiagnostics?.preload_version || null,
          preload_error: hwcrFrontendDiagnostics?.preload_error || null,
          bridge_target_response_count: Number(hwcrFrontendDiagnostics?.target_response_count || 0),
          bridge_parsed_post_count: Number(hwcrFrontendDiagnostics?.parsed_post_count || 0),
          bridge_frontend_contact_record_count: Number(hwcrFrontendDiagnostics?.contact_record_count || 0),
          bridge_response_capture_count: Number(hwcrFrontendDiagnostics?.response_capture_count || hwcrFrontendDiagnostics?.target_response_count || 0),
          bridge_vue_card_count: Number(hwcrFrontendDiagnostics?.vue_card_count || 0),
          bridge_vue_post_count: Number(hwcrFrontendDiagnostics?.vue_post_count || 0),
          bridge_state_scan_count: Number(hwcrFrontendDiagnostics?.state_scan_count || 0),
          fallback_scope: hwcrFrontendDiagnostics?.fallback_scope || null
        };
        legacy.record_count = Array.isArray(legacy.records) ? legacy.records.length : 0;
        return legacy;
      }
    }

    const mergedCount = mergeHwcrFrontendRecords0410(records, pageCategory);
    const anchors = [...document.querySelectorAll('a[href]')].filter(visible);
    const nextAnchor = anchors.find((anchor) => /^(下一页|下一頁|下页|next|›|»|>)$/i.test(cleanText(anchor.innerText || anchor.getAttribute('aria-label') || '', 30)));
    const counts = records.reduce((acc, record) => {
      acc[record.category] = (acc[record.category] || 0) + 1;
      return acc;
    }, {});
    const contactCount = records.filter((record) => (
      (record.visible_phones || []).length || record.contact_phone || record.contact_wechat || record.contact_email || record.contact_raw
    )).length;
    const scrollHeight = Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
    const viewportBottom = Math.round(window.scrollY + window.innerHeight);

    return {
      site_profile: 'hwcr.vip.v4',
      page_type: cards.length ? 'listing' : (records.length === 1 ? 'detail_or_single' : 'unknown'),
      page_category: pageCategory,
      record_count: records.length,
      category_counts: counts,
      records,
      diagnostics: {
        dom_card_count: cards.length,
        frontend_record_count: Array.isArray(hwcrFrontendRecords) ? hwcrFrontendRecords.length : 0,
        merged_record_count: mergedCount,
        contact_record_count: contactCount,
        bridge_status: hwcrFrontendDiagnostics?.status || 'not_ready',
        bridge_error: hwcrFrontendDiagnostics?.error || null,
        bridge_source: hwcrFrontendDiagnostics?.bridge_source || null,
        preload_status: hwcrFrontendDiagnostics?.preload_status || null,
        preload_status_detail: hwcrFrontendDiagnostics?.preload_status_detail || null,
        preload_version: hwcrFrontendDiagnostics?.preload_version || null,
        preload_error: hwcrFrontendDiagnostics?.preload_error || null,
        bridge_target_response_count: Number(hwcrFrontendDiagnostics?.target_response_count || 0),
        bridge_parsed_post_count: Number(hwcrFrontendDiagnostics?.parsed_post_count || 0),
        bridge_frontend_contact_record_count: Number(hwcrFrontendDiagnostics?.contact_record_count || 0),
        bridge_response_capture_count: Number(hwcrFrontendDiagnostics?.response_capture_count || hwcrFrontendDiagnostics?.target_response_count || 0),
        bridge_vue_card_count: Number(hwcrFrontendDiagnostics?.vue_card_count || 0),
        bridge_vue_post_count: Number(hwcrFrontendDiagnostics?.vue_post_count || 0),
        bridge_state_scan_count: Number(hwcrFrontendDiagnostics?.state_scan_count || 0),
        fallback_scope: hwcrFrontendDiagnostics?.fallback_scope || null
      },
      navigation: {
        next_ref: nextAnchor ? harvestRefForElement(nextAnchor) : null,
        next_url: nextAnchor ? normalizedHarvestUrl(nextAnchor.href) : null,
        scroll_y: Math.round(window.scrollY),
        scroll_height: scrollHeight,
        viewport_bottom: viewportBottom,
        can_scroll_more: viewportBottom + 4 < scrollHeight
      },
      notes: '0.4.10: article.post-card DOM 记录与 document_start 捕获的 convenience.getConvenienceList 安全字段独立产生；按帖子 ID/详情 URL/强组合指纹合并，预加载桥失败时 DOM 记录仍保留。'
    };
  }

  function accessibleName(el) {
    if (isXtermElement(el)) return xtermName(el);
    return cleanText(
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.innerText ||
      el.value ||
      el.getAttribute('placeholder') ||
      el.getAttribute('name') ||
      el.id || ''
    );
  }

  function roleFor(el) {
    return el.getAttribute('role') || el.tagName.toLowerCase();
  }

  function xtermRoot(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.matches?.('.xterm')) return el;
    return el.closest?.('.xterm') || null;
  }

  function isXtermElement(el) {
    return !!xtermRoot(el);
  }

  function xtermTextarea(el) {
    const root = xtermRoot(el);
    if (!root) return null;
    if (String(el.tagName || '').toLowerCase() === 'textarea' && el.matches?.('.xterm-helper-textarea')) return el;
    return root.querySelector('textarea.xterm-helper-textarea, textarea[aria-label*="Terminal" i], textarea[aria-label*="终端"]');
  }

  function xtermName(el) {
    const root = xtermRoot(el);
    const input = xtermTextarea(el);
    return cleanText(
      root?.getAttribute('aria-label') ||
      input?.getAttribute('aria-label') ||
      root?.getAttribute('title') ||
      'Terminal / xterm',
      160
    );
  }

  function xtermOutput(el, max = 6000) {
    const root = xtermRoot(el);
    if (!root) return '';
    const rows = [...root.querySelectorAll('.xterm-rows > div')];
    const raw = rows.length
      ? rows.map((row) => row.innerText || row.textContent || '').join('\n')
      : (root.querySelector('.xterm-screen')?.innerText || root.innerText || '');
    return String(raw || '').replace(/\u00a0/g, ' ').replace(/[ \t]+$/gm, '').trim().slice(-Math.max(500, max));
  }

  function isEditableElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (isXtermElement(el)) return true;
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    return tag === 'textarea' ||
      tag === 'select' ||
      (tag === 'input' && type !== 'hidden') ||
      role === 'textbox' ||
      el.isContentEditable;
  }

  function collectDocuments(doc = document, output = [], seen = new Set()) {
    if (!doc || seen.has(doc)) return output;
    seen.add(doc);
    output.push(doc);
    for (const frame of doc.querySelectorAll('iframe,frame')) {
      try {
        if (frame.contentDocument) collectDocuments(frame.contentDocument, output, seen);
      } catch {}
    }
    return output;
  }

  function collectInteractiveFromRoot(root, output, seenRoots) {
    if (!root || seenRoots.has(root)) return;
    seenRoots.add(root);
    for (const el of root.querySelectorAll(INTERACTIVE_SELECTOR)) output.push(el);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) collectInteractiveFromRoot(el.shadowRoot, output, seenRoots);
    }
  }

  function collectInteractiveNodes() {
    const output = [];
    const seenRoots = new Set();
    for (const doc of collectDocuments()) collectInteractiveFromRoot(doc, output, seenRoots);
    const normalized = [];
    const seen = new Set();
    for (const el of output) {
      const target = xtermRoot(el) || el;
      if (seen.has(target) || !visible(target)) continue;
      seen.add(target);
      normalized.push(target);
    }
    return normalized;
  }

  function rectInTopViewport(el) {
    const rect = el.getBoundingClientRect();
    let x = rect.x;
    let y = rect.y;
    let currentWindow = el.ownerDocument?.defaultView;
    try {
      while (currentWindow && currentWindow !== window) {
        const frameElement = currentWindow.frameElement;
        if (!frameElement) break;
        const frameRect = frameElement.getBoundingClientRect();
        x += frameRect.x;
        y += frameRect.y;
        currentWindow = frameElement.ownerDocument?.defaultView;
      }
    } catch {}
    return { x, y, width: rect.width, height: rect.height };
  }

  function buildRefs() {
    refs = new Map();
    let index = 1;
    const allNodes = collectInteractiveNodes();
    const ordered = [];
    const seen = new Set();
    const add = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      ordered.push(el);
    };

    for (const doc of collectDocuments()) {
      const active = doc.activeElement;
      if (allNodes.includes(active) && isEditableElement(active)) add(active);
    }
    for (const el of allNodes) if (isEditableElement(el)) add(el);
    for (const el of allNodes) add(el);

    for (const el of ordered.slice(0, 600)) refs.set(`r${index++}`, el);
    return refs;
  }

  function collectMediaNodes() {
    const output = [];
    for (const doc of collectDocuments()) {
      for (const el of doc.querySelectorAll('img,picture,svg,canvas,video')) {
        if (visible(el)) output.push(el);
      }
      // CSS background images are visual content too. Keep this bounded so a
      // page with a large utility stylesheet cannot turn observation into a
      // full-DOM scan payload.
      for (const el of [...doc.querySelectorAll('*')].slice(0, 4000)) {
        if (!visible(el) || output.includes(el)) continue;
        try {
          const background = doc.defaultView?.getComputedStyle(el).backgroundImage || '';
          if (background && background !== 'none' && /url\(/i.test(background)) output.push(el);
        } catch {}
        if (output.length >= 80) break;
      }
    }
    return output.slice(0, 80);
  }

  function syncPageIdentity() {
    const currentUrl = location.href;
    if (currentUrl !== pageGenerationUrl) {
      pageGeneration += 1;
      pageGenerationUrl = currentUrl;
      refs = new Map();
      mediaRefs = new Map();
    }
  }

  function buildMediaRefs() {
    syncPageIdentity();
    mediaRefs = new Map();
    let index = 1;
    for (const el of collectMediaNodes()) {
      mediaRefs.set(`m${index++}`, { element: el, page_generation: pageGeneration, page_revision: pageRevision });
    }
    return mediaRefs;
  }

  function mediaSummary(ref, el) {
    const rect = rectInTopViewport(el);
    const tag = String(el?.tagName || '').toLowerCase();
    const parent = el?.closest?.('figure,article,main,section,form,li,td') || el?.parentElement;
    return {
      ref,
      kind: tag === 'img' ? 'image' : tag,
      tag,
      frame_id: 'main',
      page_generation: pageGeneration,
      page_revision: pageRevision,
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      alt: cleanText(el?.getAttribute?.('alt') || '', 240),
      title: cleanText(el?.getAttribute?.('title') || '', 240),
      nearby_text: cleanText(parent?.innerText || '', 320),
      visible: visible(el),
      loaded: tag === 'img' ? !!el.complete && Number(el.naturalWidth || 0) > 0 : true,
      source_available: tag === 'img' ? !!(el.currentSrc || el.src) : true,
      source_kind: tag === 'img' ? 'img' : tag
    };
  }

  function pageSnapshot() {
    syncPageIdentity();
    buildRefs();
    buildMediaRefs();
    const elements = [];
    for (const [ref, el] of refs.entries()) {
      const inputType = (el.getAttribute('type') || '').toLowerCase();
      const sensitive = inputType === 'password';
      const terminal = isXtermElement(el);
      const nativeSelect = isNativeSelect(el);
      const terminalInput = terminal ? xtermTextarea(el) : null;
      const rect = rectInTopViewport(el);
      elements.push({
        ref,
        role: terminal ? 'terminal' : roleFor(el),
        tag: el.tagName.toLowerCase(),
        name: accessibleName(el),
        type: inputType || null,
        value: terminal ? '' : (sensitive ? '[REDACTED]' : cleanText(el.value || '', 160)),
        selected_label: nativeSelect ? selectedLabel(el) : undefined,
        options: nativeSelect ? [...el.options].slice(0, 100).map((option) => ({ value: String(option.value), label: cleanText(option.text, 240), disabled: !!option.disabled })) : undefined,
        placeholder: terminal ? '' : cleanText(el.getAttribute('placeholder') || '', 180),
        editable: isEditableElement(el),
        focused: terminal ? !!terminalInput && isActuallyFocused(terminalInput) : isActuallyFocused(el),
        adapter: terminal ? 'xterm' : (nativeSelect ? 'native-select' : undefined),
        terminal: terminal || undefined,
        terminal_output: terminal ? xtermOutput(el, 4000) : undefined,
        checked: typeof el.checked === 'boolean' ? el.checked : undefined,
        disabled: !!el.disabled,
        href: el.tagName === 'A' ? cleanText(el.href, 300) : undefined,
        bounds: {
          x: Math.round(rect.x), y: Math.round(rect.y),
          width: Math.round(rect.width), height: Math.round(rect.height)
        }
      });
    }

    const docs = collectDocuments();
    const headings = docs.flatMap((doc) => [...doc.querySelectorAll('h1,h2,h3,[role="heading"]')])
      .filter(visible).slice(0, 40).map((el) => cleanText(el.innerText, 300)).filter(Boolean);
    const bodyText = cleanText(docs.map((doc) => doc.body?.innerText || '').join('\n'), 16000);
    const selection = cleanText(window.getSelection?.().toString() || '', 2000);
    const frames = [...document.querySelectorAll('iframe,frame')].filter(visible).slice(0, 40).map((frame, index) => {
      const rect = frame.getBoundingClientRect();
      let sameOrigin = false;
      try { sameOrigin = !!frame.contentDocument; } catch {}
      return {
        index,
        name: cleanText(frame.getAttribute('name') || frame.getAttribute('title') || '', 120),
        src: cleanText(frame.src || '', 400),
        same_origin: sameOrigin,
        bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      };
    });
    const media = [...mediaRefs.entries()].map(([ref, record]) => mediaSummary(ref, record.element));
    const taskRoot = document.querySelector('main,[role="main"],article,form') || document.body;

    return {
      ok: true,
      action: 'snapshot',
      page: {
        url: location.href,
        origin: location.origin,
        title: document.title,
        page_revision: pageRevision,
        page_generation: pageGeneration,
        frame_generation: 1,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
          scrollWidth: Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0),
          scrollHeight: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0),
          devicePixelRatio: window.devicePixelRatio || 1
        },
        headings,
        selection,
        text: bodyText,
        content: { text: bodyText, headings, media },
        task_region: { text: cleanText(taskRoot?.innerText || bodyText, 16000), media_refs: media.map((item) => item.ref) },
        visual: { available: media.length > 0, refs: media, delivery: 'element_image_or_viewport_screenshot' },
        media,
        media_count: media.length,
        frames,
        elements,
        harvest: buildHarvestSnapshot0410()
      }
    };
  }

  function requireRef(ref) {
    if (!refs.size) buildRefs();
    const el = refs.get(ref);
    if (!el || !el.isConnected) throw new Error(`元素 ${ref} 已失效，请重新读取页面`);
    return el;
  }

  function requireMediaRef(ref) {
    if (!mediaRefs.size) buildMediaRefs();
    const record = mediaRefs.get(String(ref || ''));
    if (!record || !record.element?.isConnected || record.page_generation !== pageGeneration || record.page_revision !== pageRevision) {
      throw new Error(`BROWSER_REF_STALE: 图像 ${ref} 已失效，请重新读取页面`);
    }
    return record;
  }

  function isSensitiveClick(el) {
    const text = accessibleName(el).toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const riskyWords = [
      'send', 'submit', 'pay', 'purchase', 'buy', 'order', 'confirm', 'delete', 'remove',
      'publish', 'post', 'transfer', 'wire', 'sign', 'accept', 'agree', '发送', '提交', '付款',
      '购买', '下单', '确认', '删除', '发布', '转账', '同意'
    ];
    return type === 'submit' || riskyWords.some((word) => text.includes(word));
  }

  function sensitiveSummary(el) {
    return `敏感操作：${accessibleName(el) || roleFor(el)}。需要用户确认后才能执行。`;
  }

  function dispatchInputEvents(el) {
    const view = el.ownerDocument?.defaultView || window;
    const EventCtor = view.Event || Event;
    el.dispatchEvent(new EventCtor('input', { bubbles: true }));
    el.dispatchEvent(new EventCtor('change', { bubbles: true }));
  }

  function deepActiveElement(doc) {
    let active = doc?.activeElement || null;
    let guard = 0;
    while (active?.shadowRoot?.activeElement && guard++ < 8) active = active.shadowRoot.activeElement;
    return active;
  }

  function isActuallyFocused(el) {
    return !!el && deepActiveElement(el.ownerDocument) === el;
  }

  function isNativeSelect(el) {
    return !!el && String(el.tagName || '').toLowerCase() === 'select';
  }

  function selectedLabel(el) {
    if (!isNativeSelect(el)) return '';
    return cleanText(el.selectedOptions?.[0]?.text || el.options?.[el.selectedIndex]?.text || '', 240);
  }

  function selectResolver(el) {
    const doc = el.ownerDocument;
    const id = String(el.id || '');
    const name = String(el.getAttribute('name') || '');
    const index = [...doc.querySelectorAll('select')].indexOf(el);
    return () => {
      if (el.isConnected) return el;
      if (id) {
        const byId = doc.getElementById(id);
        if (isNativeSelect(byId)) return byId;
      }
      if (name) {
        const matches = [...doc.querySelectorAll('select')].filter((candidate) => candidate.getAttribute('name') === name);
        if (matches.length === 1) return matches[0];
      }
      return index >= 0 ? doc.querySelectorAll('select')[index] || null : null;
    };
  }

  async function selectElement(el, request = {}) {
    if (!isNativeSelect(el)) throw new Error('SELECT_TARGET_NOT_NATIVE: 目标元素不是原生 HTML <select>');
    const hasValue = request.value !== undefined && request.value !== null;
    const hasLabel = request.label !== undefined && request.label !== null;
    if (!hasValue && !hasLabel) throw new Error('SELECT_OPTION_REQUIRED: select 需要 value 或 label');

    const requestedValue = hasValue ? String(request.value) : null;
    const requestedLabel = hasLabel ? cleanText(request.label, 500) : null;
    const options = [...el.options];
    const option = hasValue
      ? options.find((candidate) => String(candidate.value) === requestedValue)
      : options.find((candidate) => cleanText(candidate.text, 500) === requestedLabel);
    if (!option) {
      throw new Error(`SELECT_OPTION_NOT_FOUND: ${hasValue ? `value=${requestedValue}` : `label=${requestedLabel}`}`);
    }

    const expectedValue = String(option.value);
    const expectedLabel = cleanText(option.text, 500);
    const resolveLive = selectResolver(el);
    const view = el.ownerDocument?.defaultView || window;
    const SelectCtor = view.HTMLSelectElement || HTMLSelectElement;
    const descriptor = Object.getOwnPropertyDescriptor(SelectCtor.prototype, 'value');
    if (descriptor?.set) descriptor.set.call(el, expectedValue);
    else el.value = expectedValue;
    dispatchInputEvents(el);
    if (request.blur) el.blur();

    await new Promise((resolve) => view.setTimeout(resolve, 60));

    const live = resolveLive();
    if (!live || !isNativeSelect(live)) {
      throw new Error('SELECT_TARGET_DISAPPEARED: select 在事件处理后被页面移除且无法重新定位');
    }
    const actualValue = String(live.value ?? '');
    const actualLabel = selectedLabel(live);
    if (actualValue !== expectedValue) {
      throw new Error(`SELECT_VALUE_NOT_CHANGED: expected=${expectedValue} actual=${actualValue}`);
    }
    return {
      ok: true,
      adapter: 'native-select',
      selected_value: actualValue,
      selected_label: actualLabel,
      expected_value: expectedValue,
      expected_label: expectedLabel,
      verified: true,
      focused: isActuallyFocused(live)
    };
  }

  function focusableInDocument(doc) {
    const nodes = collectInteractiveNodes().filter((el) => el.ownerDocument === doc && visible(el) && !el.disabled);
    const candidates = nodes.filter((el) => {
      const tag = String(el.tagName || '').toLowerCase();
      const type = String(el.getAttribute?.('type') || '').toLowerCase();
      const tabindex = Number(el.getAttribute?.('tabindex'));
      if (el.hasAttribute?.('tabindex') && tabindex < 0) return false;
      if (tag === 'input' && type === 'hidden') return false;
      return ['a', 'button', 'input', 'textarea', 'select'].includes(tag) || el.isContentEditable || el.hasAttribute?.('tabindex');
    });
    const positive = candidates.filter((el) => Number(el.getAttribute?.('tabindex')) > 0)
      .sort((a, b) => Number(a.getAttribute('tabindex')) - Number(b.getAttribute('tabindex')) || candidates.indexOf(a) - candidates.indexOf(b));
    return [...positive, ...candidates.filter((el) => Number(el.getAttribute?.('tabindex')) <= 0 || !el.hasAttribute?.('tabindex'))];
  }

  function moveFocus(el, backwards = false) {
    const doc = el.ownerDocument;
    const focusable = focusableInDocument(doc);
    const active = deepActiveElement(doc) || el;
    let index = focusable.indexOf(active);
    if (index < 0) index = focusable.indexOf(el);
    const nextIndex = backwards ? index - 1 : index + 1;
    const next = focusable[nextIndex] || null;
    if (next) next.focus({ preventScroll: true });
    else active?.blur?.();
    const actual = deepActiveElement(doc);
    return {
      moved: actual !== active,
      focused: actual ? { tag: String(actual.tagName || '').toLowerCase(), name: accessibleName(actual) } : null
    };
  }

  async function selectByKeyboard(el, key) {
    if (!isNativeSelect(el)) throw new Error('SELECT_TARGET_NOT_NATIVE: 目标元素不是原生 HTML <select>');
    const options = [...el.options];
    if (!options.length) throw new Error('SELECT_OPTION_NOT_FOUND: select 没有可用选项');
    const normalized = String(key || '').toLowerCase();
    let index = Math.max(0, el.selectedIndex);
    if (normalized === 'home') index = 0;
    else if (normalized === 'end') index = options.length - 1;
    else if (normalized === 'arrowdown') index = Math.min(options.length - 1, index + 1);
    else if (normalized === 'arrowup') index = Math.max(0, index - 1);
    else throw new Error(`NATIVE_SELECT_USE_SELECT_OPERATION: 原生 select 不支持以 ${key} 作为可靠选择方式，请使用 operation=select`);
    const direction = normalized === 'arrowup' || normalized === 'home' ? -1 : 1;
    while (options[index]?.disabled && index >= 0 && index < options.length) index += direction;
    if (index < 0 || index >= options.length) index = Math.max(0, Math.min(el.selectedIndex, options.length - 1));
    return await selectElement(el, { value: options[index].value });
  }

  function xtermKeyData(key) {
    const raw = String(key ?? '');
    if (raw === '\r' || raw === '\t' || raw === '\x7f' || raw === '\x03' || raw === '\x04') return raw;
    const normalized = raw.trim().replace(/\s+/g, '').toLowerCase();
    const keyMap = {
      enter: '\r',
      numpadenter: '\r',
      tab: '\t',
      backspace: '\x7f',
      'ctrl+c': '\x03',
      'control+c': '\x03',
      '^c': '\x03',
      'ctrl+d': '\x04',
      'control+d': '\x04',
      '^d': '\x04'
    };
    return keyMap[normalized] ?? null;
  }

  function xtermSendData(el, data) {
    const input = xtermTextarea(el);
    if (!input) throw new Error('检测到 xterm，但没有找到 .xterm-helper-textarea 输入适配器');
    const text = String(data ?? '');
    if (!text) return { input, length: 0 };
    input.focus({ preventScroll: true });

    const view = input.ownerDocument?.defaultView || window;
    const InputEventCtor = view.InputEvent || InputEvent;
    const TextAreaCtor = view.HTMLTextAreaElement || HTMLTextAreaElement;
    const descriptor = Object.getOwnPropertyDescriptor(TextAreaCtor.prototype, 'value');

    // xterm.js consumes text/control bytes from its hidden helper textarea input channel.
    // Do not synthesize keydown/keyup for terminal control keys: many xterm builds ignore them.
    descriptor?.set?.call(input, text);
    input.dispatchEvent(new InputEventCtor('input', {
      data: text,
      inputType: 'insertText',
      bubbles: true,
      cancelable: false,
      composed: true
    }));
    if (input.value === text) descriptor?.set?.call(input, '');
    return { input, length: text.length };
  }

  function xtermSendKey(el, key) {
    const data = xtermKeyData(key);
    if (data == null) throw new Error(`xterm 暂不支持直接发送按键：${String(key || '')}`);
    return xtermSendData(el, data);
  }

  function xtermInputText(el, value) {
    return xtermSendData(el, String(value ?? ''));
  }

  function fillElement(el, value) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (REDACTED_INPUT_TYPES.has(type)) throw new Error('默认禁止填写密码/隐藏字段');
    if (type === 'file') throw new Error('文件上传必须走独立授权流程，当前版本不允许自动上传');
    const expected = String(value ?? '');
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      descriptor?.set?.call(el, expected);
      dispatchInputEvents(el);
      return expected;
    }
    if (el.isContentEditable) {
      el.focus();
      el.textContent = expected;
      dispatchInputEvents(el);
      return expected;
    }
    throw new Error('目标元素不是可填写字段');
  }

  async function fillAndVerify(el, value) {
    const expected = fillElement(el, value);
    const view = el.ownerDocument?.defaultView || window;
    await new Promise((resolve) => view.setTimeout(resolve, 50));
    if (!el.isConnected) throw new Error('FILL_TARGET_DISAPPEARED: 输入事件后目标元素被页面移除');
    const actual = el.isContentEditable ? String(el.textContent ?? '') : String(el.value ?? '');
    if (actual !== expected) {
      throw new Error(`FILL_VALUE_NOT_CHANGED: expected=${expected} actual=${actual}`);
    }
    return {
      ok: true,
      adapter: el.isContentEditable ? 'contenteditable' : 'native-input',
      verified: true,
      value_length: actual.length,
      focused: isActuallyFocused(el)
    };
  }

  function setHighlight(el) {
    if (highlighted) highlighted.style.outline = highlighted.dataset.penguinOldOutline || '';
    highlighted = el;
    highlighted.dataset.penguinOldOutline = highlighted.style.outline || '';
    highlighted.style.outline = '3px solid #6d5dfc';
    highlighted.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }

  function ensureOverlay() {
    if (overlay?.isConnected) return overlay;
    overlay = document.createElement('div');
    overlay.id = '__penguin_assistant_overlay';
    Object.assign(overlay.style, {
      position: 'fixed', top: '12px', right: '12px', zIndex: '2147483647',
      padding: '8px 12px', borderRadius: '999px', font: '13px/1.2 system-ui,sans-serif',
      color: '#fff', background: 'rgba(25,25,35,.88)', boxShadow: '0 8px 30px rgba(0,0,0,.25)',
      pointerEvents: 'none', backdropFilter: 'blur(10px)'
    });
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function updateOverlay() {
    if (!authorized) {
      overlay?.remove();
      overlay = null;
      return;
    }
    const el = ensureOverlay();
    const scopeText = scope === 'browser' ? '当前浏览器会话' : '当前标签页';
    el.textContent = mode === 'interact' ? `🐧 企鹅助理：${scopeText}可查看 + 操作` : `🐧 企鹅助理：${scopeText}仅查看`;
  }

  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    let guard = 0;
    while (el?.shadowRoot && guard++ < 8) {
      const inner = el.shadowRoot.elementFromPoint?.(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (el?.tagName === 'IFRAME' || el?.tagName === 'FRAME') {
      try {
        const frameRect = el.getBoundingClientRect();
        const inner = el.contentDocument?.elementFromPoint?.(x - frameRect.x, y - frameRect.y);
        if (inner) el = inner;
      } catch {}
    }
    return el;
  }

  function findMatches(query, role = '') {
    buildRefs();
    const q = cleanText(query, 300).toLowerCase();
    const wantedRole = cleanText(role, 80).toLowerCase();
    const matches = [];
    for (const [ref, el] of refs.entries()) {
      const name = accessibleName(el);
      const elementRole = isXtermElement(el) ? 'terminal' : roleFor(el);
      if (wantedRole && elementRole.toLowerCase() !== wantedRole) continue;
      if (q && !`${name} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('name') || ''}`.toLowerCase().includes(q)) continue;
      const rect = rectInTopViewport(el);
      matches.push({
        ref,
        role: elementRole,
        tag: el.tagName.toLowerCase(),
        name,
        editable: isEditableElement(el),
        bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      });
      if (matches.length >= 40) break;
    }
    return matches;
  }

  async function waitForPageChange(baselineRevision, baselineUrl, timeoutMs = 2500) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (pageRevision !== baselineRevision || location.href !== baselineUrl) return true;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return false;
  }

  async function scrollPage(command) {
    if (command.ref) {
      const el = requireRef(command.ref);
      el.scrollIntoView({ behavior: command.behavior === 'instant' ? 'auto' : 'smooth', block: command.block || 'center', inline: 'nearest' });
    } else if (command.to === 'top') {
      window.scrollTo({ top: 0, left: Number(command.x || 0), behavior: command.behavior === 'instant' ? 'auto' : 'smooth' });
    } else if (command.to === 'bottom') {
      const bottom = Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
      window.scrollTo({ top: bottom, left: Number(command.x || 0), behavior: command.behavior === 'instant' ? 'auto' : 'smooth' });
    } else if (command.absolute) {
      window.scrollTo({ top: Number(command.y || 0), left: Number(command.x || 0), behavior: command.behavior === 'instant' ? 'auto' : 'smooth' });
    } else {
      window.scrollBy({ top: Number(command.y ?? 600), left: Number(command.x || 0), behavior: command.behavior === 'instant' ? 'auto' : 'smooth' });
    }
    await new Promise((resolve) => setTimeout(resolve, command.behavior === 'instant' ? 40 : 220));
    return {
      ok: true,
      action: 'scroll',
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      scrollHeight: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0)
    };
  }

  async function executeSequence(command = {}) {
    const steps = Array.isArray(command.steps) ? command.steps : [];
    if (!steps.length) throw new Error('SEQUENCE_STEPS_REQUIRED: sequence 至少需要一个步骤');
    if (steps.length > 32) throw new Error('SEQUENCE_TOO_LARGE: sequence 最多 32 个步骤');
    const allowed = new Set(['fill', 'select', 'click', 'key', 'press', 'scroll', 'find', 'waitForChange', 'wait_for_change']);
    const timeoutMs = Math.max(250, Math.min(Number(command.timeout_ms || 8000), 20000));
    const started = Date.now();
    const results = [];

    for (let index = 0; index < steps.length; index += 1) {
      if (Date.now() - started > timeoutMs) throw new Error(`SEQUENCE_TIMEOUT: completed=${index} total=${steps.length}`);
      const raw = steps[index] && typeof steps[index] === 'object' ? { ...steps[index] } : null;
      if (!raw) throw new Error(`SEQUENCE_STEP_INVALID: index=${index}`);
      let action = String(raw.action || raw.operation || '').trim();
      if (action === 'press') action = 'key';
      if (action === 'wait_for_change') action = 'waitForChange';
      if (!allowed.has(action)) throw new Error(`SEQUENCE_STEP_UNSUPPORTED: index=${index} action=${action || '<empty>'}`);
      if (action === 'clickPoint' || action === 'sequence') throw new Error(`SEQUENCE_STEP_UNSUPPORTED: index=${index} action=${action}`);

      const baselineRevision = pageRevision;
      const baselineUrl = location.href;
      const stepCommand = { ...raw, action };
      if (raw.target && !raw.ref) stepCommand.ref = raw.target;
      const result = await execute(stepCommand);
      if (result?.confirmationRequired) {
        return {
          ok: false,
          action: 'sequence',
          confirmationRequired: true,
          summary: result.summary || 'sequence 中包含需要用户确认的敏感操作',
          completed_steps: index,
          pending_step: index,
          results
        };
      }
      results.push({ index, action, ok: result?.ok !== false, verified: result?.verified ?? null, adapter: result?.adapter || null, changed: result?.changed ?? null });

      const waitMs = Math.max(0, Math.min(Number(raw.wait_for_change_ms || 0), 5000));
      if (waitMs > 0) {
        const changed = await waitForPageChange(baselineRevision, baselineUrl, waitMs);
        results[results.length - 1].changed = changed;
      }
    }

    return {
      ok: true,
      action: 'sequence',
      verified: true,
      completed_steps: steps.length,
      total_steps: steps.length,
      duration_ms: Date.now() - started,
      results,
      snapshot: pageSnapshot()
    };
  }

  async function execute(command = {}) {
    if (!authorized) throw new Error('当前标签页尚未授权');
    const action = command.action || 'snapshot';
    if (!['snapshot', 'getSelection', 'find', 'waitForChange', 'terminal_read'].includes(action) && mode !== 'interact') {
      throw new Error('当前为仅查看模式');
    }

    if (action === 'snapshot') return pageSnapshot();
    if (action === 'elementImage') {
      syncPageIdentity();
      if (command.expected_page_revision && String(command.expected_page_revision) !== String(pageRevision)) {
        throw new Error(`BROWSER_REF_STALE: expected_page_revision=${command.expected_page_revision} current_page_revision=${pageRevision}`);
      }
      if (command.expected_page_generation && Number(command.expected_page_generation) !== Number(pageGeneration)) {
        throw new Error(`BROWSER_REF_STALE: expected_page_generation=${command.expected_page_generation} current_page_generation=${pageGeneration}`);
      }
      const ref = String(command.ref || command.target || '').trim();
      if (!ref) throw new Error('BROWSER_ELEMENT_IMAGE_TARGET_REQUIRED');
      const record = requireMediaRef(ref);
      const el = record.element;
      const summary = mediaSummary(ref, el);
      try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch {}
      const tag = String(el.tagName || '').toLowerCase();
      let imageDataUrl = null;
      if (tag === 'img' && el.complete && el.naturalWidth > 0) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = Math.min(2400, Math.max(1, el.naturalWidth));
          canvas.height = Math.min(2400, Math.max(1, Math.round(el.naturalHeight * (canvas.width / Math.max(1, el.naturalWidth)))));
          const context = canvas.getContext('2d');
          context.drawImage(el, 0, 0, canvas.width, canvas.height);
          imageDataUrl = canvas.toDataURL('image/png');
        } catch {}
      }
      return { ok: true, action, ref, metadata: summary, image_data_url: imageDataUrl, needs_viewport_capture: !imageDataUrl };
    }
    if (action === 'sequence') return await executeSequence(command);
    if (action === 'getSelection') return { ok: true, action, selection: cleanText(window.getSelection?.().toString() || '', 4000) };
    if (action === 'find') return { ok: true, action, matches: findMatches(command.query || '', command.role || '') };
    if (action === 'terminal_read') {
      buildRefs();
      const selected = command.ref ? [[command.ref, requireRef(command.ref)]] : [...refs.entries()];
      const terminals = selected
        .filter(([, el]) => isXtermElement(el))
        .slice(0, 20)
        .map(([ref, el]) => ({
          ref,
          name: xtermName(el),
          adapter: 'xterm',
          focused: !!xtermTextarea(el) && isActuallyFocused(xtermTextarea(el)),
          output: xtermOutput(el, Math.max(500, Math.min(Number(command.max_chars || 6000), 16000)))
        }));
      if (command.ref && !terminals.length) throw new Error('目标元素不是 xterm 终端');
      return { ok: true, action, terminals };
    }
    if (action === 'waitForChange') {
      const changed = await waitForPageChange(Number(command.page_revision || pageRevision), String(command.url || location.href), Math.max(100, Math.min(Number(command.timeout_ms || 2500), 10000)));
      return { ok: true, action, changed, snapshot: pageSnapshot() };
    }

    if (action === 'scroll') return await scrollPage(command);

    if (action === 'clickPoint') {
      const x = Number(command.x);
      const y = Number(command.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
        throw new Error('视觉点击坐标超出当前可见视口');
      }
      const el = deepElementFromPoint(x, y);
      if (!el) throw new Error('视觉坐标处没有可点击元素');
      if (isSensitiveClick(el) && !command.confirmed) {
        return { ok: false, confirmationRequired: true, summary: sensitiveSummary(el) };
      }
      const tag = String(el.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select', 'button'].includes(tag) || el.isContentEditable || el.hasAttribute?.('tabindex')) {
        el.focus?.({ preventScroll: true });
      }
      setHighlight(el);
      el.click();
      return { ok: true, action, x, y, role: roleFor(el), name: accessibleName(el), sensitive: isSensitiveClick(el), verified: true, focused: isActuallyFocused(el) };
    }

    if (action === 'key') {
      const key = String(command.key || '').trim();
      if (!key) throw new Error('缺少按键');
      const el = command.ref ? requireRef(command.ref) : document.activeElement;
      if (!el) throw new Error('找不到按键目标');
      const terminalData = isXtermElement(el) ? xtermKeyData(key) : null;
      if (terminalData != null) {
        if (terminalData === '\r' && !command.confirmed) {
          return { ok: false, confirmationRequired: true, summary: '将在网页 Terminal/xterm 中发送 Enter 执行当前命令，需要用户确认。' };
        }
        xtermSendKey(el, terminalData);
        setHighlight(xtermRoot(el) || el);
        return { ok: true, action, key, ref: command.ref || null, adapter: 'xterm', data_code: terminalData.charCodeAt(0) };
      }
      const normalizedKey = key.toLowerCase();
      if (isNativeSelect(el) && ['arrowdown', 'arrowup', 'home', 'end'].includes(normalizedKey)) {
        const selected = await selectByKeyboard(el, key);
        setHighlight(el);
        return { ...selected, action, key, ref: command.ref || null };
      }
      if (isNativeSelect(el) && ['enter', 'numpadenter'].includes(normalizedKey)) {
        return {
          ok: true,
          action,
          key,
          ref: command.ref || null,
          adapter: 'native-select',
          selected_value: String(el.value ?? ''),
          selected_label: selectedLabel(el),
          verified: true,
          focused: isActuallyFocused(el)
        };
      }
      if (normalizedKey === 'tab' || normalizedKey === 'shift+tab') {
        if (command.ref && !isActuallyFocused(el)) el.focus?.({ preventScroll: true });
        const focusResult = moveFocus(el, normalizedKey === 'shift+tab');
        return { ok: true, action, key, ref: command.ref || null, verified: true, focus_moved: focusResult.moved, focused: focusResult.focused };
      }
      if ((key === 'Enter' || key === 'NumpadEnter') && isSensitiveClick(el) && !command.confirmed) {
        return { ok: false, confirmationRequired: true, summary: sensitiveSummary(el) };
      }
      el.focus?.();
      const view = el.ownerDocument?.defaultView || window;
      const KeyboardEventCtor = view.KeyboardEvent || KeyboardEvent;
      el.dispatchEvent(new KeyboardEventCtor('keydown', { key, bubbles: true, cancelable: true }));
      const InputCtor = view.HTMLInputElement || HTMLInputElement;
      if (key === 'Enter' && el instanceof InputCtor && el.form) {
        if (!command.confirmed && String(command.effect || 'normal') !== 'normal') {
          return { ok: false, confirmationRequired: true, summary: '按 Enter 将提交表单，需要用户确认。' };
        }
        if (command.confirmed) el.form.requestSubmit?.();
      }
      el.dispatchEvent(new KeyboardEventCtor('keyup', { key, bubbles: true, cancelable: true }));
      return { ok: true, action, key, ref: command.ref || null, verified: isActuallyFocused(el) };
    }

    const el = requireRef(command.ref);
    if (action === 'terminal_input') {
      if (!isXtermElement(el)) throw new Error('目标元素不是 xterm 终端');
      const pressEnter = !!command.press_enter;
      if (pressEnter && !command.confirmed) {
        return {
          ok: false,
          confirmationRequired: true,
          summary: '将在网页 Terminal/xterm 中输入内容并按 Enter 执行，需要用户确认。'
        };
      }
      const typed = xtermInputText(el, command.value);
      if (pressEnter) xtermSendKey(el, 'Enter');
      setHighlight(xtermRoot(el) || el);
      await new Promise((resolve) => setTimeout(resolve, pressEnter ? 320 : 80));
      return {
        ok: true,
        action,
        ref: command.ref,
        adapter: 'xterm',
        valueLength: typed.length,
        executed: pressEnter,
        output: xtermOutput(el, Math.max(500, Math.min(Number(command.max_chars || 6000), 16000)))
      };
    }
    if (action === 'highlight') {
      setHighlight(el);
      return { ok: true, action, ref: command.ref };
    }
    if (action === 'fill') {
      if (isXtermElement(el)) {
        const pressEnter = !!command.press_enter;
        if (pressEnter && !command.confirmed) {
          return {
            ok: false,
            confirmationRequired: true,
            summary: '将在网页 Terminal/xterm 中输入内容并按 Enter 执行，需要用户确认。'
          };
        }
        const typed = xtermInputText(el, command.value);
        if (pressEnter) xtermSendKey(el, '\r');
        setHighlight(xtermRoot(el) || el);
        return { ok: true, action, ref: command.ref, adapter: 'xterm', valueLength: typed.length, executed: pressEnter };
      }
      if (isNativeSelect(el)) {
        const selected = await selectElement(el, { value: command.value, blur: !!command.blur });
        if (el.isConnected) setHighlight(el);
        return { ...selected, action, ref: command.ref, compatibility_operation: 'fill' };
      }
      const filled = await fillAndVerify(el, command.value);
      setHighlight(el);
      return { ...filled, action, ref: command.ref, valueLength: filled.value_length };
    }
    if (action === 'select') {
      const selected = await selectElement(el, { value: command.value, label: command.label, blur: !!command.blur });
      if (el.isConnected) setHighlight(el);
      return { ...selected, action, ref: command.ref };
    }
    if (action === 'click') {
      if (isSensitiveClick(el) && !command.confirmed) {
        return { ok: false, confirmationRequired: true, summary: sensitiveSummary(el) };
      }
      const tag = String(el.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select', 'button'].includes(tag) || el.isContentEditable || el.hasAttribute?.('tabindex')) {
        el.focus?.({ preventScroll: true });
      }
      setHighlight(el);
      el.click();
      return { ok: true, action, ref: command.ref, sensitive: isSensitiveClick(el), verified: true, focused: isActuallyFocused(el) };
    }
    throw new Error(`不支持的操作：${action}`);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (message?.type === 'PENGUIN_SESSION_STATE') {
        authorized = !!message.authorized;
        mode = message.mode || 'view';
        scope = message.scope === 'browser' || message.session?.scope === 'browser' ? 'browser' : 'tab';
        refs.clear();
        updateOverlay();
        return { ok: true };
      }
      if (message?.type === 'PENGUIN_HWCR_FRONTEND_DATA') {
        const host = String(location.hostname || '').toLowerCase();
        if (!(host === 'm.hwcr.vip' || host.endsWith('.hwcr.vip'))) {
          hwcrFrontendRecords = [];
          hwcrFrontendDiagnostics = { status: 'not_ready', error: null };
          return { ok: true, recordCount: 0, diagnostics: hwcrFrontendDiagnostics };
        }
        hwcrFrontendRecords = Array.isArray(message.records)
          ? message.records.filter((item) => item && typeof item === 'object').slice(0, 200).map((item) => ({ ...item }))
          : [];
        hwcrFrontendDiagnostics = (message.diagnostics && typeof message.diagnostics === 'object')
          ? { ...message.diagnostics }
          : { status: hwcrFrontendRecords.length ? 'ready' : 'no_data', error: null };
        return { ok: true, recordCount: hwcrFrontendRecords.length, diagnostics: hwcrFrontendDiagnostics };
      }
      if (message?.type === 'PENGUIN_COMMAND') return await execute(message.command || {});
      throw new Error('未知 content 消息');
    })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  });
})();
