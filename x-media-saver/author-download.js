(() => {
  "use strict";
  const { originalImage } = globalThis.XImageSaverCore;
  const RESERVED = new Set(["home", "explore", "notifications", "messages", "settings", "search", "i", "compose", "login", "logout", "signup", "tos", "privacy"]);
  function profile(pathname) {
    const match = pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/(media))?\/?$/);
    return match && !RESERVED.has(match[1].toLowerCase()) ? { author: match[1], media: Boolean(match[2]) } : null;
  }

  // The runner processes one post at a time so scrolling cannot flood downloads.
  async function run({ author, posts, save, advance, wait, current, update, signal, now = Date.now, stallMs = 30000 }) {
    const seen = new Set();
    const counts = { found: 0, saved: 0, skipped: 0, failed: 0 };
    let lastProgress = now(), lastPosition;
    const report = phase => update({ ...counts, phase });
    report("running");
    while (!signal.aborted) {
      if (!current()) { report("navigated"); return counts; }
      let progressed = false;
      for (const post of posts()) {
        if (signal.aborted || !current()) break;
        if (post.author?.toLowerCase() !== author.toLowerCase() || !/^\d{1,30}$/.test(post.postId) || !Array.isArray(post.images) || post.images.length > 20) continue;
        const images = [];
        for (const value of post.images) {
          try {
            const image = originalImage(value);
            if (seen.has(image.url)) continue;
            seen.add(image.url);
            images.push(image.url);
          } catch { /* Ignore page-supplied non-media URLs. */ }
        }
        if (!images.length) continue;
        progressed = true;
        counts.found += images.length;
        report("running");
        // Keep an in-flight post observable even after Stop; it may finish saving.
        const result = await save({ author, postId: post.postId, images, videos: [] });
        counts.saved += result.complete;
        counts.skipped += result.skipped;
        counts.failed += result.failed;
        report("running");
      }
      if (signal.aborted) break;
      if (!current()) { report("navigated"); return counts; }
      const position = advance();
      if (progressed || position !== lastPosition) lastProgress = now();
      lastPosition = position;
      if (now() - lastProgress >= stallMs) { report("stalled"); return counts; }
      await wait(signal);
    }
    report("stopped");
    return counts;
  }

  function mount({ send, readPost }) {
    const cache = new Map();
    let panel, startButton, stopButton, status, controller, running = false, lastAnnouncement = 0;
    const INTENT = "xis:author-download";
    const pause = signal => new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, 1200);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
    function renderProgress(state) {
      // Avoid flooding screen readers while duplicate-only posts finish quickly.
      if (state.phase === "running" && Date.now() - lastAnnouncement < 1000) return;
      lastAnnouncement = Date.now();
      const prefix = `发现 ${state.found} 张 · 保存 ${state.saved} · 跳过 ${state.skipped} · 失败 ${state.failed}`;
      const suffix = { running: "正在收集和下载…", stopping: "正在停止，等待当前帖下载完成…", stopped: "已停止，可再次开始补存。", navigated: "页面已切换，任务已停止。", stalled: "30 秒未加载新内容，已停止；无法确认全部历史已加载，可重试补存。" };
      status.textContent = `${prefix}\n${suffix[state.phase] || ""}`;
    }
    function getPosts() {
      const all = new Map(cache);
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        const post = readPost(article);
        if (post?.images.length && !all.has(post.postId)) all.set(post.postId, post);
      }
      return all.values();
    }
    async function save(post) {
      const started = await send({ type: "XIS_DOWNLOAD_POST", post });
      const deadline = Date.now() + 30 * 60 * 1000;
      while (true) {
        const result = await send({ type: "XIS_JOB_STATUS", jobId: started.jobId });
        if (!result.pending) return result;
        if (Date.now() > deadline) throw new Error("当前帖下载超时，任务已停止；请检查浏览器下载记录后重试。");
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    async function start() {
      if (running) return;
      const target = profile(location.pathname);
      if (!target) return;
      if (!target.media || new URLSearchParams(location.search).get("filter") !== "photo") {
        try { sessionStorage.setItem(INTENT, JSON.stringify({ author: target.author, expires: Date.now() + 30000 })); }
        catch { status.textContent = "请打开此作者的媒体页，再点击下载。"; return; }
        location.assign(`/${target.author}/media?filter=photo`);
        return;
      }
      running = true;
      controller = new AbortController();
      const focusStop = document.activeElement === startButton;
      startButton.disabled = true;
      stopButton.hidden = false;
      stopButton.disabled = false;
      if (focusStop) stopButton.focus();
      panel.querySelector("h2").textContent = `@${target.author} 的图片`;
      try {
        window.scrollTo({ top: 0, behavior: "instant" });
        await run({
          author: target.author, posts: getPosts, save, signal: controller.signal, wait: pause,
          current: () => {
            const route = profile(location.pathname);
            return route?.media && route.author.toLowerCase() === target.author.toLowerCase() && new URLSearchParams(location.search).get("filter") === "photo";
          },
          advance: () => {
            const primary = document.querySelector('[data-testid="primaryColumn"]') || document;
            const error = primary.querySelector('[data-testid="error-detail"]');
            if (error && error.getClientRects().length) throw new Error(`X 加载失败，已停止：${error.textContent}`);
            const position = `${window.scrollY}:${document.documentElement.scrollHeight}`;
            window.scrollBy({ top: Math.max(400, window.innerHeight * 0.8), behavior: "instant" });
            return position;
          },
          update: state => renderProgress({ ...state, phase: controller.signal.aborted && state.phase === "running" ? "stopping" : state.phase })
        });
      } catch (error) {
        status.textContent += `\n任务已停止：${error.message || "下载失败，请刷新页面后重试。"}`;
      } finally {
        running = false;
        startButton.disabled = false;
        startButton.textContent = "再次收集并补存";
        if (document.activeElement === stopButton) startButton.focus();
        stopButton.hidden = true;
        sync();
      }
    }
    function sync() {
      const target = profile(location.pathname);
      // A profile header avoids presenting a download action on /help-like routes.
      const isProfile = target && (document.querySelector('[data-testid="UserName"], [data-testid="UserProfileHeader_Items"]') || document.querySelector(`a[href="/${target.author}/media"]`));
      if (!panel && isProfile) {
        panel = document.createElement("aside");
        panel.id = "xis-author-download";
        panel.lang = "zh-CN";
        panel.setAttribute("aria-labelledby", "xis-author-title");
        const title = document.createElement("h2");
        title.id = "xis-author-title";
        status = document.createElement("p");
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        status.textContent = "自动滚动媒体页，保存此作者可访问的原图，已存图片自动跳过。请保持本页打开。";
        startButton = document.createElement("button");
        startButton.type = "button";
        startButton.textContent = "下载此作者图片";
        startButton.addEventListener("click", () => { void start(); });
        stopButton = document.createElement("button");
        stopButton.type = "button";
        stopButton.textContent = "停止";
        stopButton.hidden = true;
        stopButton.addEventListener("click", () => {
          controller?.abort();
          stopButton.disabled = true;
          status.textContent += "\n正在停止，当前帖已开始的下载会继续完成。";
        });
        panel.append(title, status, startButton, stopButton);
        document.body.append(panel);
      }
      if (!panel) return;
      panel.hidden = !isProfile && !running;
      if (!running && target) {
        const label = `@${target.author} 的图片`;
        if (panel.querySelector("h2").textContent !== label) {
          panel.querySelector("h2").textContent = label;
          status.textContent = "自动滚动媒体页，保存此作者可访问的原图，已存图片自动跳过。请保持本页打开。";
          startButton.textContent = "下载此作者图片";
        }
      }
      if (isProfile && target.media && new URLSearchParams(location.search).get("filter") === "photo" && !running) {
        try {
          const intent = JSON.parse(sessionStorage.getItem(INTENT) || "null");
          if (intent) sessionStorage.removeItem(INTENT);
          if (intent?.expires > Date.now() && intent.author.toLowerCase() === target.author.toLowerCase()) void start();
        } catch { /* No pending click to resume. */ }
      }
    }
    window.addEventListener("message", event => {
      if (event.source !== window || event.origin !== location.origin || event.data?.type !== "XIS_PHOTO_DATA" || !Array.isArray(event.data.items)) return;
      for (const post of event.data.items.slice(0, 500)) {
        if (typeof post?.author === "string" && /^[A-Za-z0-9_]{1,15}$/.test(post.author) && /^\d{1,30}$/.test(post.postId) && Array.isArray(post.images) && post.images.length <= 20) cache.set(post.postId, post);
      }
      while (cache.size > 500) cache.delete(cache.keys().next().value);
    });
    let scheduled = false;
    new MutationObserver(records => {
      if (records.every(record => panel?.contains(record.target) || record.target === panel)) return;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; sync(); });
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", sync);
    sync();
  }
  globalThis.XImageSaverAuthor = Object.freeze({ profile, run, mount });
})();
