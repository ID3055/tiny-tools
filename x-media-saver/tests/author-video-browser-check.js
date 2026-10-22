(async () => {
  const checks = [];
  const assert = (value, name) => { if (!value) throw new Error(name); checks.push(name); };
  const until = async predicate => {
    const deadline = Date.now() + 6000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for video batch");
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  history.replaceState(null, "", "/artist_one/media");
  document.querySelector("h1").setAttribute("data-testid", "UserName");
  const timeline = document.getElementById("timeline");
  const article = id => `<article data-testid="tweet"><a href="https://x.com/artist_one/status/${id}"><time>发布时间</time></a><div data-testid="${id === 300 ? "sensitive-media" : "videoPlayer"}" id="video-${id}" style="height:180px;background:#456">视频 ${id}</div><div role="group"><button data-testid="reply">评论</button></div></article>`;
  timeline.innerHTML = article(300) + '<div style="height:1200px"></div>' + article(200) + '<div style="height:1200px"></div>' + article(100) + '<div style="height:1500px"></div>';
  const values = [100, 300, 200].map(id => ({ author: "artist_one", postId: String(id), videos: Array.from({ length: id === 200 ? 2 : 1 }, (_, index) => `https://video.twimg.com/tweet_video/Video${id}_${index}.mp4`) }));
  values.push({ author: "other_author", postId: "999", videos: ["https://video.twimg.com/tweet_video/Other.mp4"] });
  window.postMessage({ type: "XIS_VIDEO_DATA", items: values }, location.origin);
  window.postMessage({ type: "XIS_AUTHOR_VIDEO_DATA", items: values }, location.origin);
  await until(() => document.getElementById("xis-author-download"));
  const panel = document.getElementById("xis-author-download");
  panel.querySelector('input[value="video"]').click();
  const [start, fast, stop] = panel.querySelectorAll("button");
  const status = panel.querySelector('[role="status"]'), historyStatus = panel.querySelector(".xis-history-summary");
  await until(() => historyStatus.textContent.includes("4 帖 · 6 个视频"));
  assert(start.textContent === "下载此作者视频" && panel.querySelector("h2").textContent.includes("视频"), "Video selection exposes the author video action and historical video totals");
  const finish = async () => {
    stop.click();
    fixture.statusMode = "complete";
    await until(() => !start.disabled);
  };
  const top = document.getElementById("video-300"), middle = document.getElementById("video-200");
  fixture.statusMode = "pending";
  middle.scrollIntoView({ block: "center", behavior: "instant" });
  const position = scrollY, before = fixture.calls.length;
  start.click();
  await until(() => fixture.calls.slice(before).some(call => call.type === "XIS_JOB_STATUS"));
  const posts = fixture.calls.slice(before).filter(call => call.type === "XIS_DOWNLOAD_POST");
  assert(posts.length === 1 && posts[0].post.postId === "200" && posts[0].post.images.length === 0 && posts[0].post.videos.length === 2, "Normal video downloading starts at the current article and excludes images, newer cache and other authors");
  assert(scrollY === position && panel.querySelector("fieldset").disabled, "Starting at a visible video preserves position and locks the media selection");
  await until(() => document.querySelector("#xis-photo-marker .xis-photo-box"));
  assert(Math.abs(document.querySelector(".xis-photo-box").getBoundingClientRect().top - middle.getBoundingClientRect().top) < 2, "The processing marker follows the video player without needing a video permalink");
  await finish();
  assert(status.textContent.includes("本次处理 1 帖") && status.textContent.includes("保存 2 个视频") && fixture.calls.slice(before).filter(call => call.type === "XIS_DOWNLOAD_POST").length === 1, "Stop finishes the in-flight video post and starts no later posts");
  fixture.savedVideoPosts.add("300");
  const sendMessage = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = async message => {
    const response = await sendMessage(message);
    if (message.type === "XIS_VIDEO_HISTORY") {
      for (const item of response.items) if (item.postId === "200") item.saved = 1;
    }
    if (message.type === "XIS_JOB_STATUS" && !response.pending) Object.assign(response, { complete: 1, skipped: 1 });
    return response;
  };
  fixture.statusMode = "pending";
  top.scrollIntoView({ block: "center", behavior: "instant" });
  const beforeFast = fixture.calls.length;
  fast.click();
  await until(() => fixture.calls.slice(beforeFast).some(call => call.type === "XIS_JOB_STATUS"));
  const calls = fixture.calls.slice(beforeFast);
  assert(calls.find(call => call.type === "XIS_VIDEO_HISTORY").posts[0].postId === "300", "A sensitive-content warning does not exclude an MP4 already supplied by the timeline");
  assert(calls.filter(call => call.type === "XIS_VIDEO_HISTORY").length === 1 && !calls.some(call => call.type === "XIS_PHOTO_HISTORY"), "Fast video location queries video history in a single batch");
  assert(calls.filter(call => call.type === "XIS_DOWNLOAD_POST").map(call => call.post.postId).join() === "200", "Fast mode skips a saved video post and downloads the partial post automatically");
  assert(status.textContent.includes("本次处理 2 帖") && status.textContent.includes("发现 3 个视频") && status.textContent.includes("跳过 2 个视频"), "Fast-to-normal transition preserves video and post counts");
  await finish();
  assert(status.textContent.includes("保存 1 个视频") && status.textContent.includes("跳过 2 个视频"), "Partial video completion does not double-count the saved boundary video");
  chrome.runtime.sendMessage = async message => {
    const response = await sendMessage(message);
    if (message.type === "XIS_JOB_STATUS" && !response.pending) Object.assign(response, { complete: 0, skipped: 0, failed: 2, error: "媒体读取失败（HTTP 429）。" });
    return response;
  };
  middle.scrollIntoView({ block: "center", behavior: "instant" });
  fixture.statusMode = "complete";
  start.click();
  await until(() => !start.disabled);
  assert(status.textContent.includes("失败 2 个视频") && panel.querySelector(".xis-error-detail").textContent.includes("HTTP 429"), "Video failures retain a concrete error and stop on rate limits");
  chrome.runtime.sendMessage = sendMessage;
  history.replaceState(null, "", "/artist_one/media?filter=photo");
  panel.querySelector('input[value="image"]').click();
  await until(() => historyStatus.textContent.includes("7 帖 · 12 张"));
  assert(start.textContent === "下载此作者图片" && !panel.querySelector("fieldset").disabled, "Switching back restores the independent image action and history");
  history.replaceState(null, "", "/artist_one/media");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await until(() => historyStatus.textContent.includes("4 帖 · 6 个视频"));
  assert(panel.querySelector('input[value="video"]').checked && start.textContent === "下载此作者视频", "Navigating to X's video filter automatically selects the matching batch type");
  return { passed: checks.length, checks };
})();
