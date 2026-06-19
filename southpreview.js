// ==UserScript==
// @name         South Plus Media Preview
// @namespace    https://bbs.level-plus.net/
// @version      1.0.9
// @description  在南+列表页标题下方预览楼主图片和第三方媒体，支持标题 iframe 弹窗、Gofile 图片/视频封面与弹窗播放。
// @author       起飞的蛋糕
// @license      MIT
// @match        *://*.east-plus.net/*
// @match        *://east-plus.net/*
// @match        *://*.south-plus.net/*
// @match        *://south-plus.net/*
// @match        *://*.south-plus.org/*
// @match        *://south-plus.org/*
// @match        *://*.white-plus.net/*
// @match        *://white-plus.net/*
// @match        *://*.north-plus.net/*
// @match        *://north-plus.net/*
// @match        *://*.level-plus.net/*
// @match        *://level-plus.net/*
// @match        *://*.soul-plus.net/*
// @match        *://soul-plus.net/*
// @match        *://*.snow-plus.net/*
// @match        *://snow-plus.net/*
// @match        *://*.spring-plus.net/*
// @match        *://spring-plus.net/*
// @match        *://*.summer-plus.net/*
// @match        *://summer-plus.net/*
// @match        *://*.blue-plus.net/*
// @match        *://blue-plus.net/*
// @match        *://*.imoutolove.me/*
// @match        *://imoutolove.me/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      gofile.io
// @connect      api.gofile.io
// @connect      *.gofile.io
// @connect      ibb.co
// @connect      imgbox.com
// @connect      imagebam.com
// @connect      imagevenue.com
// @connect      postimg.cc
// @connect      pixhost.to
// @connect      imgur.com
// @connect      lensdump.com
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    maxThreads: 0,
    maxExcerptLength: 240,
    maxImagesPerThread: 24,
    maxHostPageResolves: 6,
    autoBuyFreeContent: true,
    maxFreeBuyActions: 2,
    concurrency: 5,
    requestTimeoutMs: 15000,
    requestDelayMs: 120,
    cacheTtlMs: 12 * 60 * 60 * 1000,
    scanDebounceMs: 300,
    debug: false,
    titlePreviewMode: "popup",
    titlePreviewModeKey: "spv:title-preview-mode",
    legacyTitleIframeSettingKey: "spv:title-iframe-enabled",
    titleDrawerDefaultWidthPx: 920,
    titleDrawerMinWidthPx: 520,
    titleDrawerMaxRatio: 0.82,
    titleDrawerWidthKey: "spv:title-drawer-width",
    excerptEnabled: true,
    excerptEnabledKey: "spv:excerpt-enabled",
    slotClass: "spv-slot",
    excerptClass: "spv-excerpt",
    stripClass: "spv-strip",
    badgeClass: "spv-badge",
  };

  const IMAGE_HOST_RE = /(catbox\.moe|gofile\.io|imgbox\.com|imgur\.com|i\.imgur\.com|postimg|postimages|pixhost|ibb\.co|imgbb|imagebam|imagevenue|freeimage|imgpile|lensdump|iili\.io|jpg\d?\.|pixeldrain|telegra\.ph|discord(?:app)?\.com\/attachments|pbs\.twimg\.com|sinaimg|weibo|imoutolove|blue-plus|level-plus)/i;
  const HOST_PAGE_RE = /(gofile\.io\/d\/|ibb\.co|imgbox\.com|imagebam\.com|imagevenue\.com|postimg\.cc|pixhost\.to|imgur\.com\/(?!a\/)|lensdump\.com\/i\/)/i;
  const IMAGE_EXT_RE = /\.(?:jpg|jpeg|png|webp|gif|bmp)(?:[?#].*)?$/i;
  const VIDEO_EXT_RE = /\.(?:mp4|webm|mov|m4v)(?:[?#].*)?$/i;
  const ATTACHMENT_RE = /\/(?:attachment|upload)\//i;
  const EMOJI_RE = /\/(?:smile|smallface|kaoani|post\/smile|faces?|emot|emotion)\//i;
  const EMOJI_FILE_RE = /\/(?:face\d+|fly_\d+)\.(?:gif|jpg|jpeg|png|webp)$/i;
  const AVATAR_RE = /\/(?:avatar|face)\//i;
  const BUY_RE = /(?:buytopic|此帖售价|愿意购买|我买|我付钱|免费购买|隐藏内容|出售内容)/i;
  const FREE_BUY_RE = /(?:免费购买|售价[^\d]{0,12}0\s*(?:SP|sp|币)?|0\s*(?:SP|sp)币?|free)/i;
  const PAID_BUY_RE = /(?:售价[^\d]{0,12}[1-9]\d*\s*(?:SP|sp|币)?|[1-9]\d*\s*(?:SP|sp)币?)/i;

  const state = {
    seenTids: new Set(),
    seenNodes: new WeakSet(),
    queue: [],
    active: 0,
    found: 0,
    done: 0,
    scanTimer: 0,
    wheelStrip: null,
    wheelDelta: 0,
    wheelFrame: 0,
    titleIframeBound: new WeakSet(),
    savedBodyPaddingRight: "",
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const debugLog = (...args) => {
    if (CONFIG.debug) console.log("[SouthPreview]", ...args);
  };
  const debugWarn = (...args) => {
    if (CONFIG.debug) console.warn("[SouthPreview]", ...args);
  };

  init();

  function init() {
    if (!isThreadListPage()) {
      cleanup();
      return;
    }

    injectStyle();
    cleanup();
    renderTitleIframeToggle();
    bindWheelScroll();
    scanAndEnqueue();
    observeChanges();
  }

  function isThreadListPage() {
    const url = new URL(location.href);
    if (/(?:^|\/)thread\.php$/i.test(url.pathname)) return true;
    return isSimpleIndexUrl(url) && !isSimpleThreadUrl(url);
  }

  function bindWheelScroll() {
    document.addEventListener("wheel", handleWheel, { passive: false });
  }

  function handleWheel(event) {
    const strip = event.target.closest && event.target.closest(`.${CONFIG.stripClass}`);
    if (!strip || strip.scrollWidth <= strip.clientWidth) return;

    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;

    state.wheelStrip = strip;
    state.wheelDelta += delta;
    if (!state.wheelFrame) {
      state.wheelFrame = requestAnimationFrame(flushWheel);
    }

    event.preventDefault();
    event.stopPropagation();
  }

  function flushWheel() {
    const strip = state.wheelStrip;
    const delta = state.wheelDelta;
    state.wheelStrip = null;
    state.wheelDelta = 0;
    state.wheelFrame = 0;

    if (!strip || !delta) return;
    strip.scrollLeft += delta;
    updateStripFade(strip);
  }

  function updateStripFade(strip) {
    if (!strip) return;
    const maxLeft = Math.max(0, strip.scrollWidth - strip.clientWidth - 1);
    strip.classList.toggle("spv-can-scroll-right", strip.scrollLeft < maxLeft);
  }

  function cleanup() {
    document
      .querySelectorAll(`.${CONFIG.slotClass}, .spv-panel, .spv-lightbox, .spv-drawer, .spv-title-toggle, .lp-preview-slot, .lp-preview-panel, .lp-preview-lightbox`)
      .forEach((node) => node.remove());
    document.documentElement.classList.remove("spv-drawer-open", "spv-drawer-resizing");
    document.documentElement.style.removeProperty("--spv-drawer-width");
    document.body.style.paddingRight = state.savedBodyPaddingRight || "";
    document
      .querySelectorAll(".lp-preview-strip, .lp-preview-badge, .lp-preview-status")
      .forEach((node) => node.remove());
  }

  function observeChanges() {
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", scheduleScan);
    window.addEventListener("hashchange", scheduleScan);
    setInterval(scheduleScan, 3000);
  }

  function scheduleScan() {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(scanAndEnqueue, CONFIG.scanDebounceMs);
  }

  function scanAndEnqueue() {
    for (const item of collectThreadItems()) enqueueItem(item);
    pumpQueue();
  }

  function collectThreadItems() {
    const items = [];

    for (const link of collectTitleLinks()) {
      if (state.seenNodes.has(link)) continue;

      const tid = getTid(link.href || link.getAttribute("href"));
      if (!tid) continue;
      if (CONFIG.maxThreads > 0 && state.found >= CONFIG.maxThreads) continue;

      const text = (link.textContent || "").trim();
      const row = findThreadContainer(link);
      const cell = findTitleCell(link);
      if (!text || !row || !cell) continue;

      state.seenNodes.add(link);

      const item = {
        tid,
        url: detailUrlForLink(link, tid),
        link,
        row,
        cell,
        slot: ensureSlot(link, cell, tid),
      };

      bindTitleIframeOpen(link, item.url, text);

      if (state.seenTids.has(tid)) {
        const cached = readCache(tid);
        if (cached) renderResult(item, cached);
        continue;
      }

      state.seenTids.add(tid);
      items.push(item);
    }

    return items;
  }

  function collectTitleLinks() {
    const links = [];
    for (const row of document.querySelectorAll("tr")) {
      const rowLinks = Array.from(row.querySelectorAll('a[href*="read.php?tid-"]')).filter(isListThreadLink);
      const titleLink = chooseTitleLink(row, rowLinks);
      if (titleLink) links.push(titleLink);
    }
    for (const item of document.querySelectorAll('li[class*="author_"]')) {
      const itemLinks = Array.from(item.querySelectorAll("a[href]")).filter(isListThreadLink);
      const titleLink = chooseTitleLink(item, itemLinks);
      if (titleLink) links.push(titleLink);
    }
    return links;
  }

  function isListThreadLink(link) {
    const href = link.getAttribute("href") || "";
    if (!href) return false;
    if (/authorid-|uid-|pid-|#\d+|#pid/i.test(href)) return false;
    if (link.closest(".readtext, .tpc_content, .c, .quote, .blockquote, .tiptop, .floot, .user-info")) return false;

    try {
      const url = new URL(href, location.href);
      if (isSimpleIndexUrl(url)) return isSimpleThreadUrl(url);
      if (!/\/read\.php$/i.test(url.pathname)) return false;
      const params = url.search || "";
      return /^\?tid-\d+(?:-fpage-\d+)?(?:\.html)?$/i.test(params);
    } catch (error) {
      return /^(?:simple\/)?index\.php\?t\d+(?:\.html)?$/i.test(href) || /^\?t\d+(?:\.html)?$/i.test(href) || /^read\.php\?tid-\d+(?:-fpage-\d+)?(?:\.html)?$/i.test(href);
    }
  }

  function chooseTitleLink(row, links) {
    let best = null;
    let bestScore = -Infinity;

    for (const link of links) {
      const score = scoreTitleLink(row, link);
      if (score > bestScore) {
        best = link;
        bestScore = score;
      }
    }

    return bestScore > 0 ? best : null;
  }

  function bindTitleIframeOpen(link, url, title) {
    if (state.titleIframeBound.has(link)) return;

    state.titleIframeBound.add(link);
    link.addEventListener("click", (event) => {
      const mode = getTitlePreviewMode();
      if (mode === "off") return;
      if (event.defaultPrevented) return;
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const targetUrl = url || detailUrlForLink(link, getTid(link.href || link.getAttribute("href")));
      if (!targetUrl) return;

      event.preventDefault();
      event.stopPropagation();
      openTitlePreview(targetUrl, title || (link.textContent || "").trim(), mode);
    });
  }

  function getTitlePreviewMode() {
    try {
      const saved = localStorage.getItem(CONFIG.titlePreviewModeKey);
      if (saved === "off" || saved === "popup" || saved === "drawer") return saved;

      const legacy = localStorage.getItem(CONFIG.legacyTitleIframeSettingKey);
      if (legacy === "0") return "off";
      if (legacy === "1") return "popup";
    } catch (error) {
      debugWarn("title preview mode read failed", error);
    }

    return CONFIG.titlePreviewMode;
  }

  function setTitlePreviewMode(mode) {
    try {
      localStorage.setItem(CONFIG.titlePreviewModeKey, mode);
    } catch (error) {
      debugWarn("title preview mode write failed", error);
    }
  }

  function isExcerptEnabled() {
    try {
      const saved = localStorage.getItem(CONFIG.excerptEnabledKey);
      if (saved === "0") return false;
      if (saved === "1") return true;
    } catch (error) {
      debugWarn("excerpt setting read failed", error);
    }

    return CONFIG.excerptEnabled;
  }

  function setExcerptEnabled(enabled) {
    try {
      localStorage.setItem(CONFIG.excerptEnabledKey, enabled ? "1" : "0");
    } catch (error) {
      debugWarn("excerpt setting write failed", error);
    }
  }

  function renderTitleIframeToggle() {
    document.querySelectorAll(".spv-title-toggle").forEach((node) => node.remove());

    const wrapper = document.createElement("label");
    wrapper.className = "spv-title-toggle";
    wrapper.title = "标题点击预览方式";

    const text = document.createElement("span");
    text.textContent = "预览";

    const select = document.createElement("select");
    const options = [
      ["popup", "弹窗"],
      ["drawer", "侧栏"],
      ["off", "关闭"],
    ];

    for (const [value, label] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }

    select.value = getTitlePreviewMode();
    select.addEventListener("change", () => {
      setTitlePreviewMode(select.value);
      wrapper.classList.toggle("spv-title-toggle-off", select.value === "off");
      if (select.value !== "drawer") closeDrawer();
    });

    wrapper.classList.toggle("spv-title-toggle-off", select.value === "off");
    wrapper.appendChild(text);
    wrapper.appendChild(select);

    const excerptLabel = document.createElement("label");
    excerptLabel.className = "spv-title-toggle-check";
    excerptLabel.title = "标题下方显示一楼文字摘要";

    const excerptInput = document.createElement("input");
    excerptInput.type = "checkbox";
    excerptInput.checked = isExcerptEnabled();

    const excerptText = document.createElement("span");
    excerptText.textContent = "文字";

    excerptInput.addEventListener("change", () => {
      setExcerptEnabled(excerptInput.checked);
      document.documentElement.classList.toggle("spv-hide-excerpt", !excerptInput.checked);
    });

    excerptLabel.appendChild(excerptInput);
    excerptLabel.appendChild(excerptText);
    wrapper.appendChild(excerptLabel);
    document.documentElement.classList.toggle("spv-hide-excerpt", !excerptInput.checked);
    document.body.appendChild(wrapper);
  }

  function getDrawerWidthPx() {
    const maxWidth = getDrawerMaxWidthPx();
    let width = Math.min(CONFIG.titleDrawerDefaultWidthPx, maxWidth);

    try {
      const saved = parseInt(localStorage.getItem(CONFIG.titleDrawerWidthKey) || "", 10);
      if (Number.isFinite(saved) && saved > 0) width = saved;
    } catch (error) {
      debugWarn("title drawer width read failed", error);
    }

    return clampDrawerWidth(width);
  }

  function setDrawerWidthPx(width) {
    const next = clampDrawerWidth(width);
    document.documentElement.style.setProperty("--spv-drawer-width", `${next}px`);
    document.body.style.paddingRight = `${next}px`;
    return next;
  }

  function saveDrawerWidthPx(width) {
    try {
      localStorage.setItem(CONFIG.titleDrawerWidthKey, String(clampDrawerWidth(width)));
    } catch (error) {
      debugWarn("title drawer width write failed", error);
    }
  }

  function clampDrawerWidth(width) {
    const maxWidth = getDrawerMaxWidthPx();
    const minWidth = Math.min(CONFIG.titleDrawerMinWidthPx, maxWidth);
    return Math.max(minWidth, Math.min(maxWidth, Math.round(width || CONFIG.titleDrawerDefaultWidthPx)));
  }

  function getDrawerMaxWidthPx() {
    return Math.max(CONFIG.titleDrawerMinWidthPx, Math.floor(window.innerWidth * CONFIG.titleDrawerMaxRatio));
  }

  function scoreTitleLink(row, link) {
    const text = (link.textContent || "").trim();
    const href = link.getAttribute("href") || "";
    const cell = link.closest("td, li");
    if (!text || text.length < 2) return -1000;
    if (state.seenNodes.has(link)) return -1000;
    if (!isListThreadLink(link)) return -1000;
    if (/[?&]page=|#\d+$|pid-/i.test(href)) return -50;

    const cells = Array.from(row.children).filter((node) => node.tagName === "TD" || node.tagName === "TH");
    const cellIndex = cells.indexOf(cell);
    let score = Math.min(text.length, 80);
    if (cell && cell.querySelector("h3")) score += 60;
    if (link.closest("h3")) score += 80;
    if (cell && /subject|title|tal|f14|thread/i.test(cell.className || "")) score += 30;
    if (row.tagName === "LI" && /(?:^|\s)author_\d+(?:\s|$)/i.test(row.className || "")) score += 80;
    if (cellIndex >= 0 && cellIndex <= 2) score += 40;
    if (cellIndex >= 3) score -= 70;
    return score;
  }

  function findThreadContainer(link) {
    return link.closest("tr") || link.closest('li[class*="author_"]');
  }

  function findTitleCell(link) {
    return link.closest("td") || link.closest('li[class*="author_"]') || link.parentElement;
  }

  function ensureSlot(link, cell, tid) {
    let slot = cell.querySelector(`.${CONFIG.slotClass}[data-spv-tid="${tid}"]`);
    if (slot) {
      normalizeSimpleItemLayout(cell, link, slot);
      return slot;
    }

    slot = document.createElement("div");
    slot.className = CONFIG.slotClass;
    slot.dataset.spvTid = tid;

    const titleBlock = findTitleBlock(link, cell);
    titleBlock.insertAdjacentElement("afterend", slot);
    normalizeSimpleItemLayout(cell, link, slot);
    return slot;
  }

  function findTitleBlock(link, cell) {
    let node = link;
    while (node.parentElement && node.parentElement !== cell) node = node.parentElement;
    return node || link;
  }

  function normalizeSimpleItemLayout(cell, titleLink, slot) {
    if (!isSimpleListItem(cell) || !titleLink || !slot) return;

    titleLink.classList.add("spv-mobile-title");

    let meta = cell.querySelector(".spv-mobile-meta");
    if (!meta) {
      meta = document.createElement("div");
      meta.className = "spv-mobile-meta";
    }

    for (const node of Array.from(titleLink.querySelectorAll(".by"))) {
      meta.appendChild(node);
    }

    for (const node of Array.from(cell.childNodes)) {
      if (node === titleLink || node === slot || node === meta) continue;
      if (node.nodeType === Node.ELEMENT_NODE && node.matches(`.${CONFIG.slotClass}, .${CONFIG.stripClass}`)) continue;
      if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) continue;
      meta.appendChild(node);
    }

    slot.insertAdjacentElement("afterend", meta);
    if (!meta.textContent.trim() && !meta.children.length) meta.remove();
  }

  function isSimpleListItem(node) {
    return node && node.tagName === "LI" && /(?:^|\s)author_\d+(?:\s|$)/i.test(node.className || "");
  }

  function getTid(url) {
    const match = String(url || "").match(/read\.php\?tid-(\d+)|(?:^|[?&])t(\d+)(?=\D|$)/i);
    if (match) return match[1] || match[2] || "";
    return "";
  }

  function detailUrlForLink(link, tid) {
    const raw = link.getAttribute("href") || "";
    const absolute = new URL(raw, location.href);
    if (isSimpleIndexUrl(absolute) && tid) {
      return new URL(`read.php?tid-${tid}.html`, location.origin + "/").href;
    }
    return absolute.href;
  }

  function isSimpleIndexUrl(url) {
    return /(?:^|\/)simple\/(?:index\.php)?$/i.test(url.pathname);
  }

  function isSimpleThreadUrl(url) {
    return /^\?t\d+(?:(?:-|(?:-?page-))\d+)?(?:\.html)?$/i.test(url.search || "");
  }

  function enqueueItem(item) {
    state.found += 1;
    state.queue.push(item);
  }

  function pumpQueue() {
    while (state.active < CONFIG.concurrency && state.queue.length) {
      const item = state.queue.shift();
      state.active += 1;
      processItem(item);
    }
  }

  async function processItem(item) {
    try {
      await sleep(CONFIG.requestDelayMs);
      await hydrateThread(item);
    } finally {
      state.active -= 1;
      state.done += 1;
      pumpQueue();
    }
  }

  async function hydrateThread(item) {
    const cached = readCache(item.tid);
    if (cached) {
      renderResult(item, cached);
      return;
    }

    try {
      const response = await fetchWithTimeout(item.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      let doc = new DOMParser().parseFromString(html, "text/html");
      doc = await expandFreeBuyContent(doc, item.url);
      const result = await parseThreadDetail(doc, item.url, item.tid);
      writeCache(item.tid, result);
      renderResult(item, result);
    } catch (error) {
      debugWarn("Thread read failed", item.url, error);
    }
  }

  async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
    try {
      return await fetch(url, {
        credentials: "include",
        cache: (options.method || "GET").toUpperCase() === "GET" ? "force-cache" : "no-store",
        ...options,
        signal: controller.signal,
      });
    } catch (error) {
      if (error && error.name === "AbortError") throw new Error("请求超时");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function expandFreeBuyContent(doc, pageUrl) {
    if (!CONFIG.autoBuyFreeContent) return doc;

    const actions = findFreeBuyActions(doc, pageUrl).slice(0, CONFIG.maxFreeBuyActions);
    if (!actions.length) return doc;

    let changed = false;
    for (const actionUrl of actions) {
      try {
        await sleep(CONFIG.requestDelayMs);
        const response = await fetchWithTimeout(actionUrl);
        if (response.ok) changed = true;
      } catch (error) {
        debugWarn("Free buy failed", actionUrl, error);
      }
    }

    if (!changed) return doc;

    try {
      await sleep(CONFIG.requestDelayMs);
      const response = await fetchWithTimeout(pageUrl);
      if (!response.ok) return doc;
      const html = await response.text();
      return new DOMParser().parseFromString(html, "text/html");
    } catch (error) {
      return doc;
    }
  }

  function findFreeBuyActions(doc, pageUrl) {
    const actions = [];

    for (const node of doc.querySelectorAll("input, button, a")) {
      const text = [
        node.getAttribute("value"),
        node.getAttribute("title"),
        node.getAttribute("onclick"),
        node.getAttribute("href"),
        node.textContent,
        node.parentElement ? node.parentElement.textContent : "",
      ].join(" ");

      if (!/buytopic/i.test(text)) continue;
      if (PAID_BUY_RE.test(text) && !FREE_BUY_RE.test(text)) continue;
      if (!FREE_BUY_RE.test(text) && !/免费|0\s*(?:SP|sp|币)?/i.test(text)) continue;

      const href = extractBuyActionUrl(node, text, pageUrl);
      if (href) actions.push(href);
    }

    return actions.filter(unique());
  }

  function extractBuyActionUrl(node, text, pageUrl) {
    const direct = node.getAttribute("href");
    if (direct && /buytopic/i.test(direct)) return new URL(direct, pageUrl).href;

    const onclick = node.getAttribute("onclick") || text || "";
    const quoted = onclick.match(/(?:location\.href|window\.location)\s*=\s*['"]([^'"]*buytopic[^'"]*)['"]/i);
    if (quoted) return new URL(quoted[1], pageUrl).href;

    const loose = onclick.match(/((?:job|read)\.php\?[^'"\s<>]*buytopic[^'"\s<>]*)/i);
    if (loose) return new URL(loose[1], pageUrl).href;

    return "";
  }

  async function parseThreadDetail(doc, threadUrl, tid) {
    const urls = new Set();
    const author = detectAuthor(doc);
    const docs = [{ doc, url: threadUrl }];
    let excerpt = "";

    let scanned = 0;
    for (const page of docs) {
      for (const post of collectAuthorPosts(page.doc, author)) {
        scanned += 1;
        if (!excerpt) excerpt = extractPostExcerpt(post.content);
        collectMediaUrls(urls, post.content, page.url);
        if (urls.size >= CONFIG.maxImagesPerThread) break;
      }
      if (urls.size >= CONFIG.maxImagesPerThread) break;
    }

    if (!scanned) {
      const firstPost = doc.querySelector("#read_tpc") || doc.querySelector(".tpc_content");
      if (firstPost) {
        excerpt = extractPostExcerpt(firstPost);
        collectMediaUrls(urls, firstPost, threadUrl);
      }
    }

    const normalized = normalizeUrlList(urls);
    const images = normalized.filter((url) => !isHostPageUrl(url)).slice(0, CONFIG.maxImagesPerThread);
    const hostPages = normalized.filter((url) => isHostPageUrl(url)).slice(0, CONFIG.maxHostPageResolves);

    return {
      images,
      hostPages,
      media: [],
      excerpt,
      note: "",
    };
  }

  function extractPostExcerpt(content) {
    if (!content) return "";

    const clone = content.cloneNode(true);
    clone
      .querySelectorAll("script, style, noscript, iframe, img, video, audio, object, embed, input, button, select, textarea, .quote, .blockquote, blockquote, .readbot, .signature, .sigline")
      .forEach((node) => node.remove());

    let text = htmlDecode(clone.textContent || "")
      .replace(/\b(?:https?:)?\/\/\S+/gi, " ")
      .replace(/\[(?:img|url|quote|size|color|b|i|u|align)[^\]]*\]/gi, " ")
      .replace(/\[\/(?:img|url|quote|size|color|b|i|u|align)\]/gi, " ")
      .replace(/(?:复制代码|本帖最近评分记录|附件|图片|下载次数|售价|隐藏内容)/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (text.length > CONFIG.maxExcerptLength) text = `${text.slice(0, CONFIG.maxExcerptLength).trim()}...`;
    return text;
  }

  function collectMediaUrls(urls, root, baseUrl) {
    if (!root) return;

    for (const img of root.querySelectorAll("img")) {
      addUrl(urls, getImageAttr(img), baseUrl);
      addUrlsFromText(urls, img.getAttribute("onclick") || "", baseUrl);
      addUrlsFromText(urls, img.outerHTML || "", baseUrl);
    }

    for (const node of root.querySelectorAll("[style]")) {
      addUrlsFromText(urls, node.getAttribute("style") || "", baseUrl);
    }

    for (const anchor of root.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href") || "";
      if (!href || /^javascript:/i.test(href)) continue;
      const absolute = toAbsoluteUrl(href, baseUrl);
      if (absolute && isMediaCandidate(absolute)) urls.add(absolute);
      addUrlsFromText(urls, anchor.textContent || "", baseUrl);
      addUrlsFromText(urls, anchor.getAttribute("title") || "", baseUrl);
    }

    addUrlsFromText(urls, root.textContent || "", baseUrl);
  }

  function getImageAttr(img) {
    return (
      img.getAttribute("src") ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-url") ||
      img.getAttribute("data-file") ||
      img.getAttribute("ess-data") ||
      img.getAttribute("zoomfile") ||
      img.getAttribute("file") ||
      ""
    );
  }

  function addUrl(set, raw, baseUrl) {
    const absolute = toAbsoluteUrl(raw, baseUrl);
    if (absolute) set.add(absolute);
  }

  function addUrlsFromText(set, text, baseUrl) {
    const source = String(text || "");
    const urlRe = /(?:https?:)?\/\/[^\s<>"'()]+|(?:attachment|upload)\/[^\s<>"'()]+/gi;
    let match;

    while ((match = urlRe.exec(source))) {
      const raw = htmlDecode(match[0]).replace(/[),，。.\]]+$/g, "");
      const absolute = toAbsoluteUrl(raw, baseUrl);
      if (absolute && isMediaCandidate(absolute)) set.add(absolute);
    }
  }

  function normalizeUrlList(urls) {
    return [...urls]
      .map(normalizeUrl)
      .filter(Boolean)
      .filter((url) => isMediaCandidate(url))
      .filter((url) => !isBlockedMedia(url))
      .filter(unique())
      .slice(0, CONFIG.maxImagesPerThread);
  }

  function toAbsoluteUrl(raw, baseUrl) {
    if (!raw) return "";
    try {
      const cleaned = htmlDecode(String(raw)).trim();
      if (!cleaned || /^data:/i.test(cleaned)) return "";
      if (/^\/\//.test(cleaned)) return `${location.protocol}${cleaned}`;
      return new URL(cleaned, baseUrl).href;
    } catch (error) {
      return "";
    }
  }

  function normalizeUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      parsed.hash = "";
      return parsed.href;
    } catch (error) {
      return "";
    }
  }

  function htmlDecode(value) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = String(value || "");
    return textarea.value;
  }

  function isMediaCandidate(url) {
    return IMAGE_EXT_RE.test(url) || ATTACHMENT_RE.test(url) || IMAGE_HOST_RE.test(url);
  }

  function isHostPageUrl(url) {
    return HOST_PAGE_RE.test(url) && !IMAGE_EXT_RE.test(url);
  }

  function isBlockedMedia(url) {
    return EMOJI_RE.test(url) || EMOJI_FILE_RE.test(url) || AVATAR_RE.test(url);
  }

  function detectAuthor(doc) {
    const firstContent = doc.querySelector("#read_tpc") || doc.querySelector(".tpc_content");
    if (!firstContent) return null;
    const post = findPostContainer(firstContent);
    return post ? extractAuthor(post) : null;
  }

  function collectAuthorPosts(doc, author) {
    const contents = Array.from(doc.querySelectorAll("#read_tpc, .tpc_content"));
    const posts = [];
    const seen = new Set();

    for (const content of contents) {
      if (!author && content.id !== "read_tpc") continue;
      const post = findPostContainer(content);
      if (!post || seen.has(post)) continue;
      seen.add(post);
      if (!author || sameAuthor(extractAuthor(post), author)) posts.push({ post, content });
    }

    return posts;
  }

  function findPostContainer(content) {
    const doc = content.ownerDocument || document;
    let node = content;
    while (node && node !== doc.body) {
      if (node.tagName === "TR") return node;
      node = node.parentElement;
    }
    return content.closest("tr") || content.parentElement;
  }

  function extractAuthor(post) {
    const profile = post.querySelector("a[href^='u.php'], a[href*='/u.php']");
    const href = profile ? profile.getAttribute("href") || "" : "";
    const uidMatch = href.match(/uid[-=](\d+)/i) || href.match(/\/u\.php\?(\d+)/i);
    const uid = uidMatch ? uidMatch[1] : "";
    const name = profile ? (profile.textContent || "").trim() : "";
    return uid || name ? { uid, name } : null;
  }

  function sameAuthor(a, b) {
    if (!a || !b) return false;
    if (a.uid && b.uid) return a.uid === b.uid;
    if (a.name && b.name) return a.name === b.name;
    return false;
  }

  async function resolveHostPageMediaList(url) {
    try {
      await sleep(CONFIG.requestDelayMs);

      if (/gofile\.io\/d\//i.test(url)) {
        const media = await resolveGofileMediaList(url);
        if (media.length) return media;
      }

      const html = await requestText(url);
      const doc = new DOMParser().parseFromString(html, "text/html");
      const direct =
        getMeta(doc, "meta[property='og:image']") ||
        getMeta(doc, "meta[name='og:image']") ||
        getMeta(doc, "meta[name='twitter:image']") ||
        getMeta(doc, "meta[property='twitter:image']") ||
        findFirstImageInText(html, url);

      const absolute = toAbsoluteUrl(direct, url);
      return absolute && isMediaCandidate(absolute) && !isBlockedMedia(absolute)
        ? [{ type: "image", url: absolute, source: url }]
        : [];
    } catch (error) {
      debugWarn("Host resolve failed", url, error);
      return [];
    }
  }

  async function resolveGofileMediaList(url) {
    const idMatch = String(url).match(/gofile\.io\/d\/([a-z0-9-]+)/i);
    if (!idMatch) return [];

    const contentId = idMatch[1];
    try {
      const token = await getGofileGuestToken();
      const wt = await generateGofileWT(token);
      const params = new URLSearchParams({
        contentFilter: "",
        page: "1",
        pageSize: "1000",
        sortField: "createTime",
        sortDirection: "-1",
      });

      const text = await requestTextWithHeaders(`https://api.gofile.io/contents/${contentId}?${params}`, {
        Authorization: `Bearer ${token}`,
        "X-Website-Token": wt,
        "X-BL": navigator.language || "",
      });

      const data = JSON.parse(text);
      const root = data && data.data ? data.data : null;
      const files = flattenGofileChildren(root && root.children ? root.children : root);
      const media = files.map(gofileFileToMedia).filter(Boolean).slice(0, CONFIG.maxImagesPerThread);
      debugLog("Gofile media", contentId, media);
      return media;
    } catch (error) {
      debugWarn("Gofile resolve failed", contentId, error);
      return [];
    }
  }

  function flattenGofileChildren(children) {
    if (!children) return [];
    const values = Array.isArray(children) ? children : Object.values(children);
    const files = [];

    for (const child of values) {
      if (!child) continue;
      if (child.children) files.push(...flattenGofileChildren(child.children));
      else files.push(child);
    }

    return files;
  }

  function gofileFileToMedia(file) {
    if (!file) return null;

    const mime = file.mimetype || file.mimeType || file.contentType || "";
    const name = file.name || "";
    const fileUrl = file.directLink || file.link || file.downloadPage || buildGofileDownloadUrl(file);
    const poster = file.thumbnail || file.preview || "";

    if (/video\//i.test(mime) || VIDEO_EXT_RE.test(name) || VIDEO_EXT_RE.test(fileUrl)) {
      if (!fileUrl) return null;
      return {
        type: "video",
        url: poster || fileUrl,
        poster,
        videoUrl: fileUrl,
        source: fileUrl,
        name,
      };
    }

    if (/image\//i.test(mime) || IMAGE_EXT_RE.test(name) || IMAGE_EXT_RE.test(fileUrl) || IMAGE_EXT_RE.test(poster)) {
      return {
        type: "image",
        url: poster || fileUrl,
        source: fileUrl || poster,
        name,
      };
    }

    return null;
  }

  function buildGofileDownloadUrl(file) {
    const id = file.id || file.code;
    const name = file.name || "";
    if (!id || !name) return "";

    return `https://gofile.io/download/web/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
  }

  function findFirstImageInText(text, baseUrl) {
    const urlRe = /(?:https?:)?\/\/[^\s<>"'()]+|(?:\/|\.\/)?(?:attachment|upload)\/[^\s<>"'()]+/gi;
    let match;

    while ((match = urlRe.exec(String(text || "")))) {
      const absolute = toAbsoluteUrl(match[0].replace(/[),，。.\]]+$/g, ""), baseUrl);
      if (absolute && isMediaCandidate(absolute) && !isHostPageUrl(absolute) && !isBlockedMedia(absolute)) {
        return absolute;
      }
    }

    return "";
  }

  async function getGofileGuestToken() {
    const raw = localStorage.getItem("spv:gofile-token");
    try {
      const cached = raw ? JSON.parse(raw) : null;
      if (cached && cached.token && Date.now() - cached.time < 24 * 60 * 60 * 1000) return cached.token;
    } catch (error) {
      debugWarn("Invalid Gofile token cache", error);
    }

    const text = await requestTextWithHeaders("https://api.gofile.io/accounts", {}, "POST");
    const data = JSON.parse(text);
    const token = data && data.data ? data.data.token : "";
    if (!token) throw new Error("Gofile token missing");
    localStorage.setItem("spv:gofile-token", JSON.stringify({ token, time: Date.now() }));
    return token;
  }

  async function generateGofileWT(token) {
    const lang = navigator.language || "";
    const bucket = Math.floor(Date.now() / 1000 / 14400).toString();
    const input = `${navigator.userAgent}::${lang}::${token}::${bucket}::9844d94d963d30`;
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function getGofileVideoBlobUrl(url, onProgress) {
    const token = await getGofileGuestToken();
    const blob = await requestBlobWithHeaders(url, {
      Cookie: `accountToken=${token}`,
      Authorization: `Bearer ${token}`,
      Referer: "https://gofile.io/",
    }, "GET", onProgress);
    return URL.createObjectURL(blob);
  }

  function requestText(url) {
    return requestTextWithHeaders(url);
  }

  function requestTextWithHeaders(url, headers = {}, method = "GET") {
    const absolute = new URL(url, location.href);
    if (absolute.origin === location.origin) {
      return fetchWithTimeout(url, { method, headers }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      });
    }

    if (typeof GM_xmlhttpRequest !== "function") {
      return fetchWithTimeout(url, { method, headers }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      });
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("请求超时")), CONFIG.requestTimeoutMs);
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        timeout: CONFIG.requestTimeoutMs,
        onload(response) {
          clearTimeout(timer);
          if (response.status >= 200 && response.status < 300) resolve(response.responseText || "");
          else reject(new Error(`HTTP ${response.status}`));
        },
        onerror(error) {
          clearTimeout(timer);
          reject(error);
        },
        ontimeout() {
          clearTimeout(timer);
          reject(new Error("请求超时"));
        },
      });
    });
  }

  function requestBlobWithHeaders(url, headers = {}, method = "GET", onProgress = null) {
    if (typeof GM_xmlhttpRequest !== "function") {
      throw new Error("GM_xmlhttpRequest unavailable");
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("请求超时")), CONFIG.requestTimeoutMs * 8);
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        responseType: "blob",
        timeout: CONFIG.requestTimeoutMs * 8,
        onload(response) {
          clearTimeout(timer);
          const headerText = response.responseHeaders || "";
          if (response.status < 200 || response.status >= 300 || !response.response) {
            reject(new Error(`HTTP ${response.status}`));
            return;
          }
          if (/content-type:\s*text\/html/i.test(headerText)) {
            reject(new Error("Gofile returned HTML instead of video"));
            return;
          }
          resolve(response.response);
        },
        onprogress(event) {
          if (typeof onProgress === "function" && event.lengthComputable) {
            onProgress(event.loaded, event.total);
          }
        },
        onerror(error) {
          clearTimeout(timer);
          reject(error);
        },
        ontimeout() {
          clearTimeout(timer);
          reject(new Error("请求超时"));
        },
      });

    });
  }

  function getMeta(doc, selector) {
    const node = doc.querySelector(selector);
    return node ? node.getAttribute("content") || "" : "";
  }

  function renderResult(item, result) {
    removeExisting(item);

    const hasImages = result.images && result.images.length;
    const hasMedia = result.media && result.media.length;
    const hasHostPages = result.hostPages && result.hostPages.length;
    const excerpt = normalizeExcerpt(result.excerpt);

    if (excerpt) renderExcerpt(item, excerpt);

    if (hasHostPages) renderBadge(item, result.hostPages);

    if (hasImages || hasMedia || hasHostPages) {
      const strip = document.createElement("div");
      strip.className = CONFIG.stripClass;
      strip.dataset.spvTid = item.tid;
      strip.addEventListener("scroll", () => updateStripFade(strip), { passive: true });
      if (!hasImages && !hasMedia) strip.classList.add("spv-strip-empty");

      for (const url of result.images || []) appendMedia(strip, { type: "image", url, source: url });
      for (const media of result.media || []) appendMedia(strip, media);

      item.slot.appendChild(strip);
      updateStripFade(strip);

      if (hasHostPages) {
        resolveHostPagesInBackground(strip, result.hostPages);
      }
    }

  }

  function normalizeExcerpt(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function renderExcerpt(item, excerpt) {
    const node = document.createElement("div");
    node.className = CONFIG.excerptClass;
    node.dataset.spvTid = item.tid;
    node.textContent = excerpt;
    item.slot.appendChild(node);
  }

  function renderBadge(item, hostPages) {
    const badge = document.createElement("a");
    badge.className = CONFIG.badgeClass;
    badge.dataset.spvTid = item.tid;
    badge.href = hostPages[0];
    badge.target = "_blank";
    badge.rel = "noreferrer";
    badge.textContent = `第三方媒体 ${hostPages.length}`;
    item.slot.appendChild(badge);
  }

  function appendMedia(strip, media) {
    if (!media || !media.url) return;

    const link = document.createElement("a");
    link.href = media.source || media.videoUrl || media.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.className = media.type === "video" ? "spv-media spv-video" : "spv-media";
    if (media.name) link.title = media.name;
    link.addEventListener("click", (event) => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openLightbox(media);
    });

    if (media.type === "video") {
      if (media.poster) {
        const img = document.createElement("img");
        img.src = media.poster;
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        img.addEventListener("error", () => {
          img.remove();
          appendVideoPlaceholder(link, media);
        });
        link.appendChild(img);
      } else {
        appendVideoPlaceholder(link, media);
      }

      const play = document.createElement("span");
      play.className = "spv-play";
      play.textContent = "▶";
      link.appendChild(play);

      const tag = document.createElement("span");
      tag.className = "spv-kind";
      tag.textContent = "MP4";
      link.appendChild(tag);
    } else {
      const img = document.createElement("img");
      img.src = media.url;
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => {
        link.remove();
        if (!strip.children.length) strip.remove();
        updateStripFade(strip);
      });
      link.appendChild(img);
    }

    strip.appendChild(link);
    strip.classList.remove("spv-strip-empty");
    updateStripFade(strip);
  }

  function appendVideoPlaceholder(link, media) {
    if (link.querySelector(".spv-video-placeholder")) return;

    const placeholder = document.createElement("span");
    placeholder.className = "spv-video-placeholder";
    placeholder.textContent = media.name ? getFileExt(media.name).toUpperCase() || "VIDEO" : "VIDEO";
    link.insertBefore(placeholder, link.firstChild);
  }

  function getFileExt(name) {
    const match = String(name || "").match(/\.([a-z0-9]{2,5})(?:[?#].*)?$/i);
    return match ? match[1] : "";
  }

  async function resolveHostPagesInBackground(strip, hostPages) {
    let added = 0;

    for (const pageUrl of hostPages.slice(0, CONFIG.maxHostPageResolves)) {
      if (!document.contains(strip)) return;
      const mediaList = await resolveHostPageMediaList(pageUrl);

      for (const media of mediaList) {
        if (!media || !media.url) continue;
        if (hasMedia(strip, media.poster || media.url)) continue;
        appendMedia(strip, media);
        added += 1;
        if (strip.children.length >= CONFIG.maxImagesPerThread) break;
      }

      if (strip.children.length >= CONFIG.maxImagesPerThread) break;
    }

    if (!added && !strip.children.length) strip.remove();
    else updateStripFade(strip);
  }

  function hasMedia(strip, url) {
    return Array.from(strip.querySelectorAll("img")).some((img) => img.src === url);
  }

  function openLightbox(media) {
    closeLightbox();
    closeDrawer();

    const overlay = document.createElement("div");
    overlay.className = "spv-lightbox";
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeLightbox();
    });

    const body = document.createElement("div");
    body.className = "spv-lightbox-body";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "spv-close";
    close.textContent = "×";
    close.addEventListener("click", closeLightbox);

    const footer = document.createElement("div");
    footer.className = "spv-lightbox-footer";
    const open = document.createElement("a");
    open.href = media.source || media.videoUrl || media.url;
    open.target = "_blank";
    open.rel = "noreferrer";
    open.textContent = media.type === "video" ? "打开视频" : "打开原图";
    footer.appendChild(open);

    if (media.type === "video") {
      renderLightboxVideo(body, media);
    } else {
      const img = document.createElement("img");
      img.src = media.source || media.url;
      img.referrerPolicy = "no-referrer";
      body.appendChild(img);
    }

    overlay.appendChild(body);
    overlay.appendChild(close);
    overlay.appendChild(footer);
    document.body.appendChild(overlay);
    document.documentElement.classList.add("spv-lightbox-open");
    document.addEventListener("keydown", handleLightboxKey);
  }

  function openTitlePreview(url, title, mode) {
    if (mode === "drawer") {
      openThreadDrawer(url, title);
      return;
    }

    openThreadIframe(url, title);
  }

  function createThreadFrameShell(url, title) {
    const shell = document.createElement("div");
    shell.className = "spv-iframe-shell";

    const header = document.createElement("div");
    header.className = "spv-iframe-header";

    const heading = document.createElement("div");
    heading.className = "spv-iframe-title";
    heading.textContent = title || "帖子详情";

    const open = document.createElement("a");
    open.href = url;
    open.target = "_blank";
    open.rel = "noreferrer";
    open.textContent = "新窗口打开";

    header.appendChild(heading);
    header.appendChild(open);

    const body = document.createElement("div");
    body.className = "spv-iframe-body";

    const iframe = document.createElement("iframe");
    iframe.src = url;
    iframe.loading = "eager";
    iframe.referrerPolicy = "no-referrer-when-downgrade";
    iframe.setAttribute("allowfullscreen", "allowfullscreen");
    iframe.title = title || "帖子详情";
    body.appendChild(iframe);

    shell.appendChild(header);
    shell.appendChild(body);
    return shell;
  }

  function openThreadIframe(url, title) {
    closeLightbox();
    closeDrawer();

    const overlay = document.createElement("div");
    overlay.className = "spv-lightbox spv-iframe-lightbox";
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeLightbox();
    });

    const shell = createThreadFrameShell(url, title);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "spv-close";
    close.textContent = "×";
    close.addEventListener("click", closeLightbox);

    overlay.appendChild(shell);
    overlay.appendChild(close);
    document.body.appendChild(overlay);
    document.documentElement.classList.add("spv-lightbox-open");
    document.addEventListener("keydown", handleLightboxKey);
  }

  function openThreadDrawer(url, title) {
    closeLightbox();

    const width = getDrawerWidthPx();
    const existing = document.querySelector(".spv-drawer");
    if (existing) {
      const oldShell = existing.querySelector(".spv-iframe-shell");
      const nextShell = createThreadFrameShell(url, title);
      const close = createDrawerCloseButton();
      nextShell.appendChild(close);
      if (oldShell) oldShell.replaceWith(nextShell);
      else existing.appendChild(nextShell);
      document.documentElement.classList.add("spv-drawer-open");
      setDrawerWidthPx(width);
      document.addEventListener("keydown", handleLightboxKey);
      return;
    }

    state.savedBodyPaddingRight = document.body.style.paddingRight || "";

    const drawer = document.createElement("div");
    drawer.className = "spv-drawer";

    const resizer = document.createElement("div");
    resizer.className = "spv-drawer-resizer";
    resizer.title = "拖动调整宽度";
    resizer.addEventListener("pointerdown", startDrawerResize);

    const shell = createThreadFrameShell(url, title);
    const close = createDrawerCloseButton();

    shell.appendChild(close);
    drawer.appendChild(resizer);
    drawer.appendChild(shell);
    document.body.appendChild(drawer);
    document.documentElement.classList.add("spv-drawer-open");
    setDrawerWidthPx(width);

    requestAnimationFrame(() => {
      drawer.classList.add("spv-drawer-visible");
    });
    document.addEventListener("keydown", handleLightboxKey);
  }

  function createDrawerCloseButton() {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "spv-drawer-close";
    close.textContent = "×";
    close.addEventListener("click", closeDrawer);
    return close;
  }

  function startDrawerResize(event) {
    if (event.button != null && event.button !== 0) return;
    if (event.cancelable) event.preventDefault();
    const handle = event.currentTarget;
    if (handle && typeof handle.setPointerCapture === "function") {
      handle.setPointerCapture(event.pointerId);
    }

    document.documentElement.classList.add("spv-drawer-resizing");
    let nextWidth = getDrawerWidthPxFromCss();
    let frame = 0;

    const move = (moveEvent) => {
      if (moveEvent.cancelable) moveEvent.preventDefault();
      nextWidth = window.innerWidth - moveEvent.clientX;
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          setDrawerWidthPx(nextWidth);
        });
      }
    };

    const end = (endEvent) => {
      if (endEvent && endEvent.cancelable) endEvent.preventDefault();
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      const width = setDrawerWidthPx(nextWidth);
      document.documentElement.classList.remove("spv-drawer-resizing");
      saveDrawerWidthPx(width);
      if (handle && typeof handle.releasePointerCapture === "function" && endEvent) {
        try {
          handle.releasePointerCapture(endEvent.pointerId);
        } catch (error) {
          debugWarn("drawer pointer release failed", error);
        }
      }
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      handle.removeEventListener("lostpointercapture", end);
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
  }

  function getDrawerWidthPxFromCss() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--spv-drawer-width");
    const width = parseFloat(raw);
    return Number.isFinite(width) ? width : getDrawerWidthPx();
  }

  function renderLightboxVideo(body, media) {
    const video = document.createElement("video");
    video.controls = true;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.referrerPolicy = "no-referrer";
    if (media.poster) video.poster = media.poster;

    const status = document.createElement("div");
    status.className = "spv-lightbox-status";

    body.appendChild(video);
    body.appendChild(status);

    const videoUrl = media.videoUrl || media.source || media.url;
    if (isGofileDownloadUrl(videoUrl)) {
      status.textContent = "正在加载视频...";
      loadGofileVideoBlob(video, videoUrl, status);
    } else {
      video.src = videoUrl;
      video.play().catch((error) => debugWarn("video play rejected", error));
    }
  }

  function isGofileDownloadUrl(url) {
    return /(?:^|\/\/)[^/]*gofile\.io\/download\/web\//i.test(url || "");
  }

  async function loadGofileVideoBlob(video, videoUrl, status) {
    try {
      const blobUrl = await getGofileVideoBlobUrl(videoUrl, (loaded, total) => {
        if (!document.contains(video)) return;
        const percent = total ? Math.floor((loaded / total) * 100) : 0;
        status.textContent = `正在加载视频... ${percent}%`;
      });
      if (!document.contains(video)) {
        URL.revokeObjectURL(blobUrl);
        return;
      }
      video.dataset.spvBlobUrl = blobUrl;
      video.src = blobUrl;
      status.textContent = "";
      await video.play();
    } catch (error) {
      status.textContent = `视频加载失败: ${error.message || error}`;
      debugWarn("Gofile video blob failed", error);
    }
  }

  function closeLightbox() {
    const overlay = document.querySelector(".spv-lightbox");
    if (overlay) {
      for (const video of overlay.querySelectorAll("video[data-spv-blob-url]")) {
        URL.revokeObjectURL(video.dataset.spvBlobUrl);
      }
      overlay.remove();
    }
    document.documentElement.classList.remove("spv-lightbox-open");
    document.removeEventListener("keydown", handleLightboxKey);
  }

  function closeDrawer() {
    const drawer = document.querySelector(".spv-drawer");
    if (drawer) drawer.remove();
    document.documentElement.classList.remove("spv-drawer-open", "spv-drawer-resizing");
    document.documentElement.style.removeProperty("--spv-drawer-width");
    document.body.style.paddingRight = state.savedBodyPaddingRight || "";
    document.removeEventListener("keydown", handleLightboxKey);
  }

  function handleLightboxKey(event) {
    if (event.key !== "Escape") return;
    closeLightbox();
    closeDrawer();
  }

  function removeExisting(item) {
    item.slot
      .querySelectorAll(`.${CONFIG.excerptClass}[data-spv-tid="${item.tid}"], .${CONFIG.stripClass}[data-spv-tid="${item.tid}"], .${CONFIG.badgeClass}[data-spv-tid="${item.tid}"]`)
      .forEach((node) => node.remove());
  }

  function readCache(tid) {
    try {
      const raw = localStorage.getItem(cacheKey(tid));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || Date.now() - parsed.time > CONFIG.cacheTtlMs) {
        localStorage.removeItem(cacheKey(tid));
        return null;
      }
      return parsed.value;
    } catch (error) {
      return null;
    }
  }

  function writeCache(tid, value) {
    try {
      localStorage.setItem(cacheKey(tid), JSON.stringify({ time: Date.now(), value }));
    } catch (error) {
      debugWarn("cache write failed", error);
    }
  }

  function cacheKey(tid) {
    return `spv:thread-media:v5:${tid}`;
  }

  function unique() {
    const seen = new Set();
    return (value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    };
  }

  function injectStyle() {
    const style = document.createElement("style");
    style.textContent = `
      .${CONFIG.slotClass}:empty {
        display: none;
      }

      .${CONFIG.slotClass} {
        clear: both;
        display: block;
        width: 0;
        min-width: 100%;
        max-width: 100%;
        overflow: hidden;
      }

      .${CONFIG.excerptClass} {
        display: -webkit-box;
        width: calc(100vw - 420px);
        min-width: 180px;
        max-width: 100%;
        margin: 4px 0 2px;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        color: #888;
        font-size: 11px;
        line-height: 1.45;
        white-space: normal;
        word-break: break-word;
      }

      html.spv-hide-excerpt .${CONFIG.excerptClass} {
        display: none;
      }

      .${CONFIG.stripClass} {
        display: flex;
        flex-wrap: nowrap;
        align-items: flex-start;
        gap: 6px;
        width: calc(100vw - 420px);
        min-width: 180px;
        max-width: 100%;
        margin: 6px 0 2px;
        padding: 3px 1px 4px;
        overflow-x: auto;
        overflow-y: hidden;
        white-space: nowrap;
        scrollbar-width: none;
        box-sizing: border-box;
        overscroll-behavior-inline: contain;
      }

      .${CONFIG.stripClass}.spv-can-scroll-right {
        -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 34px), transparent);
        mask-image: linear-gradient(to right, #000 calc(100% - 34px), transparent);
      }

      .${CONFIG.stripClass}.spv-strip-empty {
        display: none;
      }

      .${CONFIG.stripClass}::-webkit-scrollbar {
        display: none;
      }

      @media (max-width: 760px) {
        .${CONFIG.excerptClass},
        .${CONFIG.stripClass} {
          width: 100%;
          min-width: 0;
        }
      }

      .spv-mobile-meta {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px 8px;
        margin: 3px 0 0;
        color: #777;
        font-size: 12px;
        line-height: 1.5;
      }

      li[class*="author_"] > a.spv-mobile-title {
        padding: 0 !important;
        box-shadow: none !important;
        text-shadow: none !important;
      }

      .spv-mobile-meta:empty {
        display: none;
      }

      .spv-mobile-meta .num,
      .spv-mobile-meta .by,
      .spv-mobile-meta span,
      .spv-mobile-meta a {
        float: none !important;
        position: static !important;
        display: inline !important;
        margin: 0 !important;
        padding: 0 !important;
        line-height: inherit !important;
      }

      .spv-mobile-meta .by {
        color: inherit !important;
        font-weight: normal !important;
      }

      .spv-mobile-meta .num {
        margin-left: auto !important;
        white-space: nowrap !important;
      }

      .spv-media {
        position: relative;
        display: block;
        flex: 0 0 92px;
        width: 92px;
        height: 68px;
        margin-right: 0;
        padding: 0 !important;
        border: 1px solid rgba(0, 0, 0, 0.12);
        border-radius: 5px;
        background: #f4f5f7;
        box-sizing: border-box;
        vertical-align: top;
        overflow: hidden;
        line-height: 0;
        font-size: 0;
        text-decoration: none;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
        transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
      }

      .spv-media:hover {
        border-color: rgba(28, 105, 190, 0.48);
        box-shadow: 0 3px 8px rgba(0, 0, 0, 0.16);
        transform: translateY(-1px);
      }

      .spv-media img {
        display: block;
        width: 100%;
        height: 100%;
        max-width: none !important;
        margin: 0 !important;
        padding: 0 !important;
        border: 0 !important;
        object-fit: cover;
      }

      .spv-video-placeholder {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        background: linear-gradient(135deg, #252a31, #111418);
        color: rgba(255, 255, 255, 0.78);
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0;
      }

      .spv-play {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 26px;
        height: 26px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.74);
        background: rgba(0, 0, 0, 0.55);
        color: #fff;
        font-size: 12px;
        line-height: 26px;
        text-align: center;
        transform: translate(-50%, -50%);
        pointer-events: none;
        box-shadow: 0 1px 5px rgba(0, 0, 0, 0.35);
      }

      .spv-kind {
        position: absolute;
        right: 3px;
        bottom: 3px;
        padding: 0 4px;
        border-radius: 3px;
        background: rgba(0, 0, 0, 0.66);
        color: #fff;
        font-size: 10px;
        line-height: 15px;
        pointer-events: none;
      }

      .${CONFIG.badgeClass} {
        display: inline-block;
        margin: 5px 0 1px;
        padding: 2px 7px;
        border: 1px solid rgba(0, 0, 0, 0.14);
        border-radius: 4px;
        background: linear-gradient(#fff, #f3f5f7);
        color: #58606a;
        font-size: 12px;
        line-height: 1.6;
        text-decoration: none;
        vertical-align: top;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
      }

      .${CONFIG.badgeClass}:hover {
        color: #2f5f9d;
        border-color: rgba(47, 95, 157, 0.38);
        background: #fff;
      }

      .spv-title-toggle {
        position: fixed;
        right: 12px;
        bottom: 12px;
        z-index: 99999;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 6px;
        border: 1px solid rgba(0, 0, 0, 0.16);
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.88);
        color: #333;
        font-size: 12px;
        line-height: 1.4;
        cursor: pointer;
        user-select: none;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
      }

      html.spv-drawer-open .spv-title-toggle {
        right: calc(12px + var(--spv-drawer-width));
      }

      .spv-title-toggle:hover {
        background: #fff;
      }

      .spv-title-toggle select {
        margin: 0;
        padding: 0 14px 0 3px;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }

      .spv-title-toggle-check {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        margin-left: 3px;
        cursor: pointer;
      }

      .spv-title-toggle-check input {
        width: 12px;
        height: 12px;
        margin: 0;
        cursor: pointer;
      }

      .spv-title-toggle-off {
        opacity: 0.62;
      }

      .spv-lightbox {
        position: fixed;
        inset: 0;
        z-index: 100000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 38px 44px;
        background: rgba(0, 0, 0, 0.72);
        box-sizing: border-box;
      }

      html.spv-lightbox-open,
      html.spv-lightbox-open body {
        overflow: hidden !important;
      }

      .spv-lightbox-body {
        position: relative;
        max-width: min(86vw, 1180px);
        max-height: min(82vh, 820px);
        border-radius: 7px;
        overflow: hidden;
        background: #111;
        box-shadow: 0 18px 52px rgba(0, 0, 0, 0.42);
      }

      .spv-lightbox-body img,
      .spv-lightbox-body video {
        display: block;
        max-width: min(86vw, 1180px);
        max-height: min(82vh, 820px);
        width: auto;
        height: auto;
        object-fit: contain;
      }

      .spv-lightbox-status {
        position: absolute;
        left: 50%;
        top: 50%;
        max-width: 70%;
        padding: 7px 10px;
        border-radius: 4px;
        background: rgba(0, 0, 0, 0.58);
        color: #fff;
        font-size: 13px;
        line-height: 1.5;
        text-align: center;
        transform: translate(-50%, -50%);
        pointer-events: none;
      }

      .spv-lightbox-status:empty {
        display: none;
      }

      .spv-close {
        position: fixed;
        right: 22px;
        top: 18px;
        width: 34px;
        height: 34px;
        border: 0;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.14);
        color: #fff;
        font-size: 24px;
        line-height: 32px;
        cursor: pointer;
      }

      .spv-close:hover {
        background: rgba(255, 255, 255, 0.24);
      }

      .spv-lightbox-footer {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 18px;
        text-align: center;
        pointer-events: none;
      }

      .spv-lightbox-footer a {
        display: inline-block;
        padding: 5px 10px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.16);
        color: #fff;
        font-size: 12px;
        line-height: 1.5;
        text-decoration: none;
        pointer-events: auto;
      }

      .spv-lightbox-footer a:hover {
        background: rgba(255, 255, 255, 0.26);
      }

      .spv-drawer {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        z-index: 100000;
        width: var(--spv-drawer-width);
        background: #fff;
        box-shadow: -12px 0 30px rgba(0, 0, 0, 0.24);
        transform: translateX(102%);
        transition: transform 0.22s ease;
      }

      .spv-drawer-resizer {
        position: absolute;
        left: -5px;
        top: 0;
        bottom: 0;
        z-index: 2;
        width: 10px;
        cursor: col-resize;
        touch-action: none;
      }

      .spv-drawer-resizer::after {
        content: "";
        position: absolute;
        left: 4px;
        top: 0;
        bottom: 0;
        width: 2px;
        background: rgba(47, 95, 157, 0);
        transition: background 0.15s ease;
      }

      .spv-drawer-resizer:hover::after,
      html.spv-drawer-resizing .spv-drawer-resizer::after {
        background: rgba(47, 95, 157, 0.5);
      }

      html.spv-drawer-resizing,
      html.spv-drawer-resizing body {
        cursor: col-resize !important;
        user-select: none !important;
      }

      html.spv-drawer-resizing .spv-drawer iframe {
        pointer-events: none;
      }

      .spv-drawer-visible {
        transform: translateX(0);
      }

      html.spv-drawer-open body {
        transition: padding-right 0.22s ease;
        box-sizing: border-box;
      }

      .spv-iframe-lightbox {
        padding: 34px 42px;
      }

      .spv-iframe-shell {
        display: flex;
        flex-direction: column;
        width: min(1120px, 92vw);
        height: min(860px, 88vh);
        border-radius: 7px;
        overflow: hidden;
        background: #fff;
        box-shadow: 0 18px 52px rgba(0, 0, 0, 0.42);
      }

      .spv-drawer .spv-iframe-shell {
        position: relative;
        width: 100%;
        height: 100%;
        border-radius: 0;
        box-shadow: none;
      }

      .spv-iframe-header {
        display: flex;
        align-items: center;
        gap: 14px;
        min-height: 40px;
        padding: 0 14px;
        border-bottom: 1px solid rgba(0, 0, 0, 0.12);
        background: #f7f8fa;
        box-sizing: border-box;
      }

      .spv-drawer .spv-iframe-header {
        padding-right: 48px;
      }

      .spv-iframe-title {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        color: #222;
        font-size: 14px;
        font-weight: 600;
        line-height: 40px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .spv-iframe-header a {
        flex: 0 0 auto;
        color: #2f5f9d;
        font-size: 12px;
        line-height: 1.5;
        text-decoration: none;
      }

      .spv-iframe-header a:hover {
        text-decoration: underline;
      }

      .spv-iframe-body {
        flex: 1 1 auto;
        min-height: 0;
        background: #fff;
      }

      .spv-iframe-body iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: #fff;
      }

      .spv-drawer-close {
        position: absolute;
        right: 9px;
        top: 6px;
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.06);
        color: #333;
        font-size: 20px;
        line-height: 26px;
        cursor: pointer;
      }

      .spv-drawer-close:hover {
        background: rgba(0, 0, 0, 0.12);
      }

      @media (max-width: 760px) {
        html.spv-drawer-open .spv-title-toggle {
          right: 12px;
        }

        .spv-drawer {
          width: 100vw;
        }

        html.spv-drawer-open body {
          padding-right: 0 !important;
        }

        .spv-iframe-lightbox {
          padding: 18px 10px;
        }

        .spv-iframe-shell {
          width: 100%;
          height: 92vh;
        }
      }

    `;
    document.head.appendChild(style);
  }
})();
