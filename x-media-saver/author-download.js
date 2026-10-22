(() => {
  "use strict";
  const { originalImage } = globalThis.XImageSaverCore;
  const RESERVED = new Set(["home", "explore", "notifications", "messages", "settings", "search", "i", "compose", "login", "logout", "signup", "tos", "privacy"]);
  function profile(pathname) {
    const match = pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/(media))?\/?$/);
    return match && !RESERVED.has(match[1].toLowerCase()) ? { author: match[1], media: Boolean(match[2]) } : null;
  }

  function unseenPosts(author, posts, seen) {
    const result = [];
    for (const post of posts) {
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
      if (images.length) result.push({ author, postId: post.postId, images, videos: [] });
    }
    return result;
  }

  // Scan durable URL history in batches. Unknown records stop the scan so a
  // missing photo (including a failed or partial post) cannot be jumped over.
  async function locate({ author, posts, lookup, advance, wait, current, update, signal, confirmed = () => {}, now = Date.now, stallMs = 90000 }) {
    const seen = new Set();
    const countedPosts = new Set();
    const counts = { posts: 0, checked: 0, skipped: 0 };
    let lastProgress = now(), lastPosition, lastPost;
    const report = (phase, target, targetSaved = 0, extra = {}) => update({ ...counts, phase, target, targetSaved, ...(phase === "located" ? { postIds: [...countedPosts] } : {}), ...(lastPost ? { post: lastPost } : {}), ...extra });
    report("scanning");
    while (!signal.aborted) {
      if (!current()) { report("navigated"); return counts; }
      const candidates = unseenPosts(author, posts(), seen);
      for (let offset = 0; offset < candidates.length; offset += 100) {
        const batch = candidates.slice(offset, offset + 100);
        lastPost = batch[0];
        report("scanning");
        const items = await lookup(batch);
        if (signal.aborted) break;
        if (!current()) { report("navigated"); return counts; }
        for (let index = 0; index < batch.length; index++) {
          const post = batch[index], item = items?.[index];
          lastPost = post;
          if (item?.postId !== post.postId || item.total !== post.images.length || !Number.isSafeInteger(item.saved) || item.saved < 0 || item.saved > item.total) throw new Error("下载记录查询结果无效，已停止定位。");
          countedPosts.add(post.postId);
          counts.posts = countedPosts.size;
          counts.checked += item.total;
          counts.skipped += item.saved;
          if (item.saved < item.total) { report("located", post, item.saved); return counts; }
          confirmed(post);
        }
        report("scanning");
      }
      if (signal.aborted) break;
      if (!current()) { report("navigated"); return counts; }
      const position = advance();
      if (candidates.length || position !== lastPosition) lastProgress = now();
      lastPosition = position;
      if (now() - lastProgress >= stallMs) { report("stalled"); return counts; }
      report("waiting", undefined, 0, { waitSeconds: Math.floor((now() - lastProgress) / 1000), limitSeconds: stallMs / 1000 });
      await wait(signal);
    }
    report("stopped");
    return counts;
  }

  // The runner processes one post at a time so scrolling cannot flood downloads.
  async function run({ author, posts, save, advance, wait, current, update, signal, skipImages = [], initialProgress, now = Date.now, stallMs = 90000 }) {
    const seen = new Set(skipImages);
    const countedImages = new Set(initialProgress?.images || []);
    const countedPosts = new Set(initialProgress?.postIds || []);
    const counts = { posts: initialProgress?.posts || 0, found: initialProgress?.found || 0, saved: 0, skipped: initialProgress?.skipped || 0, failed: 0 };
    let skipCredit = initialProgress?.savedInPost || 0;
    let lastProgress = now(), lastPosition, lastPost, lastError;
    const report = (phase, extra = {}) => update({ ...counts, phase, ...(lastPost ? { post: lastPost } : {}), ...(lastError ? { error: lastError } : {}), ...extra });
    report("running");
    while (!signal.aborted) {
      if (!current()) { report("navigated"); return counts; }
      let progressed = false;
      for (const post of unseenPosts(author, posts(), seen)) {
        if (signal.aborted || !current()) break;
        progressed = true;
        lastPost = post;
        if (!countedPosts.has(post.postId)) { countedPosts.add(post.postId); counts.posts++; }
        // The boundary post was already discovered by the fast scan.
        counts.found += post.images.filter(url => !countedImages.has(url)).length;
        report("running");
        // Keep an in-flight post observable even after Stop; it may finish saving.
        const result = await save(post);
        counts.saved += result.complete;
        const credited = post.postId === initialProgress?.postId ? skipCredit : 0;
        counts.skipped += Math.max(0, result.skipped - credited);
        if (credited) skipCredit = 0;
        counts.failed += result.failed;
        if (result.failed) lastError = `帖子 ${post.postId}：${result.error || "未返回具体原因，请查看浏览器下载记录。"}`;
        report("running");
        if (result.failed && /HTTP\s*(?:401|403|429)|SERVER_(?:FORBIDDEN|UNAUTHORIZED)/i.test(result.error || "")) {
          report("blocked");
          return counts;
        }
      }
      if (signal.aborted) break;
      if (!current()) { report("navigated"); return counts; }
      const position = advance();
      if (progressed || position !== lastPosition) lastProgress = now();
      lastPosition = position;
      if (now() - lastProgress >= stallMs) { report("stalled"); return counts; }
      report("waiting", { waitSeconds: Math.floor((now() - lastProgress) / 1000), limitSeconds: stallMs / 1000 });
      await wait(signal);
    }
    report("stopped");
    return counts;
  }

  function mount({ send, readPost }) {
    const cache = new Map();
    const fastSaved = new Set();
    let panel, startButton, fastButton, stopButton, status, details, positionLabel, historyStatus, historyAuthor, historyTimer, controller, fastAuthor, running = false, restoreFocus = false, mode, lastAnnouncement = 0;
    let historyRequest = 0;
    async function refreshHistory(author) {
      const request = ++historyRequest;
      try {
        const result = await send({ type: "XIS_AUTHOR_HISTORY", author });
        if (request !== historyRequest || historyAuthor !== author.toLowerCase()) return;
        historyStatus.textContent = `历史已存：${result.posts} 帖 · ${result.images} 张`;
      } catch (error) {
        if (request === historyRequest) historyStatus.textContent = `历史统计暂不可用：${error.message}`;
      }
    }
    function queueHistory() {
      if (historyTimer) return;
      historyTimer = setTimeout(() => {
        historyTimer = undefined;
        const target = profile(location.pathname);
        if (target && historyStatus) void refreshHistory(target.author);
      }, 3000);
    }
    let activePhoto, followPhoto, marker, markerFrame, timelineError;
    function drawMarker() {
      markerFrame = undefined;
      if (!marker) {
        marker = document.createElement("div");
        marker.id = "xis-photo-marker";
        marker.setAttribute("aria-hidden", "true");
        document.body.append(marker);
      }
      const boxes = [];
      if (activePhoto && profile(location.pathname)?.author.toLowerCase() === activePhoto.post.author.toLowerCase()) {
        const candidates = [];
        for (const link of document.querySelectorAll('a[href*="/status/"]')) {
          const parsed = globalThis.XImageSaverCore.parsePostUrl(link.getAttribute("href"));
          const photo = link.pathname.match(/\/photo\/(\d+)(?:\/|$)/);
          if (!photo || parsed?.postId !== activePhoto.post.postId || parsed.author.toLowerCase() !== activePhoto.post.author.toLowerCase()) continue;
          const rect = link.getBoundingClientRect();
          if (!rect.width || !rect.height) continue;
          candidates.push({ link, index: Number(photo[1]) });
        }
        // A grid can show just one representative tile for a multi-photo post.
        const exact = candidates.filter(item => item.index === activePhoto.index);
        const targets = exact.length ? exact : candidates;
        if (followPhoto === activePhoto && running && !controller.signal.aborted && targets.length) {
          followPhoto = undefined;
          const tile = targets[0].link;
          const rect = tile.getBoundingClientRect();
          // Account for X's sticky navigation. Scroll only when switching the
          // current photo, so polling cannot repeatedly undo manual scrolling.
          if (rect.top < 96 || rect.bottom > innerHeight - 24) {
            tile.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
          }
        }
        for (const { link } of targets) {
          const rect = link.getBoundingClientRect();
          if (rect.bottom <= 0 || rect.top >= innerHeight) continue;
          const box = document.createElement("div");
          box.className = "xis-photo-box";
          Object.assign(box.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
          const label = document.createElement("span");
          label.textContent = activePhoto.label;
          box.append(label);
          boxes.push(box);
        }
      }
      marker.replaceChildren(...boxes);
    }
    function queueMarker() {
      if (!markerFrame) markerFrame = requestAnimationFrame(drawMarker);
    }
    function mark(post, label, index, follow = false) {
      if (!post) return;
      const samePost = activePhoto?.post.postId === post.postId && activePhoto.post.author.toLowerCase() === post.author.toLowerCase();
      if (samePost && index === undefined) index = activePhoto.index;
      const changed = !samePost || activePhoto.index !== index;
      const pending = followPhoto === activePhoto;
      activePhoto = { post, label, index };
      if (follow && changed || pending) followPhoto = activePhoto;
      positionLabel.textContent = `${label} · 帖子 ${post.postId}${index ? ` · 第 ${index}/${post.images.length} 张` : ` · ${post.images.length} 张`}`;
      positionLabel.href = `https://x.com/${post.author}/status/${post.postId}`;
      positionLabel.hidden = false;
      queueMarker();
    }
    const INTENT = "xis:author-download";
    const pause = (signal, delay = 1200) => new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, delay);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
    function renderProgress(state) {
      if (state.post) mark(state.post, state.phase === "running" ? "正在判断 / 下载" : "最近处理", undefined, state.phase === "running");
      if (state.error) details.textContent = `最近失败原因：${state.error}`;
      // Avoid flooding screen readers while duplicate-only posts finish quickly.
      if (["running", "waiting"].includes(state.phase) && Date.now() - lastAnnouncement < 1000 && !state.error) return;
      lastAnnouncement = Date.now();
      const prefix = `本次处理 ${state.posts} 帖 · 发现 ${state.found} 张\n保存 ${state.saved} 张 · 跳过 ${state.skipped} 张 · 失败 ${state.failed} 张`;
      const suffix = { running: "正在收集和下载…", stopping: "正在停止，等待当前帖下载完成…", stopped: "已停止，可从当前位置继续补存。", navigated: "页面已切换，任务已停止。", blocked: "服务器限制访问，已停止。请稍后从当前位置继续补存。", waiting: `等待 X 加载更多图片… ${state.waitSeconds}/${state.limitSeconds} 秒无进展`, stalled: "连续 90 秒没有滚动或新图片，已停止。可能已到末尾，也可能是 X 未继续加载；可从当前位置继续补存。" };
      status.textContent = `${prefix}\n${suffix[state.phase] || ""}`;
    }
    function renderLocation(state) {
      if (state.post) mark(state.post, state.phase === "located" ? "找到未保存图片" : "快速判断到这里", undefined, ["scanning", "located"].includes(state.phase));
      if (["scanning", "waiting"].includes(state.phase) && Date.now() - lastAnnouncement < 1000) return;
      lastAnnouncement = Date.now();
      const suffix = {
        scanning: "正在快速定位，仅检查记录，不下载…",
        located: "发现未确认保存的图片，正在切换为正常下载…",
        stalled: "连续 90 秒没有滚动或新图片，已停止定位；可能已到末尾，也可能是 X 未继续加载。",
        waiting: `等待 X 加载更多图片… ${state.waitSeconds}/${state.limitSeconds} 秒无进展`,
        stopped: "已停止定位，可从当前位置继续。",
        navigated: "页面已切换，定位已停止。"
      };
      status.textContent = `本次已检查 ${state.posts} 帖 · 已检查 ${state.checked} 张\n已确认保存 ${state.skipped} 张\n${suffix[state.phase]}`;
      if (state.phase === "located") {
        // Keep metadata even if X has already recycled the corresponding grid tile.
        cache.set(state.target.postId, state.target);
        const link = document.querySelector(`a[href*="/${state.target.author}/status/${state.target.postId}"]`);
        link?.scrollIntoView({ block: "center", behavior: "instant" });
      }
    }
    function getPosts() {
      const all = new Map(cache);
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        const post = readPost(article);
        if (post?.images.length && !all.has(post.postId)) all.set(post.postId, post);
      }
      return all.values();
    }
    function currentPhotoPost(author) {
      let firstRow = Infinity, boundary;
      const primary = document.querySelector('[data-testid="primaryColumn"]') || document;
      for (const link of primary.querySelectorAll('a[href*="/status/"]')) {
        if (!/\/photo\/\d+(?:\/|$)/.test(link.pathname)) continue;
        const post = globalThis.XImageSaverCore.parsePostUrl(link.getAttribute("href"));
        if (post?.author.toLowerCase() !== author.toLowerCase()) continue;
        const rect = link.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.bottom <= 0) continue;
        // The first visible row (or the next row below the viewport) anchors
        // this click. X's photo timeline is ordered newest to oldest.
        if (rect.top < firstRow - 1) { firstRow = rect.top; boundary = BigInt(post.postId); }
        else if (Math.abs(rect.top - firstRow) <= 1 && BigInt(post.postId) > boundary) boundary = BigInt(post.postId);
      }
      return boundary;
    }
    async function save(post) {
      const started = await send({ type: "XIS_DOWNLOAD_POST", post });
      const deadline = Date.now() + 30 * 60 * 1000;
      while (true) {
        const result = await send({ type: "XIS_JOB_STATUS", jobId: started.jobId });
        if (result.current) mark(post, result.pending ? "正在判断 / 下载" : "已处理", result.current.index, true);
        if (result.error) details.textContent = `最近失败原因：帖子 ${post.postId}：${result.error}`;
        if (!result.pending) return result;
        if (Date.now() > deadline) throw new Error("当前帖下载超时，任务已停止；请检查浏览器下载记录后重试。");
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    async function start(requestedMode = "download") {
      if (running) return;
      const target = profile(location.pathname);
      if (!target) return;
      if (fastAuthor !== target.author.toLowerCase()) {
        fastSaved.clear();
        fastAuthor = target.author.toLowerCase();
      }
      if (!target.media || new URLSearchParams(location.search).get("filter") !== "photo") {
        try { sessionStorage.setItem(INTENT, JSON.stringify({ author: target.author, mode: requestedMode, expires: Date.now() + 30000 })); }
        catch { status.textContent = "请打开此作者的媒体页，再点击下载。"; return; }
        location.assign(`/${target.author}/media?filter=photo`);
        return;
      }
      const startPost = requestedMode === "locate" ? currentPhotoPost(target.author) : undefined;
      if (requestedMode === "locate" && startPost === undefined && window.scrollY > 0) {
        status.textContent = "当前位置没有已加载的图片。请稍候或稍微向上滚动，看到图片后再点击快速定位。";
        return;
      }
      running = true;
      activePhoto = undefined;
      followPhoto = undefined;
      restoreFocus = false;
      mode = requestedMode;
      lastAnnouncement = 0;
      controller = new AbortController();
      details.textContent = "";
      timelineError = undefined;
      const focusStop = document.activeElement === startButton || document.activeElement === fastButton;
      startButton.disabled = true;
      fastButton.disabled = true;
      stopButton.hidden = false;
      stopButton.disabled = false;
      if (focusStop) stopButton.focus({ preventScroll: true });
      panel.querySelector("h2").textContent = `@${target.author} 的图片`;
      try {
        const options = {
          author: target.author, posts: () => startPost === undefined ? getPosts()
            : Array.from(getPosts()).filter(post => /^\d{1,30}$/.test(post.postId) && BigInt(post.postId) <= startPost),
          save, signal: controller.signal,
          wait: signal => pause(signal, mode === "locate" ? 600 : 1200),
          current: () => {
            const route = profile(location.pathname);
            return route?.media && route.author.toLowerCase() === target.author.toLowerCase() && new URLSearchParams(location.search).get("filter") === "photo";
          },
          advance: () => {
            if (navigator.onLine === false) throw new Error("网络已断开。恢复连接后可从当前位置继续补存。");
            if (timelineError) throw new Error(timelineError);
            const primary = document.querySelector('[data-testid="primaryColumn"]') || document;
            const error = primary.querySelector('[data-testid="error-detail"]');
            if (error && error.getClientRects().length) throw new Error(`X 加载失败，已停止：${error.textContent}`);
            const position = `${Math.round(window.scrollY)}:${document.documentElement.scrollHeight}`;
            window.scrollBy({ top: Math.max(400, window.innerHeight * 0.8), behavior: "instant" });
            return position;
          },
          update: state => renderProgress({ ...state, phase: controller.signal.aborted && state.phase === "running" ? "stopping" : state.phase })
        };
        if (mode === "locate") {
          let located;
          await locate({ ...options, lookup: async posts => (await send({ type: "XIS_PHOTO_HISTORY", posts })).items,
            confirmed: post => post.images.forEach(url => fastSaved.add(url)),
            update: state => { if (state.phase === "located") located = state; renderLocation(state); } });
          if (located && !controller.signal.aborted && options.current()) {
            mode = "download";
            lastAnnouncement = 0;
            await run({ ...options, skipImages: fastSaved, initialProgress: {
              posts: located.posts, postIds: located.postIds,
              found: located.checked, skipped: located.skipped,
              postId: located.target.postId, images: located.target.images, savedInPost: located.targetSaved
            } });
          }
        } else await run({ ...options, skipImages: fastSaved });
      } catch (error) {
        details.textContent = `停止原因：${error.message || "下载失败，未返回具体原因。"}`;
        status.textContent += "\n任务已停止，可从当前位置继续补存。";
      } finally {
        running = false;
        startButton.disabled = false;
        fastButton.disabled = false;
        startButton.textContent = "从当前位置继续补存";
        if (document.activeElement === stopButton || restoreFocus && document.activeElement === document.body) startButton.focus({ preventScroll: true });
        stopButton.hidden = true;
        void refreshHistory(target.author);
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
        status.textContent = "从当前位置向下滚动收集原图，已存图片自动跳过。请保持本页打开；需要从头收集时请先回到页首。";
        historyStatus = document.createElement("p");
        historyStatus.className = "xis-history-summary";
        historyStatus.title = "当前作者、当前图片保存目录的成功记录；文件删除后仍计入。历史帖子数按成功保存文件的帖子 ID 统计。";
        positionLabel = document.createElement("a");
        positionLabel.className = "xis-current-position";
        positionLabel.target = "_blank";
        positionLabel.rel = "noopener noreferrer";
        positionLabel.hidden = true;
        details = document.createElement("p");
        details.className = "xis-error-detail";
        details.setAttribute("role", "status");
        startButton = document.createElement("button");
        startButton.type = "button";
        startButton.textContent = "下载此作者图片";
        startButton.addEventListener("click", () => { void start(); });
        fastButton = document.createElement("button");
        fastButton.type = "button";
        fastButton.textContent = "快速定位并补存";
        fastButton.setAttribute("aria-describedby", "xis-fast-help");
        fastButton.addEventListener("click", () => { void start("locate"); });
        const help = document.createElement("p");
        help.id = "xis-fast-help";
        help.textContent = "可先手动滚动，再从当前位置快速定位；批量跳过已保存的图片，遇到未保存的图片自动开始下载。";
        stopButton = document.createElement("button");
        stopButton.type = "button";
        stopButton.textContent = "停止";
        stopButton.hidden = true;
        stopButton.addEventListener("click", () => {
          controller?.abort();
          restoreFocus = document.activeElement === stopButton;
          stopButton.disabled = true;
          status.textContent += mode === "locate" ? "\n正在停止定位…" : "\n正在停止，当前帖已开始的下载会继续完成。";
        });
        const actions = document.createElement("div");
        actions.className = "xis-author-actions";
        actions.append(startButton, fastButton, stopButton);
        panel.append(title, help, historyStatus, status, positionLabel, details, actions);
        document.body.append(panel);
      }
      if (!panel) return;
      panel.hidden = !isProfile && !running;
      if (isProfile && historyAuthor !== target.author.toLowerCase()) {
        historyAuthor = target.author.toLowerCase();
        historyStatus.textContent = "正在读取历史记录…";
        void refreshHistory(target.author);
      }
      if (panel.hidden) queueMarker();
      if (!running && target) {
        const label = `@${target.author} 的图片`;
        if (panel.querySelector("h2").textContent !== label) {
          fastSaved.clear();
          activePhoto = undefined;
          positionLabel.hidden = true;
          details.textContent = "";
          queueMarker();
          panel.querySelector("h2").textContent = label;
          status.textContent = "从当前位置向下滚动收集原图，已存图片自动跳过。请保持本页打开；需要从头收集时请先回到页首。";
          startButton.textContent = "下载此作者图片";
        }
      }
      if (isProfile && target.media && new URLSearchParams(location.search).get("filter") === "photo" && !running) {
        try {
          const intent = JSON.parse(sessionStorage.getItem(INTENT) || "null");
          if (intent) sessionStorage.removeItem(INTENT);
          if (intent?.expires > Date.now() && intent.author.toLowerCase() === target.author.toLowerCase()) void start(intent.mode === "locate" ? "locate" : "download");
        } catch { /* No pending click to resume. */ }
      }
    }
    window.addEventListener("message", event => {
      if (event.source === window && event.origin === location.origin && event.data?.type === "XIS_TIMELINE_STATUS" && event.data.path === location.pathname && running) {
        timelineError = typeof event.data.error === "string" ? event.data.error.slice(0, 400) : undefined;
      }
      if (event.source !== window || event.origin !== location.origin || event.data?.type !== "XIS_PHOTO_DATA" || !Array.isArray(event.data.items)) return;
      for (const post of event.data.items.slice(0, 500)) {
        if (typeof post?.author === "string" && /^[A-Za-z0-9_]{1,15}$/.test(post.author) && /^\d{1,30}$/.test(post.postId) && Array.isArray(post.images) && post.images.length <= 20) cache.set(post.postId, post);
      }
      while (cache.size > 500) cache.delete(cache.keys().next().value);
    });
    let scheduled = false;
    new MutationObserver(records => {
      if (records.every(record => panel?.contains(record.target) || record.target === panel || marker?.contains(record.target) || record.target === marker || [...record.addedNodes].every(node => node === marker) && record.addedNodes.length)) return;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; sync(); });
      if (activePhoto) queueMarker();
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", () => { sync(); queueMarker(); });
    window.addEventListener("scroll", queueMarker, { passive: true });
    window.addEventListener("resize", queueMarker);
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local") return;
      if (Object.entries(changes).some(([key, value]) => key.startsWith("xis:url:") && (value.newValue?.completedAt || value.oldValue?.completedAt))) queueHistory();
      if (!changes.rootFolder) return;
      fastSaved.clear();
      const target = profile(location.pathname);
      if (target) void refreshHistory(target.author);
      if (running) controller.abort();
    });
    sync();
  }
  globalThis.XImageSaverAuthor = Object.freeze({ profile, run, locate, mount });
})();
