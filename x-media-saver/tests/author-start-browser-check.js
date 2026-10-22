(async () => {
  const checks = [];
  const assert = (value, name) => { if (!value) throw new Error(name); checks.push(name); };
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for author task");
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  history.replaceState(null, "", "/artist_one/media?filter=photo");
  document.querySelector("h1").setAttribute("data-testid", "UserName");
  const timeline = document.getElementById("timeline");
  timeline.innerHTML = '<a id="start-top" href="/artist_one/status/300/photo/1" style="display:block;height:140px">最新图片</a><div style="height:1400px"></div><a id="start-middle" href="/artist_one/status/200/photo/1" style="display:block;height:140px">当前位置图片</a><div style="height:1400px"></div><a id="start-old" href="/artist_one/status/100/photo/1" style="display:block;height:140px">旧图片</a><div style="height:1400px"></div>';
  // Older metadata arrived first; returning to the top does not reorder a Map.
  window.postMessage({ type: "XIS_PHOTO_DATA", items: [100, 300, 200].map(id => ({
    author: "artist_one", postId: String(id), images: [`https://pbs.twimg.com/media/Start${id}.jpg`]
  })) }, location.origin);
  await until(() => document.getElementById("xis-author-download"));
  const panel = document.getElementById("xis-author-download");
  const [start, fast, stop] = panel.querySelectorAll("button");
  const top = document.getElementById("start-top"), middle = document.getElementById("start-middle");
  const finish = async () => {
    stop.click();
    fixture.statusMode = "complete";
    await until(() => !start.disabled);
  };
  const begin = async (button, expected, name) => {
    fixture.statusMode = "pending";
    const before = fixture.calls.length;
    button.click();
    await until(() => fixture.calls.slice(before).some(call => call.type === "XIS_DOWNLOAD_POST"));
    const calls = fixture.calls.slice(before);
    const first = calls.find(call => call.type === "XIS_DOWNLOAD_POST").post.postId;
    await finish();
    assert(first === expected, `${name}: expected ${expected}, got ${first}`);
    return calls;
  };
  middle.scrollIntoView({ block: "center", behavior: "instant" });
  await begin(start, "200", "Normal download starts at the current row despite older cache entries");
  top.scrollIntoView({ block: "center", behavior: "instant" });
  await begin(start, "300", "Returning to the top resets the normal download starting position");
  middle.scrollIntoView({ block: "center", behavior: "instant" });
  top.scrollIntoView({ block: "center", behavior: "instant" });
  const calls = await begin(fast, "300", "Fast location also starts at the top after scrolling back");
  const ids = calls.find(call => call.type === "XIS_PHOTO_HISTORY").posts.map(post => post.postId);
  assert(ids.join(",") === "300,200,100", "Cached posts follow newest-to-oldest timeline order");
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
  const before = fixture.calls.length;
  start.click();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert(!start.disabled && panel.innerText.includes("当前位置没有已加载的图片") && !fixture.calls.slice(before).some(call => call.type === "XIS_DOWNLOAD_POST"), "Normal download does not fall back to old cache when the current position has no loaded tiles");
  return { passed: checks.length, checks };
})();
