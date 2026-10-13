// Scroll Screenshot — service worker
// 任务状态保存在 chrome.storage.session 中。
// 截图数据只在一次任务期间暂存在内存里（任务期间 Service Worker 持续调用扩展 API，不会被回收），
// 全部截完后再一次性保存。

const DEFAULT_OPTIONS = {
  delay: 1000,        // 每次滚动后等待渲染的时间（毫秒）
  maxShots: 0,        // 最多截图张数（0 = 不限，直到无法滚动）
  overlap: 0,         // 相邻两屏的重叠像素
  scrollToTop: true,  // 开始前先滚动到顶部
  subfolder: '',      // 下载目录下的子文件夹（留空则直接保存到 ~/Downloads/）
  format: 'png',      // png | jpeg
  saveMode: 'zip'     // zip：打包成一个 ZIP 文件；files：逐张保存图片
};

// captureVisibleTab 限制每秒最多 2 次
const MIN_CAPTURE_INTERVAL = 600;

// “不限张数”时的安全上限（防止无限滚动页面或动画导致永不停止）
const SAFETY_MAX_SHOTS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getState() {
  const { state = 'idle', count = 0, message = '' } =
    await chrome.storage.session.get(['state', 'count', 'message']);
  return { state, count, message };
}

async function setState(patch) {
  await chrome.storage.session.set(patch);
  if ('count' in patch || 'state' in patch) {
    const { state, count } = await getState();
    const busy = state === 'running' || state === 'stopping' || state === 'saving';
    await chrome.action.setBadgeBackgroundColor({ color: busy ? '#d93025' : '#1a73e8' });
    await chrome.action.setBadgeText({ text: busy || count > 0 ? String(count) : '' });
  }
}

async function getOptions() {
  const { options_v2: options = {} } = await chrome.storage.local.get('options_v2');
  return { ...DEFAULT_OPTIONS, ...options };
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sanitize(name) {
  return name.replace(/[\\:*?"<>|]/g, '_').replace(/\.\.+/g, '.').replace(/^\/+|\/+$/g, '').trim();
}

// ---------- 保存（离屏文档负责生成 Blob URL / ZIP，Service Worker 负责下载） ----------

const OFFSCREEN_URL = 'offscreen.html';

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['BLOBS'],
    justification: '把截图转换为 Blob / ZIP 以便保存到下载目录'
  });
}

async function closeOffscreen() {
  try { await chrome.offscreen.closeDocument(); } catch (e) { /* 已关闭 */ }
}

async function toOffscreen(msg) {
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
  if (!res?.ok) throw new Error(res?.error || '离屏文档无响应');
  return res;
}

// 等待下载完成（Blob URL 必须在下载读取完毕后才能释放）
function waitForDownload(id) {
  return new Promise((resolve) => {
    const done = (state) => {
      chrome.downloads.onChanged.removeListener(listener);
      resolve(state);
    };
    const listener = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current !== 'in_progress') done(delta.state.current);
    };
    chrome.downloads.onChanged.addListener(listener);
    (async () => {
      const [item] = await chrome.downloads.search({ id });
      if (!item || item.state !== 'in_progress') done(item?.state || 'interrupted');
    })();
  });
}

async function saveAll(shots, opts, prefix, sub) {
  const withSub = (name) => (sub ? `${sub}/${name}` : name);
  await ensureOffscreen();
  try {
    if (opts.saveMode === 'files') {
      const ids = [];
      for (let i = 0; i < shots.length; i++) {
        await setState({ message: `正在保存 ${i + 1}/${shots.length}…` });
        const { url } = await toOffscreen({ type: 'blob-url', dataUrl: shots[i].dataUrl });
        ids.push(await chrome.downloads.download({
          url, filename: withSub(shots[i].name), conflictAction: 'uniquify', saveAs: false
        }));
      }
      await Promise.all(ids.map(waitForDownload));
      return `${shots.length} 张图片`;
    }

    await toOffscreen({ type: 'zip-reset' });
    for (let i = 0; i < shots.length; i++) {
      await setState({ message: `正在打包 ${i + 1}/${shots.length}…` });
      await toOffscreen({ type: 'zip-add', name: shots[i].name, dataUrl: shots[i].dataUrl });
    }
    const { url } = await toOffscreen({ type: 'zip-finish' });
    const zipName = `${prefix}.zip`;
    const id = await chrome.downloads.download({
      url, filename: withSub(zipName), conflictAction: 'uniquify', saveAs: false
    });
    await setState({ message: '正在写入 ZIP…' });
    await waitForDownload(id);
    return `${zipName}（含 ${shots.length} 张）`;
  } finally {
    await closeOffscreen();
  }
}

// ---------- 注入到页面中执行的函数 ----------

// 注意：通过 executeScript 注入的函数必须是自包含的（不能引用外部函数）
// action = 'init'：找到真正负责滚动的元素并标记（可选滚动到顶部）
// action = 'scroll'：把标记的元素向下滚动一屏，返回是否真的滚动了
function pageAction(action, overlap, scrollToTop) {
  const MARK = 'data-scroll-shot-target';
  const root = document.scrollingElement || document.documentElement;
  const isRoot = (t) => t === root || t === document.documentElement;
  const getTop = (t) => (isRoot(t) ? window.scrollY : t.scrollTop);
  const setTop = (t, y) => {
    if (isRoot(t)) window.scrollTo({ top: y, left: window.scrollX, behavior: 'instant' });
    else t.scrollTo({ top: y, left: t.scrollLeft, behavior: 'instant' });
  };
  const viewportOf = (t) => (isRoot(t) ? window.innerHeight : t.clientHeight);

  // 真实测试一个元素能否滚动（向下或向上挪 1px 再恢复）
  const probe = (t) => {
    if (!t || t.scrollHeight - t.clientHeight <= 1) return false;
    const b = getTop(t);
    setTop(t, b + 1);
    let ok = getTop(t) !== b;
    if (!ok) { setTop(t, b - 1); ok = getTop(t) !== b; }
    setTop(t, b);
    return ok;
  };
  const visibleArea = (el) => {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return w * h;
  };
  const describe = (t) => (isRoot(t) ? 'document' :
    t.tagName.toLowerCase() + (t.id ? '#' + t.id : '') +
    (typeof t.className === 'string' && t.className.trim() ? '.' + t.className.trim().split(/\s+/)[0] : ''));

  const range = (t) => (isRoot(t) ? t.scrollHeight - window.innerHeight : t.scrollHeight - t.clientHeight);

  const findTarget = () => {
    // 在“视口中心元素的祖先链 + 整个文档”中，选可滚动距离最大的那个
    // （以前优先选文档，若文档只能滚几个像素而真正内容在内部容器里，就会出现两张几乎一样的图）
    const minArea = innerWidth * innerHeight * 0.25;
    const chain = new Set([root]);
    let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    while (el) { chain.add(el); el = el.parentElement; }
    let best = null;
    let bestRange = 0;
    for (const c of chain) {
      if (!isRoot(c) && visibleArea(c) < minArea) continue;
      if (!probe(c)) continue;
      const r = range(c);
      if (r > bestRange) { best = c; bestRange = r; }
    }
    if (best && bestRange >= 100) return best;

    // 兜底：整个页面中“可见面积 × 可滚动距离”最大的元素
    let bestScore = best ? visibleArea(best) * bestRange : 0;
    for (const e of document.querySelectorAll('body, body *')) {
      const r = e.scrollHeight - e.clientHeight;
      if (r <= 1) continue;
      const score = visibleArea(e) * r;
      if (score > bestScore && probe(e)) { best = e; bestScore = score; }
    }
    return best;
  };

  // 目标在屏幕上的可见区域：用于确定鼠标滚轮的位置和每次滚动的距离
  const geometry = (t) => {
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    if (t && !isRoot(t)) {
      const r = t.getBoundingClientRect();
      left = Math.max(0, r.left); top = Math.max(0, r.top);
      right = Math.min(innerWidth, r.right); bottom = Math.min(innerHeight, r.bottom);
    }
    return {
      vw: innerWidth,
      cx: Math.round((left + right) / 2),
      cy: Math.round((top + bottom) / 2),
      height: Math.round(Math.min(bottom - top, t && !isRoot(t) ? t.clientHeight : innerHeight))
    };
  };

  if (action === 'init') {
    document.querySelectorAll(`[${MARK}]`).forEach((e) => e.removeAttribute(MARK));
    const t = findTarget();
    if (t) {
      t.setAttribute(MARK, '1');
      if (scrollToTop) setTop(t, 0);
    }
    if (scrollToTop && t !== root) setTop(root, 0);
    return { found: !!t, target: t ? describe(t) : '', ...geometry(t) };
  }

  // action === 'scroll'（无法使用调试器滚轮时的备用方案）
  let t = document.querySelector(`[${MARK}]`);
  if (!t) {
    t = findTarget();
    if (!t) return { moved: false };
    t.setAttribute(MARK, '1');
  }
  const before = getTop(t);
  const step = Math.max(50, viewportOf(t) - overlap);
  setTop(t, before + step);
  const after = getTop(t);
  return { moved: after - before > 0.5, target: describe(t), top: after };
}

// ---------- 主流程 ----------

async function startCapture(tab) {
  const { state } = await getState();
  if (state !== 'idle') return;

  await setState({ state: 'running', count: 0, message: '正在截图…', tabId: tab.id });
  const opts = await getOptions();
  const ext = opts.format === 'jpeg' ? 'jpg' : 'png';
  const sub = sanitize(opts.subfolder || '');
  const prefix = `screenshot_${timestamp()}`;
  const shots = []; // 本次任务的截图，暂存内存
  let lastCapture = 0;
  let targetName = '';
  let stopReason = '';
  const maxShots = Number(opts.maxShots) > 0 ? Number(opts.maxShots) : SAFETY_MAX_SHOTS;
  const overlap = Number(opts.overlap) || 0;
  const debuggee = { tabId: tab.id };
  let useWheel = false;

  const capture = async () => {
    // 确认仍然在目标标签页上（captureVisibleTab 只能截取当前激活的标签页）
    const current = await chrome.tabs.get(tab.id);
    if (!current.active) throw new Error('目标标签页已不在前台');
    const wait = MIN_CAPTURE_INTERVAL - (Date.now() - lastCapture);
    if (wait > 0) await sleep(wait);
    const dataUrl = await chrome.tabs.captureVisibleTab(current.windowId, {
      format: opts.format === 'jpeg' ? 'jpeg' : 'png',
      quality: 92
    });
    lastCapture = Date.now();
    return dataUrl;
  };

  // 备用滚动：直接修改页面元素的滚动位置
  const domScroll = async () => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageAction,
      args: ['scroll', overlap, false]
    });
    if (result?.target) targetName = result.target;
    return !!result?.moved;
  };

  // ---- 阶段一：只截图，不保存 ----
  try {
    // 附加调试器，用“真实鼠标滚轮”滚动——和用户手动滚动效果一致，
    // 对内部滚动容器、iframe、虚拟列表等都有效
    try {
      await chrome.debugger.attach(debuggee, '1.3');
      useWheel = true;
      await sleep(500); // 等待调试提示条出现后视口尺寸稳定
    } catch (e) {
      console.warn('无法附加调试器，改用 DOM 滚动：', e);
    }

    const [{ result: init }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageAction,
      args: ['init', 0, !!opts.scrollToTop]
    });
    targetName = init?.target || '';
    // 鼠标放在屏幕最右侧（垂直方向取滚动区域的中间）
    const wheelX = Math.max(0, (init?.vw ?? 800) - 2);
    const wheelY = init?.cy ?? 300;
    const step = Math.max(50, (init?.height || 600) - overlap);
    if (opts.scrollToTop) await sleep(opts.delay);

    const wheelScroll = async () => {
      // 先把鼠标移到最右侧，再在该位置滚动滚轮
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: wheelX, y: wheelY
      });
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: wheelX, y: wheelY, deltaX: 0, deltaY: step
      });
    };

    let prev = await capture();
    shots.push({ name: `${prefix}_001.${ext}`, dataUrl: prev });

    while (true) {
      await setState({
        count: shots.length,
        message: `已截取 ${shots.length} 张（暂存内存）` +
          (targetName ? `\n滚动区域：${targetName}` : '') + (useWheel ? '' : '\n（DOM 滚动模式）')
      });

      if ((await getState()).state !== 'running') { stopReason = '已手动停止'; break; }
      if (shots.length >= maxShots) { stopReason = '已达到最多张数'; break; }

      // 滚动到新的可见区域
      let moved = true;
      if (useWheel) await wheelScroll();
      else moved = await domScroll();
      if (!moved) { stopReason = '已滚动到底部'; break; }

      await sleep(opts.delay);
      if ((await getState()).state !== 'running') { stopReason = '已手动停止'; break; }

      let dataUrl = await capture();

      // 画面没有变化：滚轮没生效时再用 DOM 滚动试一次
      if (dataUrl === prev && useWheel && await domScroll()) {
        await sleep(opts.delay);
        dataUrl = await capture();
      }
      // 仍然完全相同，说明已经无法再滚动，丢弃这张重复图
      if (dataUrl === prev) { stopReason = '已滚动到底部'; break; }

      shots.push({ name: `${prefix}_${String(shots.length + 1).padStart(3, '0')}.${ext}`, dataUrl });
      prev = dataUrl;
    }
  } catch (err) {
    console.error(err);
    stopReason = `截图中断：${err.message || err}`;
  } finally {
    if (useWheel) {
      try { await chrome.debugger.detach(debuggee); } catch (e) { /* 已断开 */ }
    }
  }

  if (!shots.length) {
    await setState({ state: 'idle', message: `未截取到图片。${stopReason}` });
    return;
  }

  // ---- 阶段二：一次性保存全部截图 ----
  await setState({ state: 'saving', message: `${stopReason}，正在保存 ${shots.length} 张…` });
  try {
    const saved = await saveAll(shots, opts, prefix, sub);
    await setState({
      state: 'idle',
      message: `完成（${stopReason}）：已保存 ${saved} 到 ~/Downloads/${sub ? sub + '/' : ''}`
    });
  } catch (err) {
    console.error(err);
    await setState({ state: 'idle', message: `保存失败：${err.message || err}` });
  }
}

async function stopCapture() {
  const { state } = await getState();
  if (state === 'running') await setState({ state: 'stopping', message: '正在停止…' });
}

async function toggle() {
  const { state } = await getState();
  if (state === 'running') return stopCapture();
  if (state !== 'idle') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await startCapture(tab);
}

// ---------- 事件 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false; // 发给离屏文档的消息，不在这里处理
  (async () => {
    try {
      if (msg.type === 'start') {
        const tab = await chrome.tabs.get(msg.tabId);
        startCapture(tab); // 不等待，长任务在后台运行
      } else if (msg.type === 'stop') {
        await stopCapture();
      }
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-capture') toggle();
});

// 浏览器重启 / 扩展更新后重置可能残留的状态
const resetState = () => setState({ state: 'idle', count: 0, message: '' });
chrome.runtime.onStartup.addListener(resetState);
chrome.runtime.onInstalled.addListener(resetState);
