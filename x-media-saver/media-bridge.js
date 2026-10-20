(() => {
  "use strict";
  const { extractVideos } = globalThis.XImageSaverVideoData;
  const cache = new Map();
  const publish = items => window.postMessage({ type: "XIS_VIDEO_DATA", items }, location.origin);
  function receive(data) {
    const items = extractVideos(data);
    for (const item of items) cache.set(item.postId, item);
    while (cache.size > 500) cache.delete(cache.keys().next().value);
    if (items.length) publish(items);
  }
  function isTimeline(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin && (url.pathname.startsWith("/i/api/graphql/") || url.pathname.startsWith("/i/api/2/timeline/"));
    } catch { return false; }
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = Reflect.apply(originalFetch, this, args);
    const request = args[0];
    if (isTimeline(typeof request === "string" || request instanceof URL ? request : request?.url)) {
      promise.then(response => { if (response.ok) response.clone().json().then(receive).catch(() => {}); }).catch(() => {});
    }
    return promise;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const observed = new WeakSet();
  const urls = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    urls.set(this, url);
    if (!observed.has(this)) {
      observed.add(this);
      this.addEventListener("load", () => {
        if (!isTimeline(urls.get(this)) || this.status < 200 || this.status >= 300) return;
        try {
          if (this.responseType === "json") receive(this.response);
          else if (!this.responseType || this.responseType === "text") receive(JSON.parse(this.responseText));
        } catch { /* Non-JSON responses do not contain video variants. */ }
      });
    }
    return Reflect.apply(originalOpen, this, [method, url, ...args]);
  };
  window.addEventListener("message", event => {
    if (event.source === window && event.origin === location.origin && event.data?.type === "XIS_REQUEST_VIDEO_CACHE") publish([...cache.values()]);
  });
})();
