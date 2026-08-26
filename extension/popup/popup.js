import { BRIDGE_URL_KEY, DEFAULT_BRIDGE_URL } from "../lib/ws-transport.js";
import { readStatus, subscribeStatus } from "./status-store.js";

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const urlInput = document.getElementById("url-input");
const saveBtn = document.getElementById("save-btn");
const instanceIdEl = document.getElementById("instance-id");
const reconnectBtn = document.getElementById("reconnect-btn");

function stateLabel(state) {
  switch (state) {
    case "connected": return { color: "#22c55e", text: "已连接" };
    case "reconnecting": return { color: "#f59e0b", text: "重连中…" };
    default: return { color: "#9ca3af", text: "未连接" };
  }
}

function renderStatus(status) {
  if (!status) {
    statusDot.style.background = "#9ca3af";
    statusText.textContent = "未知";
    return;
  }
  const { color, text } = stateLabel(status.state);
  statusDot.style.background = color;
  statusText.textContent = `${text} · 重连次数 ${status.reconnectAttempt ?? 0}`;
}

async function init() {
  const status = await readStatus();
  renderStatus(status);
  subscribeStatus(renderStatus);

  const stored = await chrome.storage.local.get(BRIDGE_URL_KEY);
  urlInput.value = stored[BRIDGE_URL_KEY] ?? DEFAULT_BRIDGE_URL;

  const idStored = await chrome.storage.local.get("extensionInstanceId");
  instanceIdEl.textContent = idStored.extensionInstanceId ?? "—";

  const versionEl = document.getElementById("extension-version");
  if (versionEl) {
    const manifest = chrome.runtime.getManifest?.() || {};
    versionEl.textContent = manifest.version ? `v${manifest.version}` : "—";
  }

  saveBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    await chrome.storage.local.set({ [BRIDGE_URL_KEY]: url });
    saveBtn.textContent = "已保存";
    setTimeout(() => { saveBtn.textContent = "保存并重连"; }, 1200);
  });

  reconnectBtn.addEventListener("click", () => {
    // 改一下再改回,触发 storage 变化 → 重连。简化:reload SW。
    chrome.runtime.reload();
  });
}

init();
