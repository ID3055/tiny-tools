import "./core.js";

const { createDownloads, originalImage, originalVideo, normalizeFolder } = globalThis.XImageSaverCore;
const ALLOWED_ORIGINS = new Set(["https://x.com", "https://www.x.com", "https://twitter.com", "https://www.twitter.com"]);
const locks = new Map();
const activeJobs = new Set();
const OFFSCREEN = "xis-offscreen";
let creatingOffscreen;

async function withLock(key, operation) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  locks.set(key, current);
  await previous;
  try { return await operation(); }
  finally { release(); if (locks.get(key) === current) locks.delete(key); }
}

async function offscreen(message) {
  return chrome.runtime.sendMessage({ ...message, target: OFFSCREEN });
}

async function ensureOffscreen() {
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL("offscreen.html")] });
    if (!contexts.length) await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["BLOBS"], justification: "计算媒体文件的 SHA-256，并保存已读取的文件，避免重复请求。" });
  })();
  try { await creatingOffscreen; } finally { creatingOffscreen = undefined; }
}

function mediaKeys(item) {
  const scope = item.filename.slice(0, item.filename.lastIndexOf("/"));
  const media = item.url.startsWith("https://pbs.twimg.com/") ? originalImage(item.url) : originalVideo(item.url);
  return { scope, urlKey: `xis:url:${JSON.stringify([scope, media.key, media.extension])}` };
}

// Only confirmed completion is durable. Pending associations survive worker restarts.
async function remember(keys, record) {
  await withLock("history", async () => {
    const values = await chrome.storage.local.get(keys);
    const updates = {};
    for (const key of keys) {
      // A failed forced replacement must never erase a previous successful save.
      if (record.completedAt || !values[key]?.completedAt) updates[key] = record;
    }
    if (!record.completedAt) {
      const pendingKey = `xis:pending:${record.id}`;
      const pending = (await chrome.storage.local.get(pendingKey))[pendingKey];
      updates[pendingKey] = { record, keys: [...new Set([...(pending?.keys || []), ...keys])] };
    }
    await chrome.storage.local.set(updates);
  });
}

async function settleDownload(id, state) {
  if (!["complete", "interrupted"].includes(state)) return;
  await withLock("history", async () => {
    const pendingKey = `xis:pending:${id}`;
    const pending = (await chrome.storage.local.get(pendingKey))[pendingKey];
    if (!pending) return;
    const values = await chrome.storage.local.get(pending.keys);
    const updates = {}, removals = [pendingKey];
    for (const key of pending.keys) {
      const current = values[key];
      if (state === "complete") {
        // Never let an older completion replace a newer successful download.
        if (!current?.completedAt || current.id <= id) updates[key] = { ...pending.record, completedAt: Date.now() };
      } else if (current?.id === id && !current.completedAt) removals.push(key);
    }
    await chrome.storage.local.set(updates);
    await chrome.storage.local.remove(removals);
  });
}

async function existingRecord(key) {
  const record = (await chrome.storage.local.get(key))[key];
  if (!record || !Number.isSafeInteger(record.id)) return null;
  if (record.completedAt) return { ...record, state: "complete" };
  const [item] = await chrome.downloads.search({ id: record.id });
  if (item?.state === "in_progress") return { ...record, state: "in_progress" };
  if (item?.state === "complete") {
    const confirmed = { ...record, completedAt: Date.now(), filename: record.filename || item.filename };
    await remember([key], confirmed);
    await settleDownload(record.id, "complete");
    return { ...confirmed, state: "complete" };
  }
  // Interrupted/unknown attempts do not count as downloaded history.
  await withLock("history", async () => {
    const current = (await chrome.storage.local.get(key))[key];
    if (current?.id === record.id && !current.completedAt) await chrome.storage.local.remove(key);
  });
  return null;
}

async function legacyImage(item, scope) {
  if (!item.url.startsWith("https://pbs.twimg.com/")) return null;
  const media = originalImage(item.url);
  const urlRegex = `^https://pbs\\.twimg\\.com/media/${media.key}(?:[.?]|$)`;
  const records = await chrome.downloads.search({ urlRegex });
  const legacyScope = scope.slice(0, -"/图片".length);
  return records.find(record => {
    if (record.byExtensionId !== chrome.runtime.id || record.state !== "complete") return false;
    const path = record.filename?.replace(/\\/g, "/") || "";
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (!parent.endsWith(`/${scope}`) && !parent.endsWith(`/${legacyScope}`)) return false;
    try { return new URL(record.url).searchParams.get("name") === "orig"; } catch { return false; }
  }) || null;
}

async function saveMedia(item, force, forcedHashes) {
  const { scope, urlKey } = mediaKeys(item);
  return withLock(urlKey, async () => {
    const cached = (await chrome.storage.local.get(urlKey))[urlKey];
    const knownHash = /^[a-f0-9]{64}$/.test(cached?.hash) ? cached.hash : null;
    if (!force) {
      const previous = await existingRecord(urlKey)
        || knownHash && await existingRecord(`xis:sha256:${JSON.stringify([scope, knownHash])}`)
        || await legacyImage(item, scope);
      if (previous) {
        const record = { id: previous.id, hash: knownHash || previous.hash, filename: previous.filename, ...(previous.state === "complete" ? { completedAt: previous.completedAt || Date.now() } : {}) };
        await remember([urlKey], record);
        return { id: previous.id, skipped: previous.state === "complete" };
      }
    }
    await ensureOffscreen();
    const prepared = await offscreen({ type: "XIS_PREPARE_MEDIA", url: item.url });
    if (!prepared?.ok) throw new Error(prepared?.error || "媒体校验失败。");
    if (!/^[a-f0-9]{64}$/.test(prepared.hash) || !prepared.blobUrl?.startsWith(`blob:${chrome.runtime.getURL("")}`)) throw new Error("媒体校验结果无效。");
    let downloading = false;
    try {
      const hashKey = `xis:sha256:${JSON.stringify([scope, prepared.hash])}`;
      return await withLock(hashKey, async () => {
        const identical = force ? forcedHashes.get(hashKey) : await existingRecord(hashKey);
        if (identical) {
          await remember([urlKey], { id: identical.id, hash: prepared.hash, filename: identical.filename, ...(identical.completedAt ? { completedAt: identical.completedAt } : {}) });
          // An alias can be added after a fast download has already completed.
          const [current] = await chrome.downloads.search({ id: identical.id });
          await settleDownload(identical.id, current?.state);
          return { id: identical.id, skipped: identical.state === "complete" };
        }
        const id = await chrome.downloads.download({ ...item, url: prepared.blobUrl });
        downloading = true;
        const record = { id, hash: prepared.hash, filename: item.filename, url: item.url };
        await remember([urlKey, hashKey], record);
        if (force) forcedHashes.set(hashKey, record);
        await offscreen({ type: "XIS_TRACK_BLOB", blobUrl: prepared.blobUrl, id });
        const [current] = await chrome.downloads.search({ id });
        await settleDownload(id, current?.state);
        if (current?.state !== "in_progress") await offscreen({ type: "XIS_RELEASE_DOWNLOAD", id });
        return { id, skipped: false };
      });
    } finally {
      if (!downloading) await offscreen({ type: "XIS_RELEASE_BLOB", blobUrl: prepared.blobUrl }).catch(() => {});
    }
  });
}

async function runJob(jobId, downloads, job, force) {
  const forcedHashes = new Map();
  activeJobs.add(jobId);
  try {
    for (const item of downloads) {
      job.current = { index: job.processed + 1, total: job.total, filename: item.filename };
      await chrome.storage.session.set({ [jobId]: { ...job, ids: [...job.ids] } });
      try {
        const result = await saveMedia(item, force, forcedHashes);
        if (result.skipped || job.ids.includes(result.id)) job.skipped++;
        else job.ids.push(result.id);
      } catch (error) {
        job.failed++;
        job.error = `${item.filename.split("/").pop()}：${error.message || "媒体保存失败。"}`;
      }
      job.processed++;
      await chrome.storage.session.set({ [jobId]: { ...job, ids: [...job.ids] } });
    }
  } catch (error) {
    job.error = `后台任务失败：${error.message || "原因未知"}`;
    job.failed += job.total - job.processed;
    job.processed = job.total;
  } finally {
    job.runComplete = true;
    await chrome.storage.session.set({ [jobId]: job });
    activeJobs.delete(jobId);
  }
}

async function handleMessage(message, sender) {
  let origin;
  try { origin = new URL(sender.url).origin; } catch { return { ok: false, error: "页面来源无效。" }; }
  if (!ALLOWED_ORIGINS.has(origin) || !sender.tab) return { ok: false, error: "只支持 X 页面。" };
  if (message?.type === "XIS_AUTHOR_HISTORY") {
    if (typeof message.author !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(message.author)) throw new Error("作者信息无效。");
    if (message.mediaType !== undefined && !["image", "video"].includes(message.mediaType)) throw new Error("媒体类型无效。");
    const kind = message.mediaType === "video" ? "视频" : "图片";
    const records = await chrome.storage.local.get(null);
    const root = normalizeFolder(records.rootFolder || "");
    const prefix = root ? `${root}/` : "";
    const files = new Set(), posts = new Set();
    for (const [key, record] of Object.entries(records)) {
      if (!key.startsWith("xis:url:") || !Number.isSafeInteger(record?.id) || !(record.completedAt > 0)) continue;
      let scope;
      try { [scope] = JSON.parse(key.slice("xis:url:".length)); } catch { continue; }
      if (typeof scope !== "string" || !scope.startsWith(prefix)) continue;
      const parts = scope.slice(prefix.length).split("/");
      if (parts.length !== 2 || parts[0].toLowerCase() !== message.author.toLowerCase() || parts[1] !== kind) continue;
      // URL aliases and content-hash records can refer to the same saved file.
      files.add(record.id);
      const filename = record.filename?.replace(/\\/g, "/").split("/").pop();
      const match = filename?.match(/(?:^|_)(\d{1,30})_\d+\.[^.]+$/);
      if (match) posts.add(match[1]);
    }
    return { ok: true, posts: posts.size, [kind === "视频" ? "videos" : "images"]: files.size };
  }
  if (["XIS_PHOTO_HISTORY", "XIS_VIDEO_HISTORY"].includes(message?.type)) {
    const video = message.type === "XIS_VIDEO_HISTORY";
    if (!Array.isArray(message.posts) || !message.posts.length || message.posts.length > 100) throw new Error("每批仅支持查询 1–100 条媒体帖子。");
    const { rootFolder = "" } = await chrome.storage.local.get("rootFolder");
    const groups = message.posts.map(post => {
      if (video ? post.images?.length || !post.videos?.length : post.videos?.length) throw new Error("快速定位的媒体类型不匹配。");
      return createDownloads(post, rootFolder).map(item => mediaKeys(item).urlKey);
    });
    // Read a whole page of durable URL records at once, without creating jobs,
    // fetching media, hashing bytes, or scanning Chrome's download history.
    const records = await chrome.storage.local.get([...new Set(groups.flat())]);
    return { ok: true, items: groups.map((keys, index) => ({
      postId: message.posts[index].postId, total: keys.length,
      saved: keys.filter(key => Number.isSafeInteger(records[key]?.id) && records[key].completedAt > 0).length
    })) };
  }
  if (message?.type === "XIS_DOWNLOAD_POST") {
    const { rootFolder = "" } = await chrome.storage.local.get("rootFolder");
    const downloads = createDownloads(message.post, rootFolder);
    const jobId = `xis:job:${crypto.randomUUID()}`;
    const job = { ids: [], skipped: 0, failed: 0, processed: 0, total: downloads.length, runComplete: false, error: null, tabId: sender.tab.id };
    await chrome.storage.session.set({ [jobId]: job });
    void runJob(jobId, downloads, job, message.force === true).catch(error => {
      console.error("X 图片收藏：后台任务失败", error);
      activeJobs.delete(jobId);
    });
    return { ok: true, jobId, total: downloads.length };
  }
  if (message?.type === "XIS_POST_STATUS") {
    const { rootFolder = "" } = await chrome.storage.local.get("rootFolder");
    const downloads = createDownloads(message.post, rootFolder);
    const records = await Promise.all(downloads.map(item => existingRecord(mediaKeys(item).urlKey)));
    return { ok: true, total: downloads.length, saved: records.filter(record => record?.state === "complete").length };
  }
  if (message?.type === "XIS_JOB_STATUS") {
    if (typeof message.jobId !== "string" || !/^xis:job:[a-f0-9-]{36}$/.test(message.jobId)) throw new Error("下载任务无效。");
    const { [message.jobId]: job } = await chrome.storage.session.get(message.jobId);
    if (!job || job.tabId !== sender.tab.id) throw new Error("下载任务不存在，请重试。");
    if (!job.runComplete && !activeJobs.has(message.jobId)) throw new Error("后台已重启，请重试；已保存的文件会自动跳过。");
    const records = await Promise.all(job.ids.map(id => chrome.downloads.search({ id })));
    await Promise.all(records.map(([item]) => item && settleDownload(item.id, item.state)));
    const states = records.map(([item]) => item?.state || "interrupted");
    const interrupted = records.find(([item]) => !item || item.state === "interrupted");
    const reasons = {
      NETWORK_FAILED: "网络连接失败", NETWORK_TIMEOUT: "网络连接超时", NETWORK_DISCONNECTED: "网络已断开",
      SERVER_FORBIDDEN: "服务器拒绝访问", SERVER_UNAUTHORIZED: "需要重新登录", SERVER_BAD_CONTENT: "服务器返回的文件无效",
      FILE_ACCESS_DENIED: "没有文件写入权限", FILE_NO_SPACE: "磁盘空间不足", FILE_NAME_TOO_LONG: "文件名过长",
      FILE_BLOCKED: "文件被浏览器或系统阻止", USER_CANCELED: "下载被取消", USER_SHUTDOWN: "浏览器已关闭"
    };
    const item = interrupted?.[0];
    const interruption = interrupted ? `${item?.filename?.split(/[\\/]/).pop() || "文件"}：${item ? `${reasons[item.error] || "浏览器中断下载"}（${item.error || "原因未知"}）` : "下载记录已丢失，无法确认保存结果"}。` : null;
    const remaining = job.total - job.processed + states.filter(state => state === "in_progress").length;
    const pending = job.runComplete ? remaining : Math.max(1, remaining);
    const result = { ok: true, total: job.total, skipped: job.skipped, complete: states.filter(state => state === "complete").length, failed: job.failed + states.filter(state => state === "interrupted").length, pending, error: [job.error, interruption].filter(Boolean).join("\n") || null, current: job.current };
    if (!pending && job.runComplete) await chrome.storage.session.remove(message.jobId);
    return result;
  }
  return { ok: false, error: "不支持的操作。" };
}

chrome.downloads.onChanged.addListener(delta => {
  if (["complete", "interrupted"].includes(delta.state?.current)) {
    void settleDownload(delta.id, delta.state.current).catch(() => {});
    void offscreen({ type: "XIS_RELEASE_DOWNLOAD", id: delta.id }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === OFFSCREEN) return;
  if (message?.type === "XIS_KEEPALIVE" && sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("offscreen.html")) {
    sendResponse({ ok: true });
    return;
  }
  if (!message?.type?.startsWith("XIS_")) return;
  handleMessage(message, sender).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message || "保存失败，请重试。" }));
  return true;
});
