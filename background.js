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
  saveMode: 'zip',    // zip：打包成一个 ZIP 文件；files：逐张保存图片
  targetArea: 'right' // right: 优先右侧区域（如评论区/右侧栏）| auto: 顶层智能识别 | left: 优先左侧区域 | center: 优先中间主内容
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

// 自包含函数：在目标页面中执行滚动和状态检测
// action: 'init' | 'scroll'
function pageAction(action, overlap, scrollToTop, targetArea = 'right') {
  const root = document.scrollingElement || document.documentElement || document.body;
  const isRoot = (el) => el === root || el === document.documentElement || el === document.body;

  const getScrollPos = (el) => {
    if (isRoot(el)) {
      return {
        top: window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0,
        height: window.innerHeight,
        scrollHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
      };
    }
    return {
      top: el.scrollTop,
      height: el.clientHeight,
      scrollHeight: el.scrollHeight
    };
  };

  const getVisibleArea = (el) => {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
    return w * h;
  };

  const canScroll = (el) => {
    if (!el) return false;
    if (isRoot(el)) {
      const sh = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
      return sh - window.innerHeight > 5;
    }
    const style = window.getComputedStyle(el);
    const oy = style.overflowY;
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false;
    return el.scrollHeight - el.clientHeight > 5;
  };

  // 计算元素在 DOM 和层叠上下文中的综合层级权重 (z-index + position)
  const getLayerDepth = (el) => {
    if (isRoot(el)) return 0;
    let depth = 0;
    let cur = el;
    while (cur && cur !== document.documentElement && cur !== document.body) {
      depth += 1;
      const s = window.getComputedStyle(cur);
      const z = parseInt(s.zIndex, 10);
      if (!isNaN(z) && z > 0) {
        depth += Math.min(10000, z * 10);
      }
      if (s.position === 'fixed' || s.position === 'sticky') {
        depth += 1000;
      } else if (s.position === 'absolute') {
        depth += 100;
      }
      if (cur.tagName === 'DIALOG' || cur.getAttribute('role') === 'dialog') {
        depth += 5000;
      }
      cur = cur.parentElement;
    }
    return depth;
  };

  // 根据用户选取的区域偏好（right: 优先右侧评论区 / left: 优先左侧 / center: 优先中间视频 / auto: 顶层自动）评分
  const getAreaScore = (el) => {
    if (isRoot(el)) return 1;
    const r = el.getBoundingClientRect();
    const centerX = (r.left + r.right) / 2;
    const normX = centerX / window.innerWidth; // 0 (最左) ~ 1 (最右)

    if (targetArea === 'right') {
      // 位于屏幕右半侧（例如抖音评论区通常在 x > 0.5），右侧越靠边缘得分越高
      return normX >= 0.5 ? 5000 + normX * 1000 : 1;
    } else if (targetArea === 'center') {
      // 位于屏幕正中（例如抖音视频区域），越靠近中心得分越高
      const distFromCenter = Math.abs(normX - 0.5);
      return (1 - distFromCenter) * 3000;
    } else if (targetArea === 'left') {
      // 位于屏幕左半侧
      return normX < 0.5 ? 5000 + (1 - normX) * 1000 : 1;
    }
    return 10;
  };

  // 严格从视觉最上层和指定区域探测可滚动容器
  const findTopmostScroller = () => {
    const candidates = new Map(); // el -> { el, layerDepth, areaScore, visible, scrollRange }

    const register = (el) => {
      if (!el || !canScroll(el)) return;
      if (candidates.has(el)) return;
      const visible = getVisibleArea(el);
      // 可见面积必须占视口的 5% 以上，排除无意义的小下拉菜单
      if (visible < (window.innerWidth * window.innerHeight * 0.05)) return;

      const layerDepth = getLayerDepth(el);
      const scrollRange = el.scrollHeight - el.clientHeight;
      const areaScore = getAreaScore(el);
      candidates.set(el, { el, layerDepth, areaScore, visible, scrollRange });
    };

    // 1. 使用网格采样点（根据 targetArea 重点采样右侧/中间/左侧）
    const samplePoints = [
      [0.85, 0.5], [0.85, 0.3], [0.85, 0.7], [0.75, 0.5], // 右侧高频采样点（抖音评论区等）
      [0.5, 0.5], [0.5, 0.3], [0.5, 0.7],                 // 中间采样点（视频区）
      [0.2, 0.5], [0.2, 0.3]                              // 左侧采样点
    ];
    for (const [rx, ry] of samplePoints) {
      const x = Math.round(window.innerWidth * rx);
      const y = Math.round(window.innerHeight * ry);
      let cur = document.elementFromPoint(x, y);
      while (cur && cur !== document.documentElement && cur !== document.body) {
        register(cur);
        cur = cur.parentElement;
      }
    }

    // 2. 检查顶层特定容器（dialog、modal、drawer、评论区抽屉组件）
    const highLevelContainers = document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"], .modal, .drawer, [class*="comment"], [id*="comment"]');
    for (const d of highLevelContainers) {
      let cur = d;
      while (cur && cur !== document.documentElement && cur !== document.body) {
        register(cur);
        cur = cur.parentElement;
      }
      for (const descendant of d.querySelectorAll('*')) {
        register(descendant);
      }
    }

    // 3. 将整个页面根容器作为兜底候选
    if (canScroll(root)) {
      candidates.set(root, {
        el: root,
        layerDepth: 0,
        areaScore: 1,
        visible: window.innerWidth * window.innerHeight,
        scrollRange: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0) - window.innerHeight
      });
    }

    if (candidates.size === 0) return root;

    // 排序逻辑：
    // 1. 位置匹配偏好（如果选了右侧评论区，右侧区域获得压倒性高优先级）
    // 2. 层级深度（模态窗/浮层优先）
    // 3. 滚动有效面积
    const sorted = Array.from(candidates.values()).sort((a, b) => {
      if (b.areaScore !== a.areaScore) {
        return b.areaScore - a.areaScore;
      }
      if (b.layerDepth !== a.layerDepth) {
        return b.layerDepth - a.layerDepth;
      }
      return b.visible * b.scrollRange - a.visible * a.scrollRange;
    });

    return sorted[0].el;
  };

  const describe = (el) => {
    if (isRoot(el)) return '页面主视图 (Window/Document)';
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/)[0]
      : '';
    const r = el.getBoundingClientRect();
    const isRight = (r.left + r.right) / 2 >= window.innerWidth * 0.5 ? ' [右侧区域/评论区]' : ' [中左侧内容]';
    return `${tag}${id}${cls}${isRight}`;
  };

  // 派发真实的 Wheel 事件到该容器正中央
  const dispatchWheel = (target, deltaY) => {
    const rect = isRoot(target)
      ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
      : target.getBoundingClientRect();

    // 确保把事件派发在最上层滚动区域的内部可视中心
    const clientX = Math.round((Math.max(0, rect.left) + Math.min(window.innerWidth, rect.right)) / 2);
    const clientY = Math.round((Math.max(0, rect.top) + Math.min(window.innerHeight, rect.bottom)) / 2);

    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      deltaX: 0,
      deltaY,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL
    });
    const dispatchTarget = document.elementFromPoint(clientX, clientY) || (isRoot(target) ? document.body : target);
    dispatchTarget.dispatchEvent(event);
  };

  // 派发 PageDown / ArrowDown 键盘事件作为强力兜底
  const dispatchKey = (key = 'PageDown') => {
    const active = document.activeElement || document.body;
    active.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
    active.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true, cancelable: true }));
  };

  // 智能检测顶部固定吸顶元素（fixed / sticky），计算有效可见内容高度
  const getHeaderOffset = () => {
    let maxBottom = 0;
    const elements = document.querySelectorAll('header, nav, [role="banner"], [class*="header"], [class*="nav"], [class*="topbar"]');
    for (const el of elements) {
      const style = window.getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'sticky') {
        const r = el.getBoundingClientRect();
        if (r.top <= 10 && r.bottom > 0 && r.bottom < window.innerHeight * 0.4 && r.width > window.innerWidth * 0.5) {
          if (r.bottom > maxBottom) maxBottom = r.bottom;
        }
      }
    }
    return Math.round(maxBottom);
  };

  const target = findTopmostScroller();
  const beforePos = getScrollPos(target);

  if (action === 'init') {
    if (scrollToTop) {
      if (isRoot(target)) {
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      } else {
        target.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      }
    }
    return {
      success: true,
      targetName: describe(target),
      scrollTop: getScrollPos(target).top,
      scrollHeight: getScrollPos(target).scrollHeight
    };
  }

  // action === 'scroll': 精确向下滚动一屏
  const viewportH = beforePos.height || window.innerHeight;
  const headerOffset = getHeaderOffset(); // 如果有顶部固定导航条，避免下一屏被遮挡
  const manualOverlap = Math.max(0, overlap);

  // 科学步长：刚好等于当前视口高度，减去吸顶导航栏高度，再减去设定的重叠像素（若未设重叠，保留 30px 作为视觉无缝衔接裕量）
  const effectiveOverlap = manualOverlap > 0 ? manualOverlap : (headerOffset > 0 ? headerOffset + 20 : 40);
  const scrollStep = Math.max(50, viewportH - effectiveOverlap);
  const targetY = beforePos.top + scrollStep;

  // 1. 首选：精确位置滚动（直接赋值 targetY，确保不滚多也不滚少）
  if (isRoot(target)) {
    window.scrollTo({ top: targetY, left: window.scrollX, behavior: 'instant' });
  } else {
    target.scrollTo({ top: targetY, left: target.scrollLeft, behavior: 'instant' });
  }

  let afterPos = getScrollPos(target);
  let movedDistance = afterPos.top - beforePos.top;

  // 2. 备用：如果页面不支持绝对坐标或者是个虚拟列表容器，才回退到 wheel / key
  if (movedDistance <= 1) {
    dispatchWheel(target, scrollStep);
    afterPos = getScrollPos(target);
    movedDistance = afterPos.top - beforePos.top;
  }

  if (movedDistance <= 1) {
    dispatchKey('PageDown');
    afterPos = getScrollPos(target);
    movedDistance = afterPos.top - beforePos.top;
  }

  return {
    moved: movedDistance > 2,
    actualMoved: movedDistance,
    scrollTop: afterPos.top,
    targetName: describe(target)
  };
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

  // ---- 阶段一：只截图，不保存 ----
  try {
    const [{ result: init }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageAction,
      args: ['init', 0, !!opts.scrollToTop, opts.targetArea || 'right']
    });
    targetName = init?.targetName || '';
    if (opts.scrollToTop) await sleep(opts.delay);

    let prev = await capture();
    shots.push({ name: `${prefix}_001.${ext}`, dataUrl: prev });

    while (true) {
      await setState({
        count: shots.length,
        message: `已截取 ${shots.length} 张（暂存内存）` +
          (targetName ? `\n滚动区域：${targetName}` : '')
      });

      if ((await getState()).state !== 'running') { stopReason = '已手动停止'; break; }
      if (shots.length >= maxShots) { stopReason = '已达到最多张数'; break; }

      // 滚动到新的可见区域（使用融合式多策略滚动）
      const [{ result: scrollRes }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: pageAction,
        args: ['scroll', overlap, false, opts.targetArea || 'right']
      });

      if (scrollRes?.targetName) targetName = scrollRes.targetName;

      // 等待页面重新排版和懒加载图片渲染
      await sleep(opts.delay);
      if ((await getState()).state !== 'running') { stopReason = '已手动停止'; break; }

      const dataUrl = await capture();

      // 如果画面完全没有改变，且滚动逻辑也汇报没有位移，说明已经到最底部
      if (dataUrl === prev && (!scrollRes || !scrollRes.moved || scrollRes.actualMoved <= 0)) {
        stopReason = '已滚动到底部';
        break;
      }

      // 如果画面没变但是刚才滚动了（可能处于加载中或吸顶元素覆盖），再额外检测一次
      if (dataUrl === prev) {
        stopReason = '内容无变化，已到底部';
        break;
      }

      shots.push({ name: `${prefix}_${String(shots.length + 1).padStart(3, '0')}.${ext}`, dataUrl });
      prev = dataUrl;
    }
  } catch (err) {
    console.error(err);
    stopReason = `截图中断：${err.message || err}`;
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
