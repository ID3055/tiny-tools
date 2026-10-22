(() => {
  "use strict";
  const { extractVideos, extractPhotoPosts } = globalThis.XImageSaverVideoData;
  const cache = new Map();
  const photos = new Map();
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
  }
  function isTimeline(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin && (url.pathname.startsWith("/i/api/graphql/") || url.pathname.startsWith("/i/api/2/timeline/"));
    } catch { return false; }
  }
  // Only the author's media timeline can stop an author download. Unrelated
  // sidebar, notification and analytics failures must not interrupt it.
  function mediaRequest(value) {
    if (!isTimeline(value)) return null;
    const url = new URL(value, location.href);
    if (!/\/UserMedia(?:V\d+)?$/.test(url.pathname)) return null;
    return { path: location.pathname };
  }
  function reportTimeline(request, status, data) {
    if (!request) return;
    const apiError = Array.isArray(data?.errors) && data.errors[0];
    let error;
    if (status === 429 || apiError?.code === 88) error = "X 请求过于频繁，已限流（HTTP 429）。请稍后从当前位置继续。";
    else if (status === 401 || status === 403 || [32, 89, 215].includes(apiError?.code)) error = `X 拒绝访问（HTTP ${status}）。请检查登录状态或账号访问权限。`;
    else if (status === 0) error = "X 图片列表请求失败：网络连接中断或请求超时。请检查网络后继续。";
    else if (status >= 400) error = `X 图片列表加载失败（HTTP ${status}）。请稍后继续。`;
    else if (apiError) error = `X 图片列表返回错误（${apiError.code || "未知代码"}）：${String(apiError.message || "加载失败").slice(0, 200)}`;
    window.postMessage({ type: "XIS_TIMELINE_STATUS", path: request.path, error: error || null }, location.origin);
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = Reflect.apply(originalFetch, this, args);
    const request = args[0];
    const value = typeof request === "string" || request instanceof URL ? request : request?.url;
    const media = mediaRequest(value);
    if (isTimeline(value)) {
      promise.then(async response => {
        if (!response.ok) { reportTimeline(media, response.status); return; }
        try {
          const data = await response.clone().json();
          reportTimeline(media, response.status, data);
          receive(data);
        } catch { /* Ignore non-JSON responses. */ }
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
        if (this.status < 200 || this.status >= 300) { reportTimeline(mediaRequests.get(this), this.status); return; }
        try {
          const data = this.responseType === "json" ? this.response : !this.responseType || this.responseType === "text" ? JSON.parse(this.responseText) : undefined;
          reportTimeline(mediaRequests.get(this), this.status, data);
          if (data) receive(data);
        } catch { /* Non-JSON responses do not contain video variants. */ }
      });
      for (const type of ["error", "timeout"]) this.addEventListener(type, () => reportTimeline(mediaRequests.get(this), 0));
    }
    return Reflect.apply(originalOpen, this, [method, url, ...args]);
  };
  window.addEventListener("message", event => {
    if (event.source === window && event.origin === location.origin && event.data?.type === "XIS_REQUEST_VIDEO_CACHE") {
      publish([...cache.values()]);
      if (photos.size) window.postMessage({ type: "XIS_PHOTO_DATA", items: [...photos.values()] }, location.origin);
    }
  });
})();
