"use strict";
const { normalizeFolder } = globalThis.XImageSaverCore;
const folder = document.getElementById("folder");
const status = document.getElementById("status");
const saveButton = document.getElementById("save-settings");

function preview() {
  const prefix = folder.value.trim().replace(/\\/g, "/");
  document.getElementById("path-preview").textContent = `${prefix ? prefix + "/" : ""}author/{图片, 视频}/发布时间_帖子ID_序号`;
}

function showStatus(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}

saveButton.disabled = true;
chrome.storage.local.get("rootFolder").then(settings => {
  folder.value = settings.rootFolder || "";
  preview();
  saveButton.disabled = false;
}).catch(() => showStatus("读取设置失败，请重新打开扩展。", true));

folder.addEventListener("input", () => { preview(); showStatus(""); });
document.getElementById("settings").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const rootFolder = normalizeFolder(folder.value);
    saveButton.disabled = true;
    await chrome.storage.local.set({ rootFolder });
    folder.value = rootFolder;
    preview();
    showStatus("已保存，下次下载生效。");
  } catch (error) {
    showStatus(error.message || "保存失败，请重试。", true);
  } finally {
    saveButton.disabled = false;
  }
});
document.getElementById("open-downloads").addEventListener("click", () => chrome.downloads.showDefaultFolder());
