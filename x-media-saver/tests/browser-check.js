// Run against tests/fixture.html with: agent-browser eval --stdin < tests/browser-check.js
(async () => {
  const passed = [];
  const assert = (condition, name) => { if (!condition) throw new Error(name); passed.push(name); };
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const until = async predicate => {
    const deadline = Date.now() + 6000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for UI state");
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  await frame();
  const first = document.querySelector("#post-111");
  const button = first.querySelector(".xis-save");
  assert(document.querySelectorAll(".xis-save").length === 2, "Only posts with their own photos receive buttons");
  assert(button.getAttribute("aria-label").includes("2 张"), "Button announces the full image count");
  const quoted = XImageSaverCollector.collectPost(document.querySelector("#post-222"));
  assert(quoted.images.length === 1 && quoted.images[0].includes("FixtureC"), "Quoted photos are excluded");
  assert(!document.querySelector("#post-444 .xis-save"), "Video posters are excluded");
  assert(!document.querySelector("#post-555 .xis-save"), "Quote-only posts are excluded");

  await until(() => document.querySelector("#post-222 .xis-save").dataset.state === "done");
  assert(document.querySelector("#post-222 .xis-save").title.includes("Shift"), "Persisted history restores the saved badge and explains force download");
  fixture.statusMode = "pending";
  button.click();
  button.click();
  await until(() => fixture.statusPolls > 0);
  assert(button.disabled && button.dataset.state === "busy", "Button stays busy while downloads are pending");
  assert(fixture.calls.filter(call => call.type === "XIS_DOWNLOAD_POST").length === 1, "Repeated clicks do not start duplicate downloads");
  const request = fixture.calls.find(call => call.type === "XIS_DOWNLOAD_POST").post;
  assert(request.author === "artist_one" && request.postId === "111" && request.images.length === 2, "Download is scoped to the selected post and author");
  assert(request.images.every(url => url.includes("name=orig")), "Downloads request original resolution");
  fixture.statusMode = "complete";
  await until(() => button.dataset.state === "done");
  assert(!button.disabled && document.querySelector("#xis-toast").textContent.includes("已保存 2 个"), "Success appears only after download completion");

  fixture.skipNext = true;
  button.click();
  await until(() => button.dataset.state === "done");
  assert(document.querySelector("#xis-toast").textContent.includes("全部 2 个文件已下载过"), "All-duplicate posts report skipped files as success");

  button.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  await until(() => button.dataset.state === "done");
  assert(fixture.calls.filter(call => call.type === "XIS_DOWNLOAD_POST").at(-1).force === true, "Shift-click explicitly requests a forced download");

  document.querySelector("#fail").click();
  button.click();
  await until(() => button.dataset.state === "error");
  assert(!button.disabled && document.querySelector("#xis-toast").dataset.error === "true", "Interrupted downloads show an error and allow retry");

  const videoUrl = "https://video.twimg.com/ext_tw_video/444/pu/vid/avc1/720x1280/test.mp4";
  window.postMessage({ type: "XIS_VIDEO_DATA", items: [{ postId: "444", videos: [videoUrl] }] }, location.origin);
  await until(() => document.querySelector("#post-444 .xis-save"));
  const videoButton = document.querySelector("#post-444 .xis-save");
  assert(videoButton.getAttribute("aria-label").includes("1 个视频"), "Video metadata adds a save button without treating its poster as a photo");
  videoButton.click();
  await until(() => videoButton.dataset.state === "done");
  const videoPost = fixture.calls.filter(call => call.type === "XIS_DOWNLOAD_POST").at(-1).post;
  assert(videoPost.images.length === 0 && videoPost.videos[0] === videoUrl, "Video save requests contain the MP4 and exclude the video poster");

  document.querySelector("#append").click();
  await frame();
  assert(document.querySelectorAll(".xis-save").length === 4, "Dynamically loaded posts receive buttons");
  document.querySelector("#recycle").click();
  await frame();
  assert(first.querySelectorAll(".xis-save").length === 1, "Recycled timeline DOM keeps exactly one button");
  assert(button.getAttribute("aria-label").includes("1 张"), "Image count refreshes when the post changes");
  button.click();
  await until(() => button.dataset.state === "done");
  const lastPost = fixture.calls.filter(call => call.type === "XIS_DOWNLOAD_POST").at(-1).post;
  assert(lastPost.author === "recycled" && lastPost.postId === "777", "Clicking recycled DOM downloads the current author's post");

  first.querySelector(".photos").replaceChildren();
  await frame();
  assert(!first.querySelector(".xis-save"), "Button is removed when a recycled post has no images");
  return { passed: passed.length, checks: passed };
})();
