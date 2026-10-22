(async () => {
  const checks = [];
  const assert = (value, name) => { if (!value) throw new Error(name); checks.push(name); };
  const until = async predicate => {
    const deadline = Date.now() + 6000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for start preview");
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  history.replaceState(null, "", "/artist_one/media?filter=photo");
  document.querySelector("h1").setAttribute("data-testid", "UserName");
  const timeline = document.querySelector("#timeline");
  const row = (id, newer) => `<div style="display:flex;height:140px"><a id="preview-${id}" href="/artist_one/status/${id}/photo/1" style="flex:1">${id}</a>${newer ? `<a id="preview-${newer}" href="/artist_one/status/${newer}/photo/1" style="flex:1">${newer}</a>` : ""}</div>`;
  timeline.innerHTML = row(300, 301) + '<div style="height:1400px"></div>' + row(200) + '<div style="height:1400px"></div>' + row(100) + '<div id="preview-space" style="height:1400px"></div>';
  window.postMessage({ type: "XIS_PHOTO_DATA", items: [100, 200, 300, 301].map(id => ({ author: "artist_one", postId: String(id), images: [`https://pbs.twimg.com/media/Preview${id}.jpg`] })) }, location.origin);
  await until(() => document.querySelector("#xis-author-download"));
  const panel = document.querySelector("#xis-author-download");
  const [start, fast, stop] = panel.querySelectorAll("button");
  const label = panel.querySelector(".xis-current-position");
  const box = () => document.querySelector("#xis-photo-marker .xis-start-box");
  const top = document.querySelector("#preview-301"), middle = document.querySelector("#preview-200");
  const totalDownloads = () => fixture.calls.filter(call => call.type === "XIS_DOWNLOAD_POST").length;
  top.scrollIntoView({ block: "center", behavior: "instant" });
  await until(() => box()?.dataset.postId === "301");
  assert(box().textContent === "从这里开始" && label.href.endsWith("/301"), "The first row previews the newest post even when DOM order differs");
  const r = top.getBoundingClientRect(), b = box().getBoundingClientRect();
  assert(Math.abs(r.top - b.top) < 2 && Math.abs(r.width - b.width) < 2, "The preview border matches the actual media tile");
  const previewY = scrollY;
  const beforePreview = fixture.calls.length;
  for (const tile of [middle, top, middle]) { tile.scrollIntoView({ block: "center", behavior: "instant" }); await settle(); }
  await until(() => box()?.dataset.postId === "200");
  const middleY = scrollY;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert(scrollY === middleY && middleY > previewY, "Manual scrolling moves the preview without pulling the page back");
  assert(!fixture.calls.slice(beforePreview).some(call => ["XIS_PHOTO_HISTORY", "XIS_VIDEO_HISTORY", "XIS_DOWNLOAD_POST", "XIS_JOB_STATUS"].includes(call.type)), "Idle previews create no downloads or deduplication queries");
  assert(getComputedStyle(document.querySelector("#xis-photo-marker")).pointerEvents === "none", "The preview overlay leaves page clicks available");
  for (const button of [start, fast]) {
    fixture.statusMode = "pending";
    const expected = box().dataset.postId, before = totalDownloads();
    button.click();
    await until(() => totalDownloads() > before);
    const first = fixture.calls.filter(call => call.type === "XIS_DOWNLOAD_POST").at(-1).post.postId;
    await until(() => document.querySelector(".xis-photo-box:not(.xis-start-box)"));
    assert(first === expected && !box(), `${button === start ? "Normal" : "Fast"} downloading starts at the preview and switches to the processing marker`);
    stop.click(); fixture.statusMode = "complete";
    await until(() => !start.disabled);
    await until(() => box()?.dataset.postId === "200");
  }
  window.scrollTo({ top: window.scrollY + middle.getBoundingClientRect().top - 50, behavior: "instant" });
  await until(() => box()?.dataset.postId === "200"); await settle();
  assert(box().querySelector("span").getBoundingClientRect().top >= 95, "The start label remains visible beneath sticky navigation on a partial row");
  window.scrollTo({ top: window.scrollY + middle.getBoundingClientRect().bottom - 95, behavior: "instant" });
  await settle();
  assert(!box() && label.textContent.includes("起点在下方"), "A row hidden by the sticky header is excluded and an offscreen next row has no false border");
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
  await settle();
  assert(!box() && label.hidden, "No loaded start tile clears the old border and position link");
  timeline.insertAdjacentHTML("beforeend", row(50));
  document.querySelector("#preview-50").scrollIntoView({ block: "center", behavior: "instant" });
  await until(() => box()?.dataset.postId === "50");
  assert(label.textContent.includes("50"), "Newly loaded or recycled tiles update the idle preview");
  timeline.innerHTML = `<article data-testid="tweet"><div data-testid="User-Name"><a href="https://x.com/artist_one/status/40"><time>video</time></a></div><div data-testid="videoPlayer" style="height:180px">Video</div></article>`;
  window.postMessage({ type: "XIS_AUTHOR_VIDEO_DATA", items: [{ author: "artist_one", postId: "40", videos: ["https://video.twimg.com/tweet_video/Preview40.mp4"] }] }, location.origin);
  history.replaceState(null, "", "/artist_one/media");
  window.dispatchEvent(new PopStateEvent("popstate")); window.scrollTo(0, 0);
  await until(() => box()?.dataset.postId === "40");
  assert(panel.querySelector('input[value="video"]').checked, "Video articles preview the same starting post after switching media routes");
  history.replaceState(null, "", "/artist_one"); window.dispatchEvent(new PopStateEvent("popstate"));
  await settle();
  assert(!box() && label.hidden, "The author's home page does not retain a stale media start preview");
  history.replaceState(null, "", "/home"); window.dispatchEvent(new PopStateEvent("popstate"));
  await settle();
  assert(!box() && panel.hidden, "Leaving the author media page clears the preview");
  return { passed: checks.length, checks };
})();
