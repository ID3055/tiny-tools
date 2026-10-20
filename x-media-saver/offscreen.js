import { hashBlob } from "./hash.js";

const { originalImage, originalVideo } = globalThis.XImageSaverCore;
const blobs = new Map();

function release(url) {
  const entry = blobs.get(url);
  if (!entry) return;
  clearTimeout(entry.timer);
  URL.revokeObjectURL(url);
  blobs.delete(url);
}

async function prepare(source) {
  const isVideo = source.startsWith("https://video.twimg.com/");
  const { url } = isVideo ? originalVideo(source) : originalImage(source);
  const heartbeat = setInterval(() => chrome.runtime.sendMessage({ type: "XIS_KEEPALIVE" }).catch(() => {}), 20_000);
  try {
    const response = await fetch(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(240_000) });
    if (!response.ok) throw new Error(`媒体读取失败（HTTP ${response.status}）。`);
    const blob = await response.blob();
    if (!blob.size || blob.type && !blob.type.startsWith(isVideo ? "video/" : "image/") && blob.type !== "application/octet-stream") {
      throw new Error("媒体返回的内容无效。");
    }
    const hash = await hashBlob(blob);
    const blobUrl = URL.createObjectURL(blob);
    // Recover orphaned preparations if the service worker exits before registering a download.
    const timer = setTimeout(() => release(blobUrl), 5 * 60_000);
    blobs.set(blobUrl, { downloadId: null, timer });
    return { ok: true, hash, blobUrl };
  } finally {
    clearInterval(heartbeat);
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "xis-offscreen" || sender.id !== chrome.runtime.id || sender.tab) return;
  if (message.type === "XIS_PREPARE_MEDIA") {
    prepare(message.url).then(respond).catch(error => respond({ ok: false, error: error.message || "媒体读取失败。" }));
    return true;
  }
  if (message.type === "XIS_TRACK_BLOB") {
    const entry = blobs.get(message.blobUrl);
    if (entry) { clearTimeout(entry.timer); entry.downloadId = message.id; }
  } else if (message.type === "XIS_RELEASE_BLOB") {
    release(message.blobUrl);
  } else if (message.type === "XIS_RELEASE_DOWNLOAD") {
    for (const [url, entry] of blobs) if (entry.downloadId === message.id) release(url);
  }
  respond({ ok: true });
});
