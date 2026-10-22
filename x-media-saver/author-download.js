(() => {
  "use strict";
  const { originalImage, originalVideo } = globalThis.XImageSaverCore;
  const mediaField = type => type === "video" ? "videos" : "images";
  const identity = (parsed, type) => type === "video" ? parsed.key : parsed.url;
  function mediaIdentities(sources, type) {
    const values = [];
    for (const source of sources) {
      try { values.push(identity((type === "video" ? originalVideo : originalImage)(source), type)); }
      catch { /* Only validated media can be credited as already seen. */ }
    }
    return values;
  }
  const RESERVED = new Set(["home", "explore", "notifications", "messages", "settings", "search", "i", "compose", "login", "logout", "signup", "tos", "privacy"]);
  function profile(pathname) {
    const match = pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/(media))?\/?$/);
    return match && !RESERVED.has(match[1].toLowerCase()) ? { author: match[1], media: Boolean(match[2]) } : null;
  }

  function unseenPosts(author, posts, seen, mediaType) {
    const field = mediaField(mediaType), parse = mediaType === "video" ? originalVideo : originalImage;
    const result = [];
    for (const post of posts) {
      if (post.author?.toLowerCase() !== author.toLowerCase() || !/^\d{1,30}$/.test(post.postId) || !Array.isArray(post[field]) || post[field].length > 20) continue;
      const sources = [];
      for (const value of post[field]) {
        try {
          const image = parse(value);
          const key = identity(image, mediaType);
          if (seen.has(key)) continue;
          seen.add(key);
          sources.push(image.url);
        } catch { /* Ignore page-supplied non-media URLs. */ }
      }
      if (sources.length) result.push({ author, postId: post.postId, images: [], videos: [], [field]: sources });
    }
    return result;
  }

  // Scan durable URL history in batches. Unknown records stop the scan so a
  // missing photo (including a failed or partial post) cannot be jumped over.
  async function locate({ author, posts, lookup, advance, wait, current, update, signal, mediaType = "image", confirmed = () => {}, now = Date.now, stallMs = 90000, diagnose = () => null, ended = () => false }) {
    const seen = new Set();
    const countedPosts = new Set();
    const counts = { posts: 0, checked: 0, skipped: 0 };
    let lastProgress = now(), lastPosition, lastPost;
    const report = (phase, target, targetSaved = 0, extra = {}) => update({ ...counts, phase, target, targetSaved, ...(phase === "located" ? { postIds: [...countedPosts] } : {}), ...(lastPost ? { post: lastPost } : {}), ...extra });
    const blocked = () => {
      const cause = diagnose();
      if (!cause?.error) return false;
      report("blocked", undefined, 0, { stopReason: cause.reason, stopError: cause.error });
      return true;
    };
    report("scanning");
    while (!signal.aborted) {
      if (!current()) { report("navigated"); return counts; }
      if (blocked()) return counts;
      const candidates = unseenPosts(author, posts(), seen, mediaType);
      for (let offset = 0; offset < candidates.length; offset += 100) {
        if (blocked()) return counts;
        const batch = candidates.slice(offset, offset + 100);
        lastPost = batch[0];
        report("scanning");
        const items = await lookup(batch);
        if (signal.aborted) break;
        if (!current()) { report("navigated"); return counts; }
        for (let index = 0; index < batch.length; index++) {
          const post = batch[index], item = items?.[index];
          lastPost = post;
          if (item?.postId !== post.postId || item.total !== post[mediaField(mediaType)].length || !Number.isSafeInteger(item.saved) || item.saved < 0 || item.saved > item.total) throw new Error("下载记录查询结果无效，已停止定位。");
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
      if (blocked()) return counts;
      const finish = ended();
      if (finish) {
        // Metadata may arrive while the final post or history batch is pending.
        if (unseenPosts(author, posts(), new Set(seen), mediaType).length) continue;
        report(finish === "exhausted" ? "exhausted" : "ended"); return counts;
      }
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
  async function run({ author, posts, save, advance, wait, current, update, signal, mediaType = "image", skipImages = [], skipMedia = skipImages, initialProgress, now = Date.now, stallMs = 90000, diagnose = () => null, ended = () => false }) {
    const field = mediaField(mediaType);
    const seen = new Set(mediaIdentities(skipMedia, mediaType));
    const countedImages = new Set(mediaIdentities(initialProgress?.[field] || [], mediaType));
    const countedPosts = new Set(initialProgress?.postIds || []);
    const counts = { posts: initialProgress?.posts || 0, found: initialProgress?.found || 0, saved: 0, skipped: initialProgress?.skipped || 0, failed: 0 };
    let skipCredit = initialProgress?.savedInPost || 0;
    let lastProgress = now(), lastPosition, lastPost, lastError;
    const report = (phase, extra = {}) => update({ ...counts, phase, ...(lastPost ? { post: lastPost } : {}), ...(lastError ? { error: lastError } : {}), ...extra });
    const blocked = () => {
      const cause = diagnose();
      if (!cause?.error) return false;
      report("blocked", { stopReason: cause.reason, stopError: cause.error });
      return true;
    };
    report("running");
    while (!signal.aborted) {
      if (!current()) { report("navigated"); return counts; }
      if (blocked()) return counts;
      let progressed = false;
      for (const post of unseenPosts(author, posts(), seen, mediaType)) {
        if (signal.aborted || !current()) break;
        if (blocked()) return counts;
        progressed = true;
        lastPost = post;
        if (!countedPosts.has(post.postId)) { countedPosts.add(post.postId); counts.posts++; }
        // The boundary post was already discovered by the fast scan.
        counts.found += mediaIdentities(post[field], mediaType).filter(key => !countedImages.has(key)).length;
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
      if (blocked()) return counts;
      const finish = ended();
      if (finish) {
        // Metadata may arrive while the final post or history batch is pending.
        if (unseenPosts(author, posts(), new Set(seen), mediaType).length) continue;
        report(finish === "exhausted" ? "exhausted" : "ended"); return counts;
      }
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
    const videoCache = new Map();
    const fastSaved = new Set();
    let mediaType = profile(location.pathname)?.media && new URLSearchParams(location.search).get("filter") !== "photo" ? "video" : "image";
    let lastMediaRoute = location.pathname + location.search;
    const field = () => mediaField(mediaType);
    const kind = () => mediaType === "video" ? "视频" : "图片";
    const unit = () => mediaType === "video" ? "个视频" : "张";
    const onMediaPage = () => profile(location.pathname)?.media && (mediaType === "image" ? new URLSearchParams(location.search).get("filter") === "photo" : [null, "video"].includes(new URLSearchParams(location.search).get("filter")));
    let panel, startButton, fastButton, stopButton, typePicker, help, status, details, positionLabel, historyStatus, historyAuthor, historyTimer, controller, fastAuthor, running = false, restoreFocus = false, mode, lastAnnouncement = 0;
    let historyRequest = 0;
    async function refreshHistory(author) {
      const request = ++historyRequest;
      try {
        const result = await send({ type: "XIS_AUTHOR_HISTORY", author, mediaType });
        if (request !== historyRequest || historyAuthor !== author.toLowerCase()) return;
        historyStatus.textContent = `历史已存：${result.posts} 帖 · ${result[field()]} ${unit()}`;
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
    let activePhoto, followPhoto, marker, markerFrame, timelineState, timelineFailure, consumedTimelineError;
    function mediaTiles(author) {
      const tiles = [];
      const primary = document.querySelector('[data-testid="primaryColumn"]') || document;
      for (const link of primary.querySelectorAll('a[href*="/status/"]')) {
        const media = link.pathname.match(mediaType === "video" ? /\/video\/(\d+)(?:\/|$)/ : /\/photo\/(\d+)(?:\/|$)/);
        const post = media && globalThis.XImageSaverCore.parsePostUrl(link.getAttribute("href"));
        if (post?.author.toLowerCase() === author.toLowerCase()) tiles.push({ node: link, ...post, index: Number(media[1]) });
      }
      if (mediaType === "video") {
        // X renders the video filter as full posts, often without /video/ links.
        for (const article of primary.querySelectorAll('article[data-testid="tweet"]')) {
          let post = readPost(article);
          if (!post?.videos?.length) {
            // A sensitive-content warning can replace the player even though
            // the timeline already supplied a downloadable MP4 for this post.
            const time = [...article.querySelectorAll('a[href*="/status/"] time')].find(node => node.closest('article[data-testid="tweet"]') === article && !node.closest('[data-testid="quoteTweet"], [data-testid="card.wrapper"], div[role="link"]'));
            const info = time && globalThis.XImageSaverCore.parsePostUrl(time.closest("a").href);
            if (info?.author.toLowerCase() === author.toLowerCase()) post = videoCache.get(info.postId);
          }
          if (post?.author.toLowerCase() !== author.toLowerCase() || !post.videos?.length) continue;
          const players = [...article.querySelectorAll('[data-testid="videoPlayer"]')].filter(node => !node.closest('[data-testid="quoteTweet"], [data-testid="card.wrapper"], div[role="link"]'));
          for (const [index, node] of (players.length ? players : [article]).entries()) tiles.push({ node, author: post.author, postId: post.postId, index: index + 1 });
        }
      }
      return tiles;
    }
    function drawMarker() {
      markerFrame = undefined;
      if (!panel && !marker) return;
      if (!marker) {
        marker = document.createElement("div");
        marker.id = "xis-photo-marker";
        marker.setAttribute("aria-hidden", "true");
        document.body.append(marker);
      }
      const boxes = [];
      const addBox = (node, text, postId, preview = false) => {
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.bottom <= 96 || rect.top >= innerHeight) return;
        const box = document.createElement("div");
        box.className = `xis-photo-box${preview ? " xis-start-box" : ""}`;
        box.dataset.postId = postId;
        Object.assign(box.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        const label = document.createElement("span");
        label.textContent = text;
        // Keep the label readable when the first row is partly under X's header.
        label.style.top = `${Math.max(0, 96 - rect.top)}px`;
        box.append(label);
        boxes.push(box);
      };
      const target = profile(location.pathname);
      if (!running && panel && !panel.hidden && onMediaPage()) {
        const tile = currentMediaTile(target.author);
        positionLabel.hidden = !tile;
        if (tile) {
          const visible = tile.node.getBoundingClientRect().top < innerHeight;
          const text = `${visible ? "从当前位置开始" : "起点在下方，向下滚动查看"} · 帖子 ${tile.postId}`;
          if (positionLabel.textContent !== text) positionLabel.textContent = text;
          positionLabel.href = `https://x.com/${tile.author}/status/${tile.postId}`;
          addBox(tile.node, "从这里开始", tile.postId, true);
        }
      } else if (running && activePhoto && target?.author.toLowerCase() === activePhoto.post.author.toLowerCase()) {
        const candidates = [];
        for (const tile of mediaTiles(activePhoto.post.author)) {
          if (tile.postId !== activePhoto.post.postId) continue;
          const rect = tile.node.getBoundingClientRect();
          if (!rect.width || !rect.height) continue;
          candidates.push({ link: tile.node, index: tile.index });
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
          addBox(link, activePhoto.label, activePhoto.post.postId);
        }
      }
      if (!running && positionLabel && (panel?.hidden || !onMediaPage())) positionLabel.hidden = true;
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
      positionLabel.textContent = `${label} · 帖子 ${post.postId}${index ? ` · 第 ${index}/${post[field()].length} ${unit()}` : ` · ${post[field()].length} ${unit()}`}`;
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
      if (state.stopError) details.textContent = `停止原因：${state.stopError}`;
      else if (state.error) details.textContent = `最近失败原因：${state.error}`;
      // Avoid flooding screen readers while duplicate-only posts finish quickly.
      if (["running", "waiting"].includes(state.phase) && Date.now() - lastAnnouncement < 1000 && !state.error) return;
      lastAnnouncement = Date.now();
      const prefix = `本次处理 ${state.posts} 帖 · 发现 ${state.found} ${unit()}\n保存 ${state.saved} ${unit()} · 跳过 ${state.skipped} ${unit()} · 失败 ${state.failed} ${unit()}`;
      const suffix = { running: "正在收集和下载…", stopping: "正在停止，等待当前帖下载完成…", stopped: "已停止，可从当前位置继续补存。", navigated: "页面已切换，任务已停止。", blocked: "任务已停止，具体原因见下方；可从当前位置继续补存。", ended: "X 已明确返回本次媒体时间线末尾，已处理当前收集内容。", exhausted: "本次分页没有后续：X 仅返回未推进的底部分页游标。已处理当前收集内容；不代表全部历史均已开放，可从当前位置继续。", waiting: `等待 X 加载更多${kind()}… ${state.waitSeconds}/${state.limitSeconds} 秒无进展`, stalled: `连续 90 秒没有滚动或新${kind()}，已停止。原因未确认：未收到明确的末尾或限流信号，可能是 X 加载停滞；可从当前位置继续补存。` };
      status.textContent = `${prefix}\n${suffix[state.phase] || ""}`;
    }
    function renderLocation(state) {
      if (state.stopError) details.textContent = `停止原因：${state.stopError}`;
      if (state.post) mark(state.post, state.phase === "located" ? `找到未保存${kind()}` : "快速判断到这里", undefined, ["scanning", "located"].includes(state.phase));
      if (["scanning", "waiting"].includes(state.phase) && Date.now() - lastAnnouncement < 1000) return;
      lastAnnouncement = Date.now();
      const suffix = {
        scanning: "正在快速定位，仅检查记录，不下载…",
        located: `发现未确认保存的${kind()}，正在切换为正常下载…`,
        stalled: `连续 90 秒没有滚动或新${kind()}，已停止定位。原因未确认：未收到明确的末尾或限流信号，可能是 X 加载停滞。`,
        waiting: `等待 X 加载更多${kind()}… ${state.waitSeconds}/${state.limitSeconds} 秒无进展`,
        blocked: "定位已停止，具体原因见下方；可从当前位置继续。",
        ended: "X 已明确返回本次媒体时间线末尾，当前收集内容均已检查。",
        exhausted: "本次分页没有后续：X 仅返回未推进的底部分页游标。当前收集内容均已检查；不代表全部历史均已开放。",
        stopped: "已停止定位，可从当前位置继续。",
        navigated: "页面已切换，定位已停止。"
      };
      status.textContent = `本次已检查 ${state.posts} 帖 · 已检查 ${state.checked} ${unit()}\n已确认保存 ${state.skipped} ${unit()}\n${suffix[state.phase]}`;
      if (state.phase === "located") {
        // Keep metadata even if X has already recycled the corresponding grid tile.
        (mediaType === "video" ? videoCache : cache).set(state.target.postId, state.target);
        const link = document.querySelector(`a[href*="/${state.target.author}/status/${state.target.postId}"]`);
        link?.scrollIntoView({ block: "center", behavior: "instant" });
      }
    }
    function getPosts() {
      const all = new Map(mediaType === "video" ? videoCache : cache);
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        const post = readPost(article);
        if (post?.[field()]?.length && !all.has(post.postId)) all.set(post.postId, post);
      }
      // X can replay older pages before the top page after scrolling back.
      // Cache insertion order must not decide where a new task begins.
      return [...all.values()].filter(post => /^\d{1,30}$/.test(post.postId))
        .sort((a, b) => BigInt(a.postId) === BigInt(b.postId) ? 0 : BigInt(a.postId) > BigInt(b.postId) ? -1 : 1);
    }
    function currentMediaTile(author) {
      let firstRow = Infinity, selected;
      for (const tile of mediaTiles(author)) {
        const rect = tile.node.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.bottom <= 96) continue;
        // The first visible row (or the next row below the viewport) anchors
        // this click. X's photo timeline is ordered newest to oldest.
        if (rect.top < firstRow - 1) { firstRow = rect.top; selected = tile; }
        else if (Math.abs(rect.top - firstRow) <= 1 && (BigInt(tile.postId) > BigInt(selected.postId) || tile.postId === selected.postId && tile.index < selected.index)) selected = tile;
      }
      return selected;
    }
    function currentMediaPost(author) {
      const tile = currentMediaTile(author);
      return tile ? BigInt(tile.postId) : undefined;
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
      if (!onMediaPage()) {
        try { sessionStorage.setItem(INTENT, JSON.stringify({ author: target.author, mode: requestedMode, mediaType, expires: Date.now() + 30000 })); }
        catch { status.textContent = "请打开此作者的媒体页，再点击下载。"; return; }
        location.assign(`/${target.author}/media${mediaType === "video" ? "" : "?filter=photo"}`);
        return;
      }
      const startPost = currentMediaPost(target.author);
      if (startPost === undefined && window.scrollY > 0) {
        status.textContent = `当前位置没有已加载的${kind()}。请稍候或稍微向上滚动，看到${kind()}后再开始。`;
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
      const taskStartedAt = Date.now();
      const sameRoute = state => state?.path === location.pathname && state.search === location.search;
      const initialEnd = sameRoute(timelineState) && (timelineState.ended || timelineState.exhausted) && taskStartedAt - timelineState.observedAt < 120000 ? timelineState.requestId : undefined;
      // Use a recent failure observed before clicking too. A deliberate retry
      // may scroll again instead of being trapped forever by the same failure.
      timelineFailure = sameRoute(timelineState) && timelineState.error && timelineState.requestId !== consumedTimelineError && Date.now() - timelineState.observedAt < 120000 ? timelineState : undefined;
      const focusStop = document.activeElement === startButton || document.activeElement === fastButton;
      startButton.disabled = true;
      fastButton.disabled = true;
      typePicker.disabled = true;
      stopButton.hidden = false;
      stopButton.disabled = false;
      if (focusStop) stopButton.focus({ preventScroll: true });
      panel.querySelector("h2").textContent = `@${target.author} 的${kind()}`;
      try {
        const options = {
          author: target.author, mediaType, posts: () => startPost === undefined ? getPosts()
            : Array.from(getPosts()).filter(post => /^\d{1,30}$/.test(post.postId) && BigInt(post.postId) <= startPost),
          save, signal: controller.signal,
          wait: signal => pause(signal, mode === "locate" ? 600 : 1200),
          current: () => {
            const route = profile(location.pathname);
            return onMediaPage() && route.author.toLowerCase() === target.author.toLowerCase();
          },
          diagnose: () => {
            if (navigator.onLine === false) return { reason: "offline", error: "网络已断开。恢复连接后可从当前位置继续补存。" };
            if (timelineFailure) {
              const retryAt = Number(timelineFailure.retryAt);
              const retry = Number.isFinite(retryAt) && retryAt > Date.now() ? ` 建议在 ${new Date(retryAt).toLocaleString("zh-CN", { hour12: false })} 后重试（X 返回的时间，不保证届时解除）。` : "";
              return { reason: timelineFailure.reason, error: timelineFailure.error + retry };
            }
            const primary = document.querySelector('[data-testid="primaryColumn"]') || document;
            const error = primary.querySelector('[data-testid="error-detail"]');
            if (error && error.getClientRects().length) return { reason: "page", error: `X 页面显示加载失败：${error.textContent.slice(0, 300)}。未收到明确限流证据，无法确认是否为风控。` };
            return null;
          },
          ended: () => {
            if (!sameRoute(timelineState) || !timelineState.ended && !timelineState.exhausted ||
              !(timelineState.requestedAt >= taskStartedAt || timelineState.requestId === initialEnd) ||
              window.scrollY + window.innerHeight < document.documentElement.scrollHeight - 96) return false;
            return timelineState.ended ? true : "exhausted";
          },
          advance: () => {
            const position = `${Math.round(window.scrollY)}:${document.documentElement.scrollHeight}`;
            window.scrollBy({ top: Math.max(400, window.innerHeight * 0.8), behavior: "instant" });
            return position;
          },
          update: state => renderProgress({ ...state, phase: controller.signal.aborted && state.phase === "running" ? "stopping" : state.phase })
        };
        if (mode === "locate") {
          let located;
          await locate({ ...options, lookup: async posts => (await send({ type: mediaType === "video" ? "XIS_VIDEO_HISTORY" : "XIS_PHOTO_HISTORY", posts })).items,
            confirmed: post => post[field()].forEach(url => fastSaved.add(url)),
            update: state => { if (state.phase === "located") located = state; renderLocation(state); } });
          if (located && !controller.signal.aborted && options.current()) {
            mode = "download";
            lastAnnouncement = 0;
            await run({ ...options, skipMedia: fastSaved, initialProgress: {
              posts: located.posts, postIds: located.postIds,
              found: located.checked, skipped: located.skipped,
              postId: located.target.postId, [field()]: located.target[field()], savedInPost: located.targetSaved
            } });
          }
        } else await run({ ...options, skipMedia: fastSaved });
      } catch (error) {
        details.textContent = `停止原因：${error.message || "下载失败，未返回具体原因。"}`;
        status.textContent += "\n任务已停止，可从当前位置继续补存。";
      } finally {
        if (timelineFailure) consumedTimelineError = timelineFailure.requestId;
        running = false;
        startButton.disabled = false;
        fastButton.disabled = false;
        typePicker.disabled = false;
        startButton.textContent = "从当前位置继续补存";
        if (document.activeElement === stopButton || restoreFocus && document.activeElement === document.body) startButton.focus({ preventScroll: true });
        stopButton.hidden = true;
        void refreshHistory(target.author);
        sync();
      }
    }
    function sync() {
      const target = profile(location.pathname);
      const route = location.pathname + location.search;
      if (!running && target?.media && route !== lastMediaRoute) {
        lastMediaRoute = route;
        const nextType = new URLSearchParams(location.search).get("filter") === "photo" ? "image" : "video";
        if (nextType !== mediaType) {
          mediaType = nextType;
          fastSaved.clear();
          historyAuthor = undefined;
          const input = typePicker?.querySelector(`input[value="${mediaType}"]`);
          if (input) input.checked = true;
        }
      }
      // A profile header avoids presenting a download action on /help-like routes.
      const isProfile = target && (document.querySelector('[data-testid="UserName"], [data-testid="UserProfileHeader_Items"]') || document.querySelector(`a[href="/${target.author}/media"]`));
      if (!panel && isProfile) {
        panel = document.createElement("aside");
        panel.id = "xis-author-download";
        panel.lang = "zh-CN";
        panel.setAttribute("aria-labelledby", "xis-author-title");
        const title = document.createElement("h2");
        title.id = "xis-author-title";
        typePicker = document.createElement("fieldset");
        typePicker.className = "xis-media-picker";
        const legend = document.createElement("legend");
        legend.textContent = "批量下载类型";
        typePicker.append(legend);
        for (const [value, text] of [["image", "图片"], ["video", "视频"]]) {
          const label = document.createElement("label");
          const input = document.createElement("input");
          input.type = "radio";
          input.name = "xis-media-type";
          input.id = `xis-media-${value}`;
          input.value = value;
          input.checked = mediaType === value;
          label.htmlFor = input.id;
          label.append(input, document.createTextNode(text));
          input.addEventListener("change", () => {
            if (running || !input.checked) return;
            mediaType = value;
            fastSaved.clear();
            historyAuthor = undefined;
            sync();
          });
          typePicker.append(label);
        }
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
        help = document.createElement("p");
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
        panel.append(title, typePicker, help, historyStatus, status, positionLabel, details, actions);
        document.body.append(panel);
      }
      if (!panel) return;
      panel.hidden = !isProfile && !running;
      if (!running) queueMarker();
      if (isProfile && historyAuthor !== target.author.toLowerCase()) {
        historyAuthor = target.author.toLowerCase();
        historyStatus.textContent = "正在读取历史记录…";
        void refreshHistory(target.author);
      }
      if (panel.hidden) queueMarker();
      if (!running && target) {
        const label = `@${target.author} 的${kind()}`;
        if (panel.querySelector("h2").textContent !== label) {
          fastSaved.clear();
          activePhoto = undefined;
          positionLabel.hidden = true;
          details.textContent = "";
          queueMarker();
          panel.querySelector("h2").textContent = label;
          status.textContent = `从当前位置向下滚动收集${mediaType === "video" ? "最高码率 MP4（含 GIF 动画）" : "原图"}，已存${kind()}自动跳过。请保持本页打开；需要从头收集时请先回到页首。`;
          startButton.textContent = `下载此作者${kind()}`;
          help.textContent = `可先手动滚动，再从当前位置快速定位；批量跳过已保存的${kind()}，遇到未保存的${kind()}自动开始下载。`;
          historyStatus.title = `当前作者、当前${kind()}保存目录的成功记录；文件删除后仍计入。历史帖子数按成功保存文件的帖子 ID 统计。`;
        }
      }
      if (isProfile && onMediaPage() && !running) {
        try {
          const intent = JSON.parse(sessionStorage.getItem(INTENT) || "null");
          if (intent) sessionStorage.removeItem(INTENT);
          if (intent?.expires > Date.now() && intent.author.toLowerCase() === target.author.toLowerCase() && (intent.mediaType || "image") === mediaType) void start(intent.mode === "locate" ? "locate" : "download");
        } catch { /* No pending click to resume. */ }
      }
    }
    window.addEventListener("message", event => {
      if (event.source === window && event.origin === location.origin && event.data?.type === "XIS_TIMELINE_STATUS" && event.data.path === location.pathname && event.data.search === location.search) {
        const incoming = event.data;
        if (!Number.isSafeInteger(incoming.requestId) || !Number.isFinite(incoming.observedAt) || Date.now() - incoming.observedAt > 120000) return;
        const state = { ...incoming, error: typeof incoming.error === "string" ? incoming.error.slice(0, 400) : null };
        // Once seen during a task, retain the failure even if another request
        // succeeds while the current post is finishing. Only a retry clears it.
        if (running && state.error && state.requestId !== consumedTimelineError && !timelineFailure) timelineFailure = state;
        if (timelineState?.path === state.path && timelineState.search === state.search && timelineState.requestId > state.requestId) return;
        timelineState = state;
      }
      if (event.source !== window || event.origin !== location.origin || !["XIS_PHOTO_DATA", "XIS_AUTHOR_VIDEO_DATA"].includes(event.data?.type) || !Array.isArray(event.data.items)) return;
      const video = event.data.type === "XIS_AUTHOR_VIDEO_DATA";
      const targetCache = video ? videoCache : cache, sources = video ? "videos" : "images";
      for (const post of event.data.items.slice(0, 500)) {
        if (typeof post?.author === "string" && /^[A-Za-z0-9_]{1,15}$/.test(post.author) && /^\d{1,30}$/.test(post.postId) && Array.isArray(post[sources]) && post[sources].length <= 20) targetCache.set(post.postId, post);
      }
      while (targetCache.size > 500) targetCache.delete(targetCache.keys().next().value);
      if (!running) queueMarker();
    });
    let scheduled = false;
    new MutationObserver(records => {
      if (records.every(record => panel?.contains(record.target) || record.target === panel || marker?.contains(record.target) || record.target === marker || [...record.addedNodes].every(node => node === marker) && record.addedNodes.length)) return;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; sync(); });
      queueMarker();
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
