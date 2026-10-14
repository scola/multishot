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

function localizeDOM() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.placeholder = msg;
  });
}

function render({ state = 'idle', message = '' }) {
  if (state === 'running') {
    btn.textContent = chrome.i18n.getMessage('btnStop');
    btn.classList.add('stop');
    btn.disabled = false;
  } else if (state === 'stopping') {
    btn.textContent = chrome.i18n.getMessage('btnStopping');
    btn.disabled = true;
  } else if (state === 'saving') {
    btn.textContent = chrome.i18n.getMessage('btnSaving');
    btn.disabled = true;
  } else {
    btn.textContent = chrome.i18n.getMessage('btnStart');
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
    statusEl.textContent = chrome.i18n.getMessage('statusRestrictedPage');
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'start', tabId: tab.id });
  if (!res?.ok) {
    statusEl.textContent = chrome.i18n.getMessage('statusStartFailed', [res?.error || 'Unknown']);
  }
});

for (const f of fields) $(f).addEventListener('change', saveOptions);

$('openSettings').addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'chrome://settings/downloads' });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session') refresh();
});

localizeDOM();
loadOptions();
refresh();
