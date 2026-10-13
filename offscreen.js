// 离屏文档：Service Worker 中无法使用 URL.createObjectURL，
// 因此在这里把截图转成 Blob URL，或者打包成一个 ZIP（仅存储，不压缩——PNG/JPEG 本身已压缩）。
// 注意：离屏文档里只能用 chrome.runtime 消息，下载由 Service Worker 完成。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function dataUrlToBytes(dataUrl) {
  const res = await fetch(dataUrl);
  return new Uint8Array(await res.arrayBuffer());
}

let zipEntries = [];

function buildZip(entries) {
  const enc = new TextEncoder();
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, data, crc } of entries) {
    const nameBytes = enc.encode(name);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);   // 本地文件头签名
    lh.setUint16(4, 20, true);           // 解压所需版本
    lh.setUint16(6, 0x0800, true);       // 标志：文件名为 UTF-8
    lh.setUint16(8, 0, true);            // 压缩方式：存储
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); // 压缩后大小
    lh.setUint32(22, data.length, true); // 原始大小
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, nameBytes, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);   // 中央目录签名
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint16(30, 0, true);
    ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true);
    ch.setUint16(36, 0, true);
    ch.setUint32(38, 0, true);
    ch.setUint32(42, offset, true);      // 本地文件头偏移
    central.push(ch.buffer, nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);

  return new Blob([...parts, ...central, eocd.buffer], { type: 'application/zip' });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  (async () => {
    try {
      switch (msg.type) {
        case 'blob-url': {
          const blob = await (await fetch(msg.dataUrl)).blob();
          sendResponse({ ok: true, url: URL.createObjectURL(blob) });
          break;
        }
        case 'zip-reset':
          zipEntries = [];
          sendResponse({ ok: true });
          break;
        case 'zip-add': {
          const data = await dataUrlToBytes(msg.dataUrl);
          zipEntries.push({ name: msg.name, data, crc: crc32(data) });
          sendResponse({ ok: true });
          break;
        }
        case 'zip-finish': {
          const blob = buildZip(zipEntries);
          zipEntries = [];
          sendResponse({ ok: true, url: URL.createObjectURL(blob), size: blob.size });
          break;
        }
        default:
          sendResponse({ ok: false, error: `未知消息：${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true;
});
