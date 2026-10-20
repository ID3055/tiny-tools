(() => {
  "use strict";
  const { collectPost, actionBar } = globalThis.XImageSaverCollector;
  const states = new Map();
  const buttons = new WeakMap();
  const historyChecked = new Map();
  const videoData = new Map();
  const readPost = article => collectPost(article, videoData);
  const mediaCount = post => post.images.length + (post.videos?.length || 0);
  const mediaLabel = post => [post.images.length ? `${post.images.length} 张原图` : "", post.videos?.length ? `${post.videos.length} 个视频` : ""].filter(Boolean).join("、");
  const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>';
  const COMPLETE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
  let toastTimer;

  function announce(message, error = false) {
    let toast = document.getElementById("xis-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "xis-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.append(toast);
    }
    toast.textContent = message;
    toast.dataset.error = String(error);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 5500);
  }

  function renderButton(button, post) {
    const state = states.get(post.postId);
    const busy = state?.status === "busy";
    const done = state?.status === "done";
    const failed = state?.status === "error";
    const label = busy ? "正在校验并保存媒体" : done ? "已下载过，普通点击跳过" : failed ? "保存失败，点击重试" : `保存本帖 ${mediaLabel(post)}`;
    button.disabled = busy;
    button.dataset.state = state?.status || "idle";
    button.title = `${label}；按住 Shift 点击可强制重新下载`;
    button.setAttribute("aria-label", button.title);
    const markup = `${done ? COMPLETE_ICON : DOWNLOAD_ICON}<span class="xis-count">${mediaCount(post)}</span>`;
    if (button.innerHTML !== markup) button.innerHTML = markup;
  }

  async function send(message) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.ok) throw new Error(response?.error || "扩展未响应，请刷新页面后重试。");
      return response;
    } catch (error) {
      if (/context invalidated|receiving end|message port/i.test(error.message)) {
        throw new Error("扩展已更新，请刷新 X 页面后重试。");
      }
      throw error;
    }
  }

  function refresh(postId) {
    for (const button of document.querySelectorAll(".xis-save")) {
      const post = buttons.get(button);
      if (post?.postId === postId) renderButton(button, post);
    }
  }

  async function save(post, force = false) {
    if (states.get(post.postId)?.status === "busy") return;
    states.set(post.postId, { status: "busy" });
    refresh(post.postId);
    try {
      const started = await send({ type: "XIS_DOWNLOAD_POST", post, force });
      announce(`正在校验并保存 @${post.author} 的 ${mediaLabel(post)}…`);
      const deadline = Date.now() + 30 * 60 * 1000;
      let result;
      do {
        result = await send({ type: "XIS_JOB_STATUS", jobId: started.jobId });
        if (!result.pending) break;
        if (Date.now() >= deadline) throw new Error("下载仍未完成，请在浏览器下载记录中查看进度。");
        await new Promise(resolve => setTimeout(resolve, 1000));
      } while (true);
      if (result.failed) throw new Error(`已保存 ${result.complete} 个，跳过 ${result.skipped} 个重复文件，${result.failed} 个失败。${result.error || "请检查下载记录后重试。"}`);
      states.set(post.postId, { status: "done" });
      announce(result.skipped === started.total ? `全部 ${result.skipped} 个文件已下载过，已跳过；按住 Shift 点击可强制重新下载` : `已保存 ${result.complete} 个文件${result.skipped ? `，跳过 ${result.skipped} 个重复文件` : ""}，图片与视频已分文件夹归档`);
    } catch (error) {
      states.set(post.postId, { status: "error" });
      announce(error.message || "保存失败，请重试。", true);
    } finally {
      refresh(post.postId);
      // Keep recent feedback without retaining the entire timeline indefinitely.
      if (states.size > 500) {
        for (const [id, state] of states) {
          if (state.status !== "busy") states.delete(id);
          if (states.size <= 400) break;
        }
      }
    }
  }

  function checkHistory(post) {
    const signature = JSON.stringify(post);
    if (historyChecked.get(post.postId) === signature || states.get(post.postId)?.status === "busy") return;
    historyChecked.set(post.postId, signature);
    const before = states.get(post.postId);
    void send({ type: "XIS_POST_STATUS", post }).then(result => {
      if (historyChecked.get(post.postId) !== signature || states.get(post.postId) !== before) return;
      states.set(post.postId, { status: result.saved === result.total ? "done" : "idle" });
      refresh(post.postId);
    }).catch(() => { historyChecked.delete(post.postId); });
    if (historyChecked.size > 500) historyChecked.delete(historyChecked.keys().next().value);
  }

  function updateArticle(article) {
    const post = readPost(article);
    const bar = actionBar(article);
    const existing = [...article.querySelectorAll(".xis-save")].find(button => button.closest('article[data-testid="tweet"]') === article);
    if (!post || !bar) {
      existing?.parentElement.remove();
      return;
    }
    let button = existing;
    if (!button) {
      const wrapper = document.createElement("div");
      wrapper.className = "xis-action";
      button = document.createElement("button");
      button.type = "button";
      button.className = "xis-save";
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        // X recycles timeline DOM; always read the current post at click time.
        const currentArticle = button.closest('article[data-testid="tweet"]');
        const current = currentArticle && readPost(currentArticle);
        if (current) void save(current, event.shiftKey);
        else announce("图片还未加载，请稍后重试。", true);
      });
      wrapper.append(button);
      bar.append(wrapper);
    } else if (button.parentElement.parentElement !== bar) {
      bar.append(button.parentElement);
    }
    buttons.set(button, post);
    renderButton(button, post);
    checkHistory(post);
  }

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes.rootFolder) return;
    historyChecked.clear();
    document.querySelectorAll('article[data-testid="tweet"]').forEach(queue);
  });

  const pending = new Set();
  let scheduled = false;
  function queue(article) {
    pending.add(article);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      for (const item of pending) if (item.isConnected) updateArticle(item);
      pending.clear();
    });
  }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      if (!target || target.closest(".xis-action, #xis-toast")) continue;
      const article = target.closest('article[data-testid="tweet"]');
      if (article) queue(article);
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE || node.matches(".xis-action, #xis-toast")) continue;
        if (node.matches('article[data-testid="tweet"]')) queue(node);
        node.querySelectorAll('article[data-testid="tweet"]').forEach(queue);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset", "href", "data-testid"] });
  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== "XIS_VIDEO_DATA" || !Array.isArray(event.data.items)) return;
    for (const item of event.data.items.slice(0, 500)) {
      if (/^\d{1,30}$/.test(item?.postId) && Array.isArray(item.videos) && item.videos.length <= 20) videoData.set(String(item.postId), item.videos);
    }
    while (videoData.size > 500) videoData.delete(videoData.keys().next().value);
    document.querySelectorAll('article[data-testid="tweet"]').forEach(queue);
  });
  window.postMessage({ type: "XIS_REQUEST_VIDEO_CACHE" }, location.origin);
  document.querySelectorAll('article[data-testid="tweet"]').forEach(queue);
})();
