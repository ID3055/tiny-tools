(async () => {
  const checks = [];
  const assert = (value, name) => { if (!value) throw new Error(name); checks.push(name); };
  const until = async predicate => {
    const deadline = Date.now() + 6000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for author panel");
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  history.replaceState(null, "", "/artist_one/media?filter=photo");
  document.querySelector("h1").setAttribute("data-testid", "UserName");
  document.querySelector("h1").append(document.createTextNode(" · 作者测试"));
  await until(() => document.querySelector("#xis-author-download"));
  const panel = document.querySelector("#xis-author-download");
  const [start, stop] = panel.querySelectorAll("button");
  assert(panel.querySelector("h2").textContent.includes("@artist_one"), "Profile panel shows the current author");
  const otherBefore = fixture.calls.filter(call => call.type === "XIS_DOWNLOAD_POST").length;
  window.postMessage({ type: "XIS_PHOTO_DATA", items: [
    { author: "artist_one", postId: "888", images: ["https://pbs.twimg.com/media/HiddenOne.jpg", "https://pbs.twimg.com/media/HiddenTwo.jpg"] },
    { author: "other_author", postId: "999", images: ["https://pbs.twimg.com/media/Other.jpg"] }
  ] }, location.origin);
  await new Promise(resolve => setTimeout(resolve, 30));
  fixture.statusMode = "pending";
  start.click();
  await until(() => fixture.calls.filter(call => call.type === "XIS_DOWNLOAD_POST").length > otherBefore);
  assert(start.disabled && !stop.hidden, "Batch task disables repeated starts and exposes Stop");
  const first = fixture.calls.filter(call => call.type === "XIS_DOWNLOAD_POST").at(-1).post;
  assert(first.postId === "888" && first.images.length === 2 && first.videos.length === 0, "All photos are collected from metadata without needing a visible article");
  stop.click();
  assert(stop.disabled, "Stop immediately prevents another stop request");
  fixture.statusMode = "complete";
  await until(() => !start.disabled);
  assert(panel.querySelector("p").textContent.includes("保存 2") && panel.querySelector("p").textContent.includes("已停止"), "Stopped task reports completed in-flight photos");
  assert(fixture.calls.filter(call => call.type === "XIS_DOWNLOAD_POST").length === otherBefore + 1, "Stop starts no further posts and other authors remain excluded");
  history.replaceState(null, "", "/home");
  window.dispatchEvent(new PopStateEvent("popstate"));
  assert(panel.hidden, "Panel hides when leaving an author profile");
  return { passed: checks.length, checks };
})();
