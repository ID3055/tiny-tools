(async () => {
  const checks = [];
  const assert = (value, name) => { if (!value) throw new Error(name); checks.push(name); };
  const until = async predicate => {
    const deadline = Date.now() + 6000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Timed out: current photo did not enter the viewport");
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  history.replaceState(null, "", "/artist_one/media?filter=photo");
  document.querySelector("h1").setAttribute("data-testid", "UserName");
  const timeline = document.getElementById("timeline");
  timeline.innerHTML = '<a id="follow-first" href="/artist_one/status/900/photo/1" style="display:block;height:100px">第一张图片</a><div style="height:1400px"></div><a id="follow-next" href="/artist_one/status/899/photo/1" style="display:block;height:100px">下一张图片</a><div style="height:1800px"></div>';
  window.postMessage({ type: "XIS_PHOTO_DATA", items: [
    { author: "artist_one", postId: "900", images: ["https://pbs.twimg.com/media/FollowFirst.jpg"] },
    { author: "artist_one", postId: "899", images: ["https://pbs.twimg.com/media/FollowNext.jpg"] }
  ] }, location.origin);
  await until(() => document.getElementById("xis-author-download"));
  const panel = document.getElementById("xis-author-download");
  const [start, fast, stop] = panel.querySelectorAll("button");
  const first = document.getElementById("follow-first"), next = document.getElementById("follow-next");
  const visible = tile => { const r = tile.getBoundingClientRect(); return r.top >= 90 && r.bottom <= innerHeight - 20; };
  fixture.statusMode = "pending";
  const sendMessage = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = async message => {
    if (message.type === "XIS_DOWNLOAD_POST") fixture.statusMode = "pending";
    return sendMessage(message);
  };
  first.scrollIntoView({ block: "center", behavior: "instant" });
  const initialY = scrollY;
  start.click();
  await until(() => fixture.calls.some(call => call.type === "XIS_JOB_STATUS"));
  assert(scrollY === initialY, "An already visible starting photo does not cause a jump");
  fixture.statusMode = "complete";
  await until(() => fixture.calls.some(call => call.type === "XIS_DOWNLOAD_POST" && call.post.postId === "899"));
  await until(() => visible(next));
  assert(scrollY > initialY, "Downloading the next cached post scrolls its photo into view before the whole batch finishes");
  await until(() => document.querySelector("#xis-photo-marker .xis-photo-box"));
  assert(Math.abs(document.querySelector(".xis-photo-box").getBoundingClientRect().top - next.getBoundingClientRect().top) < 2, "The border follows the photo after automatic scrolling");
  window.scrollBy({ top: 100, behavior: "instant" });
  const manualY = scrollY;
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert(scrollY === manualY, "Repeated status polls for the same photo do not undo manual scrolling");
  stop.click();
  fixture.statusMode = "complete";
  await until(() => !start.disabled);
  assert(scrollY === manualY, "Stopping preserves the current scroll position");
  chrome.runtime.sendMessage = sendMessage;
  fixture.savedPhotoPosts.add("900");
  fixture.savedPhotoPosts.add("899");
  first.scrollIntoView({ block: "center", behavior: "instant" });
  const beforeFast = fixture.calls.length;
  // Suppress the existing page-at-a-time advance: this assertion must prove
  // that the current-photo follower itself brings the checked tile into view.
  const scrollBy = window.scrollBy;
  window.scrollBy = () => {};
  fast.click();
  await until(() => visible(next));
  window.scrollBy = scrollBy;
  assert(fixture.calls.slice(beforeFast).filter(call => call.type === "XIS_PHOTO_HISTORY").length === 1, "Fast mode follows the end of the checked batch with a single history query");
  assert(!fixture.calls.slice(beforeFast).some(call => call.type === "XIS_DOWNLOAD_POST"), "Following saved photos in fast mode creates no downloads");
  stop.click();
  await until(() => !fast.disabled);
  return { passed: checks.length, checks };
})();
