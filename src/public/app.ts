// ── Tonglen Clipboard — Frontend ────────────────────────────────
import { createIcons, icons } from "lucide";

// ── Types ────────────────────────────────────────────────────
interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

interface ClipboardEntry {
  text: string;
  from: string;
  fromId: string;
  timestamp: number;
}

interface FileInfo {
  fileId: string;
  fileName: string;
  fileSize: number;
  from: string;
}

// ── State ────────────────────────────────────────────────────
let ws: WebSocket | null = null;
let myPeerId = "";
let currentRoom = "";
let myName = "";
let reconnectAttempts = 0;
let lastClipboardText = "";
let isOwner = false;
const clipboardEntries: ClipboardEntry[] = [];
const sharedFiles: FileInfo[] = [];

// ── DOM Elements ─────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const joinScreen = $<HTMLDivElement>("join-screen");
const mainScreen = $<HTMLDivElement>("main-screen");
const inputName = $<HTMLInputElement>("input-name");
const inputRoom = $<HTMLInputElement>("input-room");
const btnRandomRoom = $<HTMLButtonElement>("btn-random-room");
const btnJoin = $<HTMLButtonElement>("btn-join");
const serverInfo = $<HTMLDivElement>("server-info");
const headerRoom = $<HTMLElement>("header-room");
const headerStatus = $<HTMLElement>("header-status");
const headerPeersCount = $<HTMLElement>("header-peers-count");
const btnCopyLink = $<HTMLButtonElement>("btn-copy-link");
const btnLeave = $<HTMLButtonElement>("btn-leave");
const qrContainer = $<HTMLDivElement>("qr-container");
const shareUrl = $<HTMLElement>("share-url");
const peersList = $<HTMLUListElement>("peers-list");
const clipboardFeed = $<HTMLDivElement>("clipboard-feed");
const toggleWatch = $<HTMLInputElement>("toggle-watch");
const inputText = $<HTMLTextAreaElement>("input-text");
const btnSend = $<HTMLButtonElement>("btn-send");
const dropZone = $<HTMLDivElement>("drop-zone");
const fileInput = $<HTMLInputElement>("file-input");
const fileList = $<HTMLDivElement>("file-list");
const uploadProgress = $<HTMLDivElement>("upload-progress");
const uploadName = $<HTMLElement>("upload-name");
const uploadPct = $<HTMLElement>("upload-pct");
const uploadBar = $<HTMLDivElement>("upload-bar");
const btnMobilePeers = $<HTMLButtonElement>("btn-mobile-peers");
const mobileDrawer = $<HTMLDivElement>("mobile-drawer");
const drawerBackdrop = $<HTMLDivElement>("drawer-backdrop");
const btnCloseDrawer = $<HTMLButtonElement>("btn-close-drawer");
const qrContainerMobile = $<HTMLDivElement>("qr-container-mobile");
const shareUrlMobile = $<HTMLElement>("share-url-mobile");
const peersListMobile = $<HTMLUListElement>("peers-list-mobile");
const fileExpirySelect = $<HTMLSelectElement>("file-expiry");
const expiryLabel = $<HTMLElement>("expiry-label");
const maxUploadSizeSelect = $<HTMLSelectElement>("max-upload-size");
const maxUploadLabel = $<HTMLElement>("max-upload-label");
const settingsOwnerHint = $<HTMLElement>("settings-owner-hint");

// ── Expiry helpers ────────────────────────────────────────────
const EXPIRY_LABELS: Record<string, string> = {
  "1": "1 minute", "5": "5 minutes", "15": "15 minutes",
  "30": "30 minutes", "60": "1 hour", "360": "6 hours",
  "720": "12 hours", "1440": "24 hours",
};

function updateExpiryUI(minutes: number) {
  const val = String(minutes);
  fileExpirySelect.value = val;
  expiryLabel.textContent = EXPIRY_LABELS[val] ?? `${minutes} min`;
}

fileExpirySelect.addEventListener("change", () => {
  const minutes = Number(fileExpirySelect.value);
  sendMsg({ type: "settings", fileExpiryMinutes: minutes });
});

// ── Max upload size helpers ───────────────────────────────────
function updateMaxUploadUI(mb: number) {
  const val = String(mb);
  maxUploadSizeSelect.value = val;
  maxUploadLabel.textContent = mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`;
}

maxUploadSizeSelect.addEventListener("change", () => {
  const mb = Number(maxUploadSizeSelect.value);
  sendMsg({ type: "settings", maxUploadSizeMB: mb });
});

// ── Owner settings toggle ─────────────────────────────────────
function updateSettingsEnabled() {
  fileExpirySelect.disabled = !isOwner;
  maxUploadSizeSelect.disabled = !isOwner;
  const disabledClasses = ["opacity-50", "cursor-not-allowed"];
  for (const el of [fileExpirySelect, maxUploadSizeSelect]) {
    if (isOwner) {
      el.classList.remove(...disabledClasses);
    } else {
      el.classList.add(...disabledClasses);
    }
  }
  settingsOwnerHint.textContent = isOwner ? "(you are owner)" : "(owner only)";
}

// ── Utility ──────────────────────────────────────────────────
function generateRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  for (const b of arr) code += chars[b % chars.length];
  return code;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function showAlert(message: string) {
  const container = $("alert-container") as HTMLDivElement;
  const toast = document.createElement("div");
  toast.className =
    "flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400 shadow-lg backdrop-blur transition-opacity duration-300";
  toast.innerHTML = `<i data-lucide="alert-triangle" class="h-4 w-4 shrink-0"></i><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  createIcons({ icons, nameAttr: "data-lucide" });
  setTimeout(() => {
    toast.classList.add("opacity-0");
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// ── WebSocket ────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    reconnectAttempts = 0;
    updateStatus(true);
    if (currentRoom && myName) {
      ws!.send(JSON.stringify({ type: "join", room: currentRoom, name: myName }));
    }
  };

  ws.onmessage = (ev) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleMessage(msg);
  };

  ws.onclose = () => {
    updateStatus(false);
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

function scheduleReconnect() {
  reconnectAttempts++;
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000);
  setTimeout(connect, delay);
}

function sendMsg(msg: object) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── Message Handling ─────────────────────────────────────────
function handleMessage(msg: ServerMessage) {
  switch (msg.type) {
    case "joined":
      myPeerId = msg.peerId as string;
      currentRoom = msg.room as string;
      if (msg.fileExpiryMinutes) updateExpiryUI(msg.fileExpiryMinutes as number);
      if (msg.maxUploadSizeMB) updateMaxUploadUI(msg.maxUploadSizeMB as number);
      isOwner = (msg.isOwner as boolean) ?? false;
      updateSettingsEnabled();
      showMainScreen();
      break;

    case "settings":
      if (msg.fileExpiryMinutes) updateExpiryUI(msg.fileExpiryMinutes as number);
      if (msg.maxUploadSizeMB) updateMaxUploadUI(msg.maxUploadSizeMB as number);
      break;

    case "owner":
      isOwner = (msg.isOwner as boolean) ?? false;
      updateSettingsEnabled();
      break;

    case "peers":
      renderPeers(msg.peers as { id: string; name: string; isOwner: boolean }[]);
      break;

    case "clipboard": {
      const entry: ClipboardEntry = {
        text: msg.text as string,
        from: msg.from as string,
        fromId: msg.fromId as string,
        timestamp: msg.timestamp as number,
      };
      clipboardEntries.push(entry);
      renderClipboardFeed();
      // Auto-copy to clipboard
      navigator.clipboard?.writeText(entry.text).catch(() => {});
      break;
    }

    case "history": {
      const entries = msg.entries as ClipboardEntry[];
      clipboardEntries.length = 0;
      clipboardEntries.push(...entries);
      renderClipboardFeed();
      break;
    }

    case "file-notify": {
      const fi: FileInfo = {
        fileId: msg.fileId as string,
        fileName: msg.fileName as string,
        fileSize: msg.fileSize as number,
        from: msg.from as string,
      };
      sharedFiles.push(fi);
      renderFileList();
      break;
    }

    case "cleanup": {
      const entries = msg.clipboardEntries as ClipboardEntry[];
      clipboardEntries.length = 0;
      clipboardEntries.push(...entries);
      renderClipboardFeed();

      const cleanFiles = msg.files as FileInfo[];
      sharedFiles.length = 0;
      sharedFiles.push(...cleanFiles);
      renderFileList();
      break;
    }

    case "error":
      console.error("[ws]", msg.message);
      break;
  }
}

// ── UI: Status ───────────────────────────────────────────────
function updateStatus(connected: boolean) {
  headerStatus.innerHTML = connected
    ? '<span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span> Connected'
    : '<span class="h-1.5 w-1.5 rounded-full bg-red-400"></span> Reconnecting...';
}

// ── UI: Screens ──────────────────────────────────────────────
function showJoinScreen() {
  joinScreen.classList.remove("hidden");
  mainScreen.classList.add("hidden");
  mainScreen.classList.remove("flex");
}

function showMainScreen() {
  joinScreen.classList.add("hidden");
  mainScreen.classList.remove("hidden");
  mainScreen.classList.add("flex");

  headerRoom.textContent = `Room: ${currentRoom}`;

  // Load QR
  const url = `${location.origin}?room=${encodeURIComponent(currentRoom)}`;
  shareUrl.textContent = url;
  shareUrlMobile.textContent = url;

  fetch(`/api/qr?text=${encodeURIComponent(url)}`)
    .then((r) => r.text())
    .then((svg) => {
      // Sanitize SVG: parse with DOMParser and strip dangerous elements/attributes
      const parser = new DOMParser();
      const doc = parser.parseFromString(svg, "image/svg+xml");
      const svgEl = doc.querySelector("svg");
      if (!svgEl) return;

      // Remove any script elements
      for (const script of svgEl.querySelectorAll("script")) script.remove();

      // Remove event handler attributes from all elements
      const allEls = svgEl.querySelectorAll("*");
      for (const el of allEls) {
        for (const attr of Array.from(el.attributes)) {
          if (attr.name.startsWith("on")) el.removeAttribute(attr.name);
        }
      }

      // Add explicit dimensions for Safari compatibility
      svgEl.setAttribute("width", "100%");
      svgEl.setAttribute("height", "100%");

      qrContainer.replaceChildren(svgEl.cloneNode(true));
      qrContainerMobile.replaceChildren(svgEl.cloneNode(true));
    })
    .catch(() => {});
}

// ── UI: Peers ────────────────────────────────────────────────
function renderPeers(peers: { id: string; name: string; isOwner: boolean }[]) {
  headerPeersCount.textContent = `${peers.length} peer${peers.length !== 1 ? "s" : ""}`;

  const html = peers
    .map(
      (p) => `
    <li class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
      p.id === myPeerId ? "bg-amber-500/10 text-amber-400" : "text-gray-300"
    }">
      <span class="h-2 w-2 shrink-0 rounded-full ${p.id === myPeerId ? "bg-amber-400" : "bg-emerald-400"}"></span>
      ${escapeHtml(p.name)}${p.id === myPeerId ? " (you)" : ""}${p.isOwner ? ' <span class="text-xs text-amber-500" title="Room owner">★</span>' : ""}
    </li>`,
    )
    .join("");

  peersList.innerHTML = html;
  peersListMobile.innerHTML = html;
}

// ── UI: Clipboard Feed ───────────────────────────────────────
function renderClipboardFeed() {
  if (clipboardEntries.length === 0) {
    clipboardFeed.innerHTML =
      '<div class="flex h-full items-center justify-center text-sm text-gray-500">No clipboard entries yet. Share some text!</div>';
    return;
  }

  clipboardFeed.innerHTML = clipboardEntries
    .map(
      (e) => `
    <div class="group relative rounded-lg border border-gray-800 bg-gray-900 p-3">
      <div class="mb-1 flex items-center justify-between">
        <span class="text-xs font-medium ${e.fromId === myPeerId ? "text-amber-400" : "text-blue-400"}">${escapeHtml(e.from)}</span>
        <span class="text-xs text-gray-500">${formatTime(e.timestamp)}</span>
      </div>
      <pre class="whitespace-pre-wrap break-all text-sm text-gray-200 font-mono pr-8">${escapeHtml(e.text)}</pre>
      <button onclick="copyEntry(this)" data-text="${escapeHtml(e.text).replace(/"/g, "&quot;")}"
        class="absolute bottom-2 right-2 hidden items-center gap-1 rounded bg-gray-800 p-1.5 text-gray-400 hover:text-amber-400 group-hover:inline-flex transition">
        <i data-lucide="copy" class="h-3.5 w-3.5"></i>
      </button>
    </div>`,
    )
    .join("");

  clipboardFeed.scrollTop = clipboardFeed.scrollHeight;
  createIcons({ icons, nameAttr: "data-lucide" });
}

// Global function for copy button
(window as any).copyEntry = function (btn: HTMLButtonElement) {
  const text = btn.dataset.text ?? "";
  navigator.clipboard?.writeText(text).then(() => {
    btn.innerHTML = '<i data-lucide="check" class="h-3.5 w-3.5"></i>';
    btn.classList.add("text-emerald-400");
    createIcons({ icons, nameAttr: "data-lucide" });
    setTimeout(() => {
      btn.innerHTML = '<i data-lucide="copy" class="h-3.5 w-3.5"></i>';
      btn.classList.remove("text-emerald-400");
      createIcons({ icons, nameAttr: "data-lucide" });
    }, 1500);
  });
};

// ── UI: File List ────────────────────────────────────────────
function renderFileList() {
  if (sharedFiles.length === 0) {
    fileList.innerHTML =
      '<div class="flex h-full items-center justify-center text-sm text-gray-500">No files shared yet.</div>';
    return;
  }

  fileList.innerHTML = sharedFiles
    .map(
      (f) => `
    <div class="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 p-3 mb-2">
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium text-white">${escapeHtml(f.fileName)}</p>
        <p class="text-xs text-gray-500">${formatSize(f.fileSize)} · from ${escapeHtml(f.from)}</p>
      </div>
      <a href="/api/download/${encodeURIComponent(f.fileId)}" download="${escapeHtml(f.fileName)}"
        class="ml-3 shrink-0 inline-flex items-center gap-1 rounded-lg bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-400 hover:bg-amber-500/20 transition">
        <i data-lucide="download" class="h-3.5 w-3.5"></i> Download
      </a>
    </div>`,
    )
    .join("");

  createIcons({ icons, nameAttr: "data-lucide" });
}

// ── UI: Tabs ─────────────────────────────────────────────────
document.querySelectorAll<HTMLButtonElement>(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll<HTMLButtonElement>(".tab-btn").forEach((b) => {
      b.classList.remove("border-amber-500", "text-amber-400");
      b.classList.add("border-transparent", "text-gray-400");
    });
    btn.classList.add("border-amber-500", "text-amber-400");
    btn.classList.remove("border-transparent", "text-gray-400");

    const tab = btn.dataset.tab;
    const tabClipboard = $<HTMLDivElement>("tab-clipboard");
    const tabFiles = $<HTMLDivElement>("tab-files");

    if (tab === "clipboard") {
      tabClipboard.classList.remove("hidden");
      tabFiles.classList.add("hidden");
    } else {
      tabClipboard.classList.add("hidden");
      tabFiles.classList.remove("hidden");
    }
  });
});

// ── Actions: Join ────────────────────────────────────────────
btnRandomRoom.addEventListener("click", () => {
  inputRoom.value = generateRoomCode();
});

btnJoin.addEventListener("click", joinRoom);
inputName.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
inputRoom.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });

function joinRoom() {
  const name = inputName.value.trim();
  const room = inputRoom.value.trim();
  if (!name) { inputName.focus(); return; }
  if (!room) { inputRoom.focus(); return; }

  myName = name;
  currentRoom = room;
  sendMsg({ type: "join", room, name });
}

// ── Actions: Leave ───────────────────────────────────────────
btnLeave.addEventListener("click", () => {
  currentRoom = "";
  isOwner = false;
  clipboardEntries.length = 0;
  sharedFiles.length = 0;
  stopWatching();
  ws?.close();
  showJoinScreen();
  setTimeout(connect, 100);
});

// ── Actions: Send Text ───────────────────────────────────────
btnSend.addEventListener("click", sendText);
inputText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendText();
  }
});

function sendText() {
  const text = inputText.value.trim();
  if (!text) return;
  sendMsg({ type: "clipboard", text });
  // Add to local feed immediately
  clipboardEntries.push({ text, from: myName, fromId: myPeerId, timestamp: Date.now() });
  renderClipboardFeed();
  inputText.value = "";
  lastClipboardText = text;
}

// ── Actions: Copy Link ───────────────────────────────────────
btnCopyLink.addEventListener("click", () => {
  const url = `${location.origin}?room=${encodeURIComponent(currentRoom)}`;
  navigator.clipboard?.writeText(url).then(() => {
    btnCopyLink.innerHTML = '<i data-lucide="check" class="h-3.5 w-3.5"></i> Copied!';
    btnCopyLink.classList.add("text-emerald-400", "border-emerald-500");
    createIcons({ icons, nameAttr: "data-lucide" });
    setTimeout(() => {
      btnCopyLink.innerHTML = '<i data-lucide="link" class="h-3.5 w-3.5"></i> Copy Link';
      btnCopyLink.classList.remove("text-emerald-400", "border-emerald-500");
      createIcons({ icons, nameAttr: "data-lucide" });
    }, 1500);
  });
});

// ── Actions: Watch Clipboard ─────────────────────────────────
let watching = true;

toggleWatch.addEventListener("change", () => {
  if (toggleWatch.checked) {
    watching = true;
  } else {
    watching = false;
  }
});

function stopWatching() {
  watching = false;
  toggleWatch.checked = false;
}

// Manual paste button — reads clipboard and shares it
const btnPaste = $<HTMLButtonElement>("btn-paste");
btnPaste.addEventListener("click", async () => {
  // Try the Clipboard API first (requires permission)
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.length > 0) {
      lastClipboardText = text;
      sendMsg({ type: "clipboard", text });
      clipboardEntries.push({ text, from: myName, fromId: myPeerId, timestamp: Date.now() });
      renderClipboardFeed();
      return;
    }
  } catch {
    // Permission denied — fall back to execCommand
  }
  // Fallback: use a temporary textarea + execCommand("paste")
  const tmp = document.createElement("textarea");
  tmp.style.position = "fixed";
  tmp.style.opacity = "0";
  document.body.appendChild(tmp);
  tmp.focus();
  document.execCommand("paste");
  const text = tmp.value;
  document.body.removeChild(tmp);
  if (text && text.length > 0) {
    lastClipboardText = text;
    sendMsg({ type: "clipboard", text });
    clipboardEntries.push({ text, from: myName, fromId: myPeerId, timestamp: Date.now() });
    renderClipboardFeed();
  }
});

// Listen for paste events anywhere on the page
document.addEventListener("paste", (e: ClipboardEvent) => {
  if (!watching) return;
  // Don't intercept paste when typing in any input or textarea
  if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;

  const text = e.clipboardData?.getData("text/plain");
  if (text && text !== lastClipboardText && text.length > 0) {
    e.preventDefault();
    lastClipboardText = text;
    sendMsg({ type: "clipboard", text });
    clipboardEntries.push({ text, from: myName, fromId: myPeerId, timestamp: Date.now() });
    renderClipboardFeed();
  }
});

// ── Actions: File Upload ─────────────────────────────────────
fileInput.addEventListener("change", () => {
  const files = fileInput.files;
  if (files) {
    for (const file of files) uploadFile(file);
  }
  fileInput.value = "";
});

// Drag & drop
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("border-amber-500", "bg-amber-500/5");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("border-amber-500", "bg-amber-500/5");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("border-amber-500", "bg-amber-500/5");
  const files = e.dataTransfer?.files;
  if (files) {
    for (const file of files) uploadFile(file);
  }
});

async function uploadFile(file: File) {
  const maxBytes = Number(maxUploadSizeSelect.value) * 1024 * 1024;
  if (file.size > maxBytes) {
    showAlert(`File "${file.name}" (${formatSize(file.size)}) exceeds the max upload size of ${formatSize(maxBytes)}.`);
    return;
  }

  uploadProgress.classList.remove("hidden");
  uploadName.textContent = file.name;
  uploadPct.textContent = "0%";
  uploadBar.style.width = "0%";

  try {
    // Use XMLHttpRequest for progress tracking
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/upload/${encodeURIComponent(currentRoom)}`);
      xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
      xhr.setRequestHeader("X-File-Mime", file.type || "application/octet-stream");
      xhr.setRequestHeader("X-Uploader", myName);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          uploadPct.textContent = pct + "%";
          uploadBar.style.width = pct + "%";
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const resp = JSON.parse(xhr.responseText);
          // Notify peers
          sendMsg({
            type: "file-notify",
            fileId: resp.fileId,
            fileName: resp.fileName,
            fileSize: resp.fileSize,
          });
          // Add to local list
          sharedFiles.push({
            fileId: resp.fileId,
            fileName: resp.fileName,
            fileSize: resp.fileSize,
            from: myName,
          });
          renderFileList();
          resolve();
        } else {
          reject(new Error(xhr.responseText));
        }
      };

      xhr.onerror = () => reject(new Error("Upload failed"));
      xhr.send(file);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    showAlert(message);
  } finally {
    setTimeout(() => uploadProgress.classList.add("hidden"), 1000);
  }
}

// ── Mobile Drawer ────────────────────────────────────────────
btnMobilePeers.addEventListener("click", () => {
  mobileDrawer.classList.remove("hidden");
});

drawerBackdrop.addEventListener("click", () => {
  mobileDrawer.classList.add("hidden");
});

btnCloseDrawer.addEventListener("click", () => {
  mobileDrawer.classList.add("hidden");
});

// ── Init ─────────────────────────────────────────────────────
function init() {
  // Check for room in URL params
  const params = new URLSearchParams(location.search);
  const roomParam = params.get("room");
  if (roomParam) {
    inputRoom.value = roomParam;
  }

  // Fetch server info
  fetch("/api/info")
    .then((r) => r.json())
    .then((info: any) => {
      serverInfo.textContent = `Port: ${info.port} · ${info.rooms} rooms · ${info.peers} peers`;
    })
    .catch(() => {});

  // Generate a default room code
  if (!inputRoom.value) {
    inputRoom.value = generateRoomCode();
  }

  // Focus name input
  inputName.focus();

  // Connect WebSocket
  connect();

  // Set favicon dynamically (avoids Bun HTML bundler resolving the path)
  const faviconLink = document.createElement("link");
  faviconLink.rel = "icon";
  faviconLink.type = "image/svg+xml";
  faviconLink.href = "/favicon.svg";
  document.head.appendChild(faviconLink);

  // Set logo images dynamically
  const logoJoin = document.getElementById("logo-join") as HTMLImageElement | null;
  const logoHeader = document.getElementById("logo-header") as HTMLImageElement | null;
  if (logoJoin) logoJoin.src = "/favicon.svg";
  if (logoHeader) logoHeader.src = "/favicon.svg";

  // Initialize lucide icons
  createIcons({ icons, nameAttr: "data-lucide" });
}

init();
