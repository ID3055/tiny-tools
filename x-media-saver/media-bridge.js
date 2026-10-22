(() => {
  "use strict";
  const { extractVideos, extractPhotoPosts, extractVideoPosts } = globalThis.XImageSaverVideoData;
  const cache = new Map();
  const photos = new Map();
  const videos = new Map();
  const publish = items => window.postMessage({ type: "XIS_VIDEO_DATA", items }, location.origin);
  function receive(data) {
    const items = extractVideos(data);
    for (const item of items) cache.set(item.postId, item);
    while (cache.size > 500) cache.delete(cache.keys().next().value);
    if (items.length) publish(items);
    const posts = extractPhotoPosts(data);
    for (const post of posts) photos.set(post.postId, post);
    while (photos.size > 500) photos.delete(photos.keys().next().value);
    if (posts.length) window.postMessage({ type: "XIS_PHOTO_DATA", items: posts }, location.origin);
    const videoPosts = extractVideoPosts(data);
    for (const post of videoPosts) videos.set(post.postId, post);
    while (videos.size > 500) videos.delete(videos.keys().next().value);
    if (videoPosts.length) window.postMessage({ type: "XIS_AUTHOR_VIDEO_DATA", items: videoPosts }, location.origin);
  }
  function isTimeline(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin && (url.pathname.startsWith("/i/api/graphql/") || url.pathname.startsWith("/i/api/2/timeline/"));
    } catch { return false; }
  }
  // Only the author's media timeline can stop an author download. Unrelated
  // sidebar, notification and analytics failures must not interrupt it.
  let requestId = 0;
  const timelines = new Map();
  const timelineKey = request => request.path + request.search;
  const publishTimeline = ({ cursor, ...state }) => window.postMessage({ type: "XIS_TIMELINE_STATUS", ...state }, location.origin);
  function mediaRequest(value) {
    if (!isTimeline(value)) return null;
    const url = new URL(value, location.href);
    const endpoint = url.pathname.split("/").at(-1);
    if (!/^(?:UserMedia|UserPhotoTimeline|UserVideoTimeline)(?:V\d+)?$/.test(endpoint)) return null;
    const filter = new URL(location.href).searchParams.get("filter");
    if (/^UserPhotoTimeline/.test(endpoint) && filter !== "photo" || /^UserVideoTimeline/.test(endpoint) && filter === "photo") return null;
    let cursor;
    try { cursor = JSON.parse(url.searchParams.get("variables"))?.cursor; } catch { /* A malformed query cannot establish a terminal cursor. */ }
    const request = { cursor: typeof cursor === "string" && cursor.length <= 4096 ? cursor : undefined, path: location.pathname, search: location.search || "", requestId: ++requestId, requestedAt: Date.now() };
    const key = timelineKey(request), previous = timelines.get(key);
    timelines.set(key, { ...request, reason: "loading", ended: false, exhausted: false, error: null, observedAt: Date.now() });
    while (timelines.size > 8) timelines.delete(timelines.keys().next().value);
    // A new page request invalidates a previously observed terminal response.
    if (previous?.ended || previous?.exhausted) publishTimeline(timelines.get(key));
    return request;
  }
  function retryTime(header) {
    const now = Date.now(), after = header("retry-after"), reset = Number(header("x-rate-limit-reset")) * 1000;
    const delay = after ? /^\d+(?:\.\d+)?$/.test(after) ? now + Number(after) * 1000 : Date.parse(after) : 0;
    const times = [delay, reset].filter(value => Number.isFinite(value) && value > now);
    return times.length ? Math.max(...times) : undefined;
  }
  function timelineInstructions(data) {
    const user = data?.data?.user?.result;
    return user?.timeline_v2?.timeline?.instructions || user?.timeline?.timeline?.instructions || user?.timeline?.instructions;
  }
  function timelineEnded(data) {
    const instructions = timelineInstructions(data);
    // Empty pages and unchanged cursors can also be transient X failures.
    // Only the author's explicit bottom termination is evidence of the end.
    return Array.isArray(instructions) && instructions.some(item => item?.type === "TimelineTerminateTimeline" && item.direction === "Bottom");
  }
  function paginationExhausted(request, data) {
    if (!request.cursor) return false;
    const instructions = timelineInstructions(data);
    // Observed on X's photo endpoint: HTTP 200, only top/bottom cursors,
    // with the bottom equal to the requested cursor. This ends this pagination
    // attempt, without claiming the account's entire history is accessible.
    if (!Array.isArray(instructions) || !instructions.length || !instructions.every(item => item?.type === "TimelineAddEntries" && Array.isArray(item.entries) && item.entries.every(entry => entry?.content?.entryType === "TimelineTimelineCursor"))) return false;
    return instructions.some(item => item.entries.some(entry => entry.content.cursorType === "Bottom" && entry.content.value === request.cursor));
  }
  function reportTimeline(request, status, data, header = () => null, invalidJSON = false) {
    if (!request) return;
    const errors = Array.isArray(data?.errors) ? data.errors : [];
    const rate = errors.find(error => Number(error?.code) === 88 || error?.extensions?.code === "RATE_LIMIT_EXCEEDED");
    const denied = errors.find(error => [32, 64, 89, 215, 239, 326].includes(Number(error?.code)));
    const apiError = rate || denied || errors[0];
    const evidence = `HTTP ${status}${apiError?.code != null ? ` / API ${apiError.code}` : ""}`;
    let error, reason = "ok";
    if (status === 429 || rate) { reason = "rate-limit"; error = `X 媒体列表已限流（${evidence}）。请稍后从当前位置继续。`; }
    else if (status === 401 || status === 403 || denied) { reason = "access"; error = `X 拒绝访问媒体列表（${evidence}）。请检查登录状态或账号访问权限。`; }
    else if (status === 0) { reason = "network"; error = "X 媒体列表请求失败：网络连接中断或请求超时。请检查网络后继续。"; }
    else if (status >= 400) { reason = "http"; error = `X 媒体列表加载失败（${evidence}）。请稍后继续。`; }
    else if (apiError) { reason = "api"; error = `X 媒体列表返回错误（${evidence}）：${String(apiError.message || "加载失败").slice(0, 200)}`; }
    else if (invalidJSON) { reason = "response"; error = `X 媒体列表返回了无法解析的数据（${evidence}）。请检查页面后继续。`; }
    const retryAt = error ? retryTime(header) : undefined;
    const state = { ...request, status, reason, error: error || null, ended: !error && timelineEnded(data), exhausted: !error && paginationExhausted(request, data), ...(retryAt ? { retryAt } : {}), observedAt: Date.now() };
    const stale = timelines.get(timelineKey(request))?.requestId > request.requestId;
    if (stale && !error) return;
    if (!stale) timelines.set(timelineKey(request), state);
    // Concurrent failures remain evidence even if a newer request is pending.
    publishTimeline(state);
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = Reflect.apply(originalFetch, this, args);
    const request = args[0];
    const value = typeof request === "string" || request instanceof URL ? request : request?.url;
    const media = mediaRequest(value);
    if (isTimeline(value)) {
      promise.then(async response => {
        const header = name => response.headers?.get(name);
        let data;
        try { data = await response.clone().json(); }
        catch { reportTimeline(media, response.status, undefined, header, true); return; }
        reportTimeline(media, response.status, data, header);
        if (response.ok) receive(data);
      }).catch(() => reportTimeline(media, 0));
    }
    return promise;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const observed = new WeakSet();
  const urls = new WeakMap();
  const mediaRequests = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    urls.set(this, url);
    mediaRequests.set(this, mediaRequest(url));
    if (!observed.has(this)) {
      observed.add(this);
      this.addEventListener("load", () => {
        if (!isTimeline(urls.get(this))) return;
        const request = mediaRequests.get(this), header = name => this.getResponseHeader?.(name);
        let data;
        try {
          data = this.responseType === "json" ? this.response : !this.responseType || this.responseType === "text" ? JSON.parse(this.responseText) : undefined;
        } catch { reportTimeline(request, this.status, undefined, header, true); return; }
        reportTimeline(request, this.status, data, header, !data);
        if (this.status >= 200 && this.status < 300 && data) receive(data);
      });
      for (const type of ["error", "timeout"]) this.addEventListener(type, () => reportTimeline(mediaRequests.get(this), 0));
    }
    return Reflect.apply(originalOpen, this, [method, url, ...args]);
  };
  window.addEventListener("message", event => {
    if (event.source === window && event.origin === location.origin && event.data?.type === "XIS_REQUEST_VIDEO_CACHE") {
      publish([...cache.values()]);
      if (photos.size) window.postMessage({ type: "XIS_PHOTO_DATA", items: [...photos.values()] }, location.origin);
      if (videos.size) window.postMessage({ type: "XIS_AUTHOR_VIDEO_DATA", items: [...videos.values()] }, location.origin);
      const state = timelines.get(location.pathname + (location.search || ""));
      if (state) publishTimeline(state);
    }
  });
})();
