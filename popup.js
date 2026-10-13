const DEFAULT_OPTIONS = {
  delay: 1000,
  maxShots: 0,
  overlap: 0,
  scrollToTop: true,
  subfolder: '',
  format: 'png',
  saveMode: 'zip'
};

const $ = (id) => document.getElementById(id);
const btn = $('toggle');
const statusEl = $('status');
const fields = ['delay', 'maxShots', 'overlap', 'format', 'saveMode', 'subfolder', 'scrollToTop'];

async function loadOptions() {
  const { options_v2: options = {} } = await chrome.storage.local.get('options_v2');
  const opts = { ...DEFAULT_OPTIONS, ...options };
  for (const f of fields) {
    const el = $(f);
    if (el.type === 'checkbox') el.checked = !!opts[f];
    else el.value = opts[f];
  }
}

async function saveOptions() {
  const options = {
    delay: Math.max(200, Number($('delay').value) || DEFAULT_OPTIONS.delay),
    maxShots: Math.max(0, Math.floor(Number($('maxShots').value) || 0)),
    overlap: Math.max(0, Number($('overlap').value) || 0),
    format: $('format').value,
    saveMode: $('saveMode').value,
    subfolder: $('subfolder').value.trim(),
    scrollToTop: $('scrollToTop').checked
  };
  await chrome.storage.local.set({ options_v2: options });
}

function render({ state = 'idle', message = '' }) {
  if (state === 'running') {
    btn.textContent = '停止并保存';
    btn.classList.add('stop');
    btn.disabled = false;
  } else if (state === 'stopping' || state === 'saving') {
    btn.textContent = state === 'stopping' ? '正在停止…' : '正在保存…';
    btn.disabled = true;
  } else {
    btn.textContent = '开始截图';
    btn.classList.remove('stop');
    btn.disabled = false;
  }
  statusEl.textContent = message;
}

async function refresh() {
  render(await chrome.storage.session.get(['state', 'message']));
}

btn.addEventListener('click', async () => {
  const { state = 'idle' } = await chrome.storage.session.get('state');
  if (state === 'running') {
    await chrome.runtime.sendMessage({ type: 'stop' });
    return;
  }
  await saveOptions();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || '') ||
      (tab.url || '').startsWith('https://chromewebstore.google.com')) {
    statusEl.textContent = '浏览器内置页面不允许截图，请在普通网页上使用。';
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'start', tabId: tab.id });
  if (!res?.ok) statusEl.textContent = `启动失败：${res?.error || '未知错误'}`;
});

for (const f of fields) $(f).addEventListener('change', saveOptions);

$('openSettings').addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'chrome://settings/downloads' });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session') refresh();
});

loadOptions();
refresh();
