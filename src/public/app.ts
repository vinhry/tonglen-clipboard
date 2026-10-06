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
  mime: string;
  from: string;
  fromId: string;
  timestamp: number;
}

interface Peer {
  id: string;
  name: string;
  isOwner: boolean;
}

type FeedItem =
  | ({ kind: "text"; id: string } & ClipboardEntry)
  | ({ kind: "file"; id: string } & FileInfo)
  | UploadItem;

interface UploadItem {
  kind: "upload";
  id: string;
  fileName: string;
  fileSize: number;
  pct: number;
  timestamp: number;
  status: "queued" | "uploading";
  note?: string;
}

interface UploadJob {
  item: UploadItem;
  file: File;
  attempts: number;
}

// ── Constants ────────────────────────────────────────────────
const GROUP_WINDOW_MS = 2 * 60_000;
const MAX_WS_TEXT_BYTES = 900_000; // larger text is sent as a .txt file instead
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const NAME_STORAGE_KEY = "tonglen:name";
const MAX_PARALLEL_UPLOADS = 3;
const MAX_UPLOAD_ATTEMPTS = 3;

// ── State ────────────────────────────────────────────────────
let ws: WebSocket | null = null;
let online = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let myPeerId = "";
let uploadToken = "";
// Peer ids change on every reconnect; remember all of ours so old items still read as "You"
const myPeerIds = new Set<string>();
let currentRoom = "";
let myName = "";
let isOwner = false;
let watching = true;
let feed: FeedItem[] = [];
// Uploads in flight, waiting for a slot, and waiting out a rate limit
const uploads = new Map<string, XMLHttpRequest>();
const uploadQueue: UploadJob[] = [];
const uploadRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const expandedIds = new Set<string>();
let localSeq = 0;
let renderQueued = false;
let stickToBottom = true;

// ── DOM Elements ─────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const joinScreen = $<HTMLDivElement>("join-screen");
const mainScreen = $<HTMLDivElement>("main-screen");
const inputName = $<HTMLInputElement>("input-name");
const inputRoom = $<HTMLInputElement>("input-room");
const btnRandomRoom = $<HTMLButtonElement>("btn-random-room");
const btnJoin = $<HTMLButtonElement>("btn-join");
const serverInfo = $<HTMLDivElement>("server-info");
const headerRoom = $<HTMLElement>("header-room");
const btnRoomCode = $<HTMLButtonElement>("btn-room-code");
const headerStatus = $<HTMLElement>("header-status");
const headerPeersCount = $<HTMLElement>("header-peers-count");
const btnCopyLink = $<HTMLButtonElement>("btn-copy-link");
const btnLeave = $<HTMLButtonElement>("btn-leave");
const qrContainer = $<HTMLDivElement>("qr-container");
const shareUrl = $<HTMLElement>("share-url");
const peersList = $<HTMLUListElement>("peers-list");
const feedEl = $<HTMLDivElement>("feed");
const toggleWatch = $<HTMLInputElement>("toggle-watch");
const inputText = $<HTMLTextAreaElement>("input-text");
const btnSend = $<HTMLButtonElement>("btn-send");
const btnPaste = $<HTMLButtonElement>("btn-paste");
const fileInput = $<HTMLInputElement>("file-input");
const dropOverlay = $<HTMLDivElement>("drop-overlay");
const sidebar = $<HTMLElement>("sidebar");
const btnMobilePeers = $<HTMLButtonElement>("btn-mobile-peers");
const drawerBackdrop = $<HTMLDivElement>("drawer-backdrop");
const btnCloseDrawer = $<HTMLButtonElement>("btn-close-drawer");
const fileExpirySelect = $<HTMLSelectElement>("file-expiry");
const expiryLabel = $<HTMLElement>("expiry-label");
const maxUploadSizeSelect = $<HTMLSelectElement>("max-upload-size");
const maxUploadLabel = $<HTMLElement>("max-upload-label");
const settingsOwnerHint = $<HTMLElement>("settings-owner-hint");

const refreshIcons = () => createIcons({ icons, nameAttr: "data-lucide" });

// ── Expiry helpers ────────────────────────────────────────────
const EXPIRY_LABELS: Record<string, string> = {
  "1": "1 minute",
  "5": "5 minutes",
  "15": "15 minutes",
  "30": "30 minutes",
  "60": "1 hour",
  "360": "6 hours",
  "720": "12 hours",
  "1440": "24 hours",
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
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDay(ts: number): string {
  const day = dayKey(ts);
  if (day === dayKey(Date.now())) return "Today";
  if (day === dayKey(Date.now() - 86_400_000)) return "Yesterday";
  return new Date(ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function dayKey(ts: number): string {
  return new Date(ts).toDateString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape text and turn bare http(s) URLs into links. */
function linkify(text: string): string {
  const urlRe = /https?:\/\/[^\s<>"'`]+/g;
  let out = "";
  let last = 0;
  for (const match of text.matchAll(urlRe)) {
    // Leave trailing punctuation outside the link
    const url = match[0].replace(/[.,;:!?)\]]+$/, "");
    const start = match.index!;
    out += escapeHtml(text.slice(last, start));
    out += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="text-amber-400 underline decoration-amber-400/40 underline-offset-2 hover:decoration-amber-400">${escapeHtml(url)}</a>`;
    last = start + url.length;
  }
  return out + escapeHtml(text.slice(last));
}

function timestampSlug(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function nextLocalId(prefix: string): string {
  // crypto.randomUUID is unavailable on plain-http LAN origins, so use a counter
  return `${prefix}-local-${++localSeq}`;
}

/** Copy text, falling back to execCommand on insecure (plain http) origins. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  const tmp = document.createElement("textarea");
  tmp.value = text;
  tmp.setAttribute("readonly", "");
  tmp.style.position = "fixed";
  tmp.style.opacity = "0";
  document.body.appendChild(tmp);
  tmp.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  tmp.remove();
  return ok;
}

type ToastVariant = "error" | "success" | "info";

const TOAST_STYLES: Record<ToastVariant, { cls: string; icon: string }> = {
  error: { cls: "border-red-500/30 bg-red-950/80 text-red-300", icon: "triangle-alert" },
  success: { cls: "border-emerald-500/30 bg-emerald-950/80 text-emerald-300", icon: "circle-check" },
  info: { cls: "border-gray-700 bg-gray-900/90 text-gray-200", icon: "info" },
};

function showToast(message: string, variant: ToastVariant = "error") {
  const container = $<HTMLDivElement>("alert-container");
  const style = TOAST_STYLES[variant];
  const toast = document.createElement("div");
  toast.setAttribute("role", variant === "error" ? "alert" : "status");
  toast.className = `pointer-events-auto flex max-w-sm items-center gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur transition-opacity duration-300 ${style.cls}`;
  toast.innerHTML = `<i data-lucide="${style.icon}" class="h-4 w-4 shrink-0"></i><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  refreshIcons();
  setTimeout(() => {
    toast.classList.add("opacity-0");
    setTimeout(() => toast.remove(), 300);
  }, variant === "error" ? 5000 : 2500);
}

function shareLink(): string {
  return `${location.origin}/?room=${encodeURIComponent(currentRoom)}`;
}

// ── WebSocket ────────────────────────────────────────────────
function connect() {
  clearTimeout(reconnectTimer);
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}/ws`);
  ws = socket;

  socket.onopen = () => {
    reconnectAttempts = 0;
    updateStatus(true);
    if (currentRoom && myName) {
      socket.send(JSON.stringify({ type: "join", room: currentRoom, name: myName }));
    }
  };

  socket.onmessage = (ev) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleMessage(msg);
  };

  socket.onclose = () => {
    if (ws !== socket) return; // replaced by a newer connection
    updateStatus(false);
    scheduleReconnect();
  };

  socket.onerror = () => {
    socket.close();
  };
}

function scheduleReconnect() {
  reconnectAttempts++;
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000);
  reconnectTimer = setTimeout(connect, delay);
}

function sendMsg(msg: object): boolean {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

// ── Feed model ───────────────────────────────────────────────
function textItem(e: ClipboardEntry): FeedItem {
  return { kind: "text", id: `t-${e.fromId}-${e.timestamp}`, ...e };
}

function fileItem(f: FileInfo): FeedItem {
  return { kind: "file", id: `f-${f.fileId}`, ...f };
}

function upsertFile(f: FileInfo) {
  const item = fileItem(f);
  const idx = feed.findIndex((i) => i.id === item.id);
  if (idx >= 0) feed[idx] = item;
  else feed.push(item);
}

function isMine(item: FeedItem): boolean {
  return item.kind === "upload" || myPeerIds.has(item.fromId);
}

function senderKey(item: FeedItem): string {
  return item.kind === "upload" || isMine(item) ? "me" : item.fromId;
}

// ── Message Handling ─────────────────────────────────────────
function handleMessage(msg: ServerMessage) {
  switch (msg.type) {
    case "joined":
      myPeerId = msg.peerId as string;
      myPeerIds.add(myPeerId);
      uploadToken = msg.uploadToken as string;
      currentRoom = msg.room as string;
      if (msg.fileExpiryMinutes) updateExpiryUI(msg.fileExpiryMinutes as number);
      if (msg.maxUploadSizeMB) updateMaxUploadUI(msg.maxUploadSizeMB as number);
      isOwner = (msg.isOwner as boolean) ?? false;
      updateSettingsEnabled();
      // The server replays history and files right after this; drop stale copies so they aren't duplicated
      feed = feed.filter((i) => i.kind === "upload");
      showMainScreen();
      scheduleRender();
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
      renderPeers(msg.peers as Peer[]);
      break;

    case "clipboard": {
      const entry: ClipboardEntry = {
        text: msg.text as string,
        from: msg.from as string,
        fromId: msg.fromId as string,
        timestamp: msg.timestamp as number,
      };
      feed.push(textItem(entry));
      scheduleRender();
      // Auto-copy to clipboard (only succeeds where the browser allows it)
      if (window.isSecureContext) navigator.clipboard?.writeText(entry.text).catch(() => {});
      break;
    }

    case "history": {
      const entries = msg.entries as ClipboardEntry[];
      feed = feed.filter((i) => i.kind !== "text").concat(entries.map(textItem));
      scheduleRender();
      break;
    }

    case "file-notify":
      upsertFile(msg as unknown as FileInfo);
      scheduleRender();
      break;

    case "cleanup": {
      const entries = msg.clipboardEntries as ClipboardEntry[];
      const files = msg.files as FileInfo[];
      feed = [
        ...feed.filter((i) => i.kind === "upload"),
        ...entries.map(textItem),
        ...files.map(fileItem),
      ];
      scheduleRender();
      break;
    }

    case "error":
      console.error("[ws]", msg.message);
      if (typeof msg.message === "string") showToast(msg.message);
      break;
  }
}

// ── UI: Status ───────────────────────────────────────────────
function updateStatus(connected: boolean) {
  online = connected;
  headerStatus.innerHTML = connected
    ? '<span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span> Connected'
    : '<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400"></span> Reconnecting…';
  inputText.placeholder = connected ? "Type, paste, or drop files…" : "Offline — reconnecting…";
  updateSendEnabled();
}

function updateSendEnabled() {
  btnSend.disabled = !online || !inputText.value.trim();
}

// ── UI: Screens ──────────────────────────────────────────────
function showJoinScreen() {
  joinScreen.classList.remove("hidden");
  mainScreen.classList.add("hidden");
  mainScreen.classList.remove("flex");
  history.replaceState(null, "", location.pathname);
}

function showMainScreen() {
  const wasHidden = mainScreen.classList.contains("hidden");
  joinScreen.classList.add("hidden");
  mainScreen.classList.remove("hidden");
  mainScreen.classList.add("flex");

  headerRoom.textContent = currentRoom;
  document.title = `${currentRoom} · Tonglen Clipboard`;
  history.replaceState(null, "", `?room=${encodeURIComponent(currentRoom)}`);

  if (!wasHidden) return; // reconnect: QR is already loaded
  stickToBottom = true;
  inputText.focus();

  const url = shareLink();
  shareUrl.textContent = url;

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

      qrContainer.replaceChildren(svgEl);
    })
    .catch(() => {});
}

// ── UI: Peers ────────────────────────────────────────────────
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const chars = parts.length > 1 ? [parts[0]!, parts[parts.length - 1]!].map((p) => [...p][0]) : [...(parts[0] ?? "?")].slice(0, 2);
  return chars.join("").toUpperCase();
}

function renderPeers(peers: Peer[]) {
  headerPeersCount.textContent = `${peers.length} ${peers.length === 1 ? "device" : "devices"}`;

  peersList.innerHTML = peers
    .map((p) => {
      const me = p.id === myPeerId;
      return `
    <li class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm ${me ? "bg-amber-500/10" : ""}">
      <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${me ? "bg-amber-500 text-gray-950" : "bg-gray-800 text-gray-300"}">${escapeHtml(initials(p.name))}</span>
      <span class="min-w-0 flex-1 truncate ${me ? "text-amber-300" : "text-gray-200"}">${escapeHtml(p.name)}${me ? ' <span class="text-gray-500">(you)</span>' : ""}</span>
      ${p.isOwner ? '<span class="shrink-0 rounded-full border border-amber-500/30 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-400">owner</span>' : ""}
    </li>`;
    })
    .join("");
}

// ── UI: Feed ─────────────────────────────────────────────────
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(renderFeed);
}

function scrollToBottom() {
  feedEl.scrollTop = feedEl.scrollHeight;
}

feedEl.addEventListener("scroll", () => {
  stickToBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 120;
});

// Images loading and viewport changes (rotation, mobile keyboard) shift the layout; keep the view pinned if it was
feedEl.addEventListener("load", () => { if (stickToBottom) scrollToBottom(); }, true);
new ResizeObserver(() => { if (stickToBottom) scrollToBottom(); }).observe(feedEl);
// Hide previews for files that expired while the page was open
feedEl.addEventListener("error", (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement) img.closest("[data-preview]")?.remove();
}, true);

const EMPTY_STATE = `
  <div class="flex h-full flex-col items-center justify-center px-6 text-center">
    <div class="flex h-14 w-14 items-center justify-center rounded-2xl border border-gray-800 bg-gray-900 text-amber-400">
      <i data-lucide="inbox" class="h-6 w-6"></i>
    </div>
    <p class="mt-4 text-sm font-medium text-gray-200">Nothing shared yet</p>
    <p class="mt-1 max-w-xs text-sm text-gray-500">Type a message, paste anything, or drop files anywhere. Everyone in this room gets it instantly.</p>
  </div>`;

function renderFeed() {
  renderQueued = false;
  if (feed.length === 0) {
    feedEl.innerHTML = EMPTY_STATE;
    refreshIcons();
    return;
  }

  const items = [...feed].sort((a, b) => a.timestamp - b.timestamp);
  let html = "";
  let prev: FeedItem | undefined;
  for (const item of items) {
    const newDay = prev
      ? dayKey(prev.timestamp) !== dayKey(item.timestamp)
      : dayKey(item.timestamp) !== dayKey(Date.now());
    if (newDay) {
      html += `<div class="my-4 flex items-center gap-3 text-xs text-gray-500"><div class="h-px flex-1 bg-gray-800"></div>${formatDay(item.timestamp)}<div class="h-px flex-1 bg-gray-800"></div></div>`;
    }
    const grouped =
      !newDay &&
      prev !== undefined &&
      senderKey(prev) === senderKey(item) &&
      item.timestamp - prev.timestamp < GROUP_WINDOW_MS;
    html += renderItem(item, !grouped);
    prev = item;
  }

  feedEl.innerHTML = `<div class="mx-auto flex max-w-3xl flex-col pb-2">${html}</div>`;
  refreshIcons();
  if (stickToBottom) scrollToBottom();
}

function renderItem(item: FeedItem, showHeader: boolean): string {
  const mine = isMine(item);
  const from = item.kind === "upload" ? myName : item.from;
  const header = showHeader
    ? `<div class="mb-1 mt-4 flex items-baseline gap-2 px-1 text-xs">
        <span class="font-medium ${mine ? "text-amber-400" : "text-sky-400"}">${mine ? "You" : escapeHtml(from)}</span>
        <span class="text-gray-500">${formatTime(item.timestamp)}</span>
      </div>`
    : "";

  let body: string;
  if (item.kind === "text") body = renderText(item, mine);
  else if (item.kind === "file") body = renderFile(item, mine);
  else body = renderUpload(item);

  return `
    <div class="flex flex-col ${mine ? "items-end" : "items-start"} ${showHeader ? "" : "mt-1.5"}">
      ${header}
      <div class="group flex max-w-[92%] items-end gap-1 sm:max-w-[80%] ${mine ? "flex-row-reverse" : ""}">${body}</div>
    </div>`;
}

const bubbleClass = (mine: boolean) =>
  mine
    ? "rounded-2xl rounded-br-md border border-amber-500/25 bg-amber-500/10"
    : "rounded-2xl rounded-bl-md border border-gray-800 bg-gray-900";

function renderText(item: Extract<FeedItem, { kind: "text" }>, mine: boolean): string {
  const long = item.text.split("\n").length > 12 || item.text.length > 800;
  const expanded = expandedIds.has(item.id);
  const id = escapeHtml(item.id);
  return `
    <div class="min-w-0 px-3 py-2 ${bubbleClass(mine)}" title="${escapeHtml(new Date(item.timestamp).toLocaleString())}">
      <pre class="whitespace-pre-wrap font-mono text-sm leading-relaxed text-gray-100 [overflow-wrap:anywhere] ${long && !expanded ? "line-clamp-12" : ""}">${linkify(item.text)}</pre>
      ${long ? `<button type="button" data-action="toggle" data-id="${id}" class="mt-1 text-xs font-medium text-amber-400 hover:underline">${expanded ? "Show less" : `Show more · ${formatSize(new Blob([item.text]).size)}`}</button>` : ""}
    </div>
    <button type="button" data-action="copy" data-id="${id}" title="Copy" aria-label="Copy text"
      class="mb-0.5 shrink-0 rounded-lg p-1.5 text-gray-500 transition hover:bg-gray-800 hover:text-amber-400 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100">
      <i data-lucide="copy" class="h-4 w-4"></i>
    </button>`;
}

function fileIcon(mime: string, name: string): string {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "film";
  if (mime.startsWith("audio/")) return "music";
  if (/zip|tar|gzip|7z|rar|compressed/.test(mime) || /\.(zip|tar|gz|tgz|7z|rar)$/i.test(name)) return "file-archive";
  if (/json|javascript|typescript|xml|x-sh|x-python/.test(mime)) return "file-code";
  if (mime.startsWith("text/") || mime === "application/pdf") return "file-text";
  return "file";
}

function renderFile(item: Extract<FeedItem, { kind: "file" }>, mine: boolean): string {
  const url = `/api/download/${encodeURIComponent(item.fileId)}`;
  const name = escapeHtml(item.fileName);
  const preview = INLINE_IMAGE_TYPES.has(item.mime)
    ? `<a data-preview href="${url}?inline=1" target="_blank" rel="noopener" class="block border-b border-gray-800 bg-gray-950">
        <img src="${url}?inline=1" alt="${name}" loading="lazy" class="max-h-72 w-full object-contain" />
      </a>`
    : "";
  return `
    <div class="w-72 max-w-full min-w-0 overflow-hidden ${bubbleClass(mine)}">
      ${preview}
      <div class="flex items-center gap-3 p-2.5">
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-800 text-amber-400">
          <i data-lucide="${fileIcon(item.mime, item.fileName)}" class="h-5 w-5"></i>
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-white" title="${name}">${name}</p>
          <p class="text-xs text-gray-500">${formatSize(item.fileSize)}</p>
        </div>
        <a href="${url}" download="${name}" title="Download" aria-label="Download ${name}"
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 transition hover:bg-amber-500/20">
          <i data-lucide="download" class="h-4 w-4"></i>
        </a>
      </div>
    </div>`;
}

function renderUpload(item: UploadItem): string {
  const id = escapeHtml(item.id);
  const active = item.status === "uploading";
  const detail = active
    ? `<span data-pct>${item.pct}%</span> of ${formatSize(item.fileSize)}`
    : `${escapeHtml(item.note ?? "Waiting…")} · ${formatSize(item.fileSize)}`;
  return `
    <div data-upload="${id}" class="w-72 max-w-full min-w-0 p-2.5 ${bubbleClass(true)}">
      <div class="flex items-center gap-3">
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-800 ${active ? "text-amber-400" : "text-gray-500"}">
          <i data-lucide="${active ? "loader-circle" : "clock"}" class="h-5 w-5 ${active ? "animate-spin" : ""}"></i>
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-white">${escapeHtml(item.fileName)}</p>
          <p class="text-xs text-gray-400">${detail}</p>
        </div>
        <button type="button" data-action="cancel" data-id="${id}" title="Cancel upload" aria-label="Cancel upload"
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-800 hover:text-red-400">
          <i data-lucide="x" class="h-4 w-4"></i>
        </button>
      </div>
      <div class="mt-2 h-1 w-full rounded-full bg-gray-800">
        <div data-bar class="h-1 rounded-full bg-amber-500 transition-[width]" style="width:${item.pct}%"></div>
      </div>
    </div>`;
}

feedEl.addEventListener("click", async (e) => {
  const btn = (e.target as Element).closest<HTMLButtonElement>("[data-action]");
  if (!btn) return;
  const id = btn.dataset.id ?? "";

  switch (btn.dataset.action) {
    case "copy": {
      const item = feed.find((i) => i.id === id);
      if (item?.kind !== "text") return;
      if (await copyText(item.text)) {
        btn.innerHTML = '<i data-lucide="check" class="h-4 w-4"></i>';
        btn.classList.add("text-emerald-400", "opacity-100!");
        refreshIcons();
        setTimeout(() => {
          btn.innerHTML = '<i data-lucide="copy" class="h-4 w-4"></i>';
          btn.classList.remove("text-emerald-400", "opacity-100!");
          refreshIcons();
        }, 1500);
      } else {
        showToast("Couldn't access the clipboard");
      }
      break;
    }
    case "toggle":
      if (expandedIds.has(id)) expandedIds.delete(id);
      else expandedIds.add(id);
      scheduleRender();
      break;
    case "cancel":
      cancelUpload(id);
      break;
  }
});

// ── Actions: Join ────────────────────────────────────────────
btnRandomRoom.addEventListener("click", () => {
  inputRoom.value = generateRoomCode();
});

btnJoin.addEventListener("click", joinRoom);
inputName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinRoom();
});
inputRoom.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinRoom();
});

function joinRoom() {
  const name = inputName.value.trim();
  const room = inputRoom.value.trim();
  if (!name) {
    inputName.focus();
    return;
  }
  if (!room) {
    inputRoom.focus();
    return;
  }

  myName = name;
  currentRoom = room;
  try {
    localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {}
  if (!sendMsg({ type: "join", room, name })) {
    showToast("Not connected to the server yet — retrying…", "info");
  }
}

// ── Actions: Leave ───────────────────────────────────────────
btnLeave.addEventListener("click", () => {
  cancelAllUploads();
  currentRoom = "";
  isOwner = false;
  feed = [];
  expandedIds.clear();
  myPeerIds.clear();
  closeDrawer();
  renderFeed();
  showJoinScreen();
  document.title = "Tonglen Clipboard";

  // Reconnect with a fresh socket so the server drops us from the room
  const old = ws;
  ws = null;
  old?.close();
  connect();
});

// ── Actions: Send Text ───────────────────────────────────────
function autoResize() {
  inputText.style.height = "auto";
  inputText.style.height = Math.min(inputText.scrollHeight, 192) + "px";
}

inputText.addEventListener("input", () => {
  autoResize();
  updateSendEnabled();
});

btnSend.addEventListener("click", sendText);
inputText.addEventListener("keydown", (e) => {
  // Don't send while an IME (e.g. Vietnamese/Japanese input) is composing
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    sendText();
  }
});

function sendText() {
  const text = inputText.value;
  if (!text.trim()) return;
  if (shareText(text)) {
    inputText.value = "";
    autoResize();
    updateSendEnabled();
  }
}

/** Share text with the room. Returns false if it couldn't be sent. */
function shareText(text: string): boolean {
  if (!currentRoom) return false;

  if (new Blob([text]).size > MAX_WS_TEXT_BYTES) {
    showToast("Text is large, so it's being shared as a .txt file", "info");
    uploadFile(new File([text], `text-${timestampSlug()}.txt`, { type: "text/plain" }));
    return true;
  }

  if (!sendMsg({ type: "clipboard", text })) {
    showToast("You're offline — message not sent");
    return false;
  }
  feed.push(textItem({ text, from: myName, fromId: myPeerId, timestamp: Date.now() }));
  stickToBottom = true;
  scheduleRender();
  return true;
}

// ── Actions: Copy Link ───────────────────────────────────────
async function copyShareLink() {
  if (await copyText(shareLink())) {
    showToast("Room link copied", "success");
    const icon = btnCopyLink.querySelector<HTMLElement>("[data-icon]")!;
    const label = btnCopyLink.querySelector<HTMLElement>("[data-label]")!;
    icon.innerHTML = '<i data-lucide="check" class="h-4 w-4 sm:h-3.5 sm:w-3.5"></i>';
    label.textContent = "Copied!";
    btnCopyLink.classList.add("text-emerald-400", "border-emerald-500");
    refreshIcons();
    setTimeout(() => {
      icon.innerHTML = '<i data-lucide="link" class="h-4 w-4 sm:h-3.5 sm:w-3.5"></i>';
      label.textContent = "Copy Link";
      btnCopyLink.classList.remove("text-emerald-400", "border-emerald-500");
      refreshIcons();
    }, 1500);
  } else {
    showToast("Couldn't access the clipboard");
  }
}

btnCopyLink.addEventListener("click", copyShareLink);
btnRoomCode.addEventListener("click", copyShareLink);

// ── Actions: Paste ───────────────────────────────────────────
toggleWatch.addEventListener("change", () => {
  watching = toggleWatch.checked;
});

function renamePasted(file: File): File {
  // Browsers name pasted screenshots "image.png"; give them something distinguishable
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file;
  const ext = (file.type.split("/")[1] ?? "bin").replace("jpeg", "jpg");
  return new File([file], `pasted-${timestampSlug()}.${ext}`, { type: file.type });
}

// Paste button — reads the system clipboard (images or text) and shares it
btnPaste.addEventListener("click", async () => {
  if (!navigator.clipboard || !window.isSecureContext) {
    showToast("Clipboard access needs HTTPS — press Ctrl+V / ⌘V instead", "info");
    return;
  }
  try {
    if (navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          uploadFile(renamePasted(new File([blob], "image.png", { type: imageType })));
          return;
        }
      }
    }
    const text = await navigator.clipboard.readText();
    if (text) shareText(text);
    else showToast("Clipboard is empty", "info");
  } catch {
    showToast("Clipboard access was denied — press Ctrl+V / ⌘V instead", "info");
  }
});

// Paste anywhere: files are always uploaded; text is shared when auto-share is on
document.addEventListener("paste", (e: ClipboardEvent) => {
  if (!currentRoom || mainScreen.classList.contains("hidden")) return;

  const files = Array.from(e.clipboardData?.files ?? []);
  if (files.length > 0) {
    e.preventDefault();
    for (const file of files) uploadFile(renamePasted(file));
    return;
  }

  if (!watching) return;
  // Let normal paste happen inside form fields
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return;

  const text = e.clipboardData?.getData("text/plain");
  if (text) {
    e.preventDefault();
    shareText(text);
  }
});

// ── Actions: File Upload ─────────────────────────────────────
fileInput.addEventListener("change", () => {
  for (const file of fileInput.files ?? []) uploadFile(file);
  fileInput.value = "";
});

// Drag & drop anywhere in the room view
let dragDepth = 0;
const isFileDrag = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
const inRoom = () => !!currentRoom && !mainScreen.classList.contains("hidden");

function setDropOverlay(visible: boolean) {
  dropOverlay.classList.toggle("hidden", !visible);
  dropOverlay.classList.toggle("flex", visible);
}

window.addEventListener("dragenter", (e) => {
  if (!inRoom() || !isFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  setDropOverlay(true);
});

window.addEventListener("dragover", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault(); // also stops the browser from opening the file on the join screen
  if (!inRoom()) return;
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});

window.addEventListener("dragleave", (e) => {
  if (!inRoom() || !isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDropOverlay(false);
});

window.addEventListener("drop", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  if (!inRoom()) return;
  dragDepth = 0;
  setDropOverlay(false);
  for (const file of e.dataTransfer?.files ?? []) uploadFile(file);
});

function uploadFile(file: File) {
  if (!currentRoom) return;
  const maxBytes = Number(maxUploadSizeSelect.value) * 1024 * 1024;
  if (file.size > maxBytes) {
    showToast(`"${file.name}" (${formatSize(file.size)}) is over the ${formatSize(maxBytes)} limit`);
    return;
  }
  if (file.size === 0) {
    showToast(`"${file.name}" is empty`);
    return;
  }

  const item: UploadItem = {
    kind: "upload",
    id: nextLocalId("u"),
    fileName: file.name,
    fileSize: file.size,
    pct: 0,
    timestamp: Date.now(),
    status: "queued",
  };
  feed.push(item);
  uploadQueue.push({ item, file, attempts: 0 });
  stickToBottom = true;
  scheduleRender();
  pumpUploads();
}

/** Start queued uploads while there are free slots. */
function pumpUploads() {
  while (uploads.size < MAX_PARALLEL_UPLOADS && uploadQueue.length > 0) {
    startUpload(uploadQueue.shift()!);
  }
}

function removeUploadItem(id: string) {
  feed = feed.filter((i) => i.id !== id);
  scheduleRender();
}

function cancelUpload(id: string) {
  const xhr = uploads.get(id);
  if (xhr) {
    xhr.abort(); // onabort removes the card and frees the slot
    return;
  }
  const queued = uploadQueue.findIndex((j) => j.item.id === id);
  if (queued >= 0) uploadQueue.splice(queued, 1);
  clearTimeout(uploadRetryTimers.get(id));
  uploadRetryTimers.delete(id);
  removeUploadItem(id);
}

function cancelAllUploads() {
  uploadQueue.length = 0;
  for (const timer of uploadRetryTimers.values()) clearTimeout(timer);
  uploadRetryTimers.clear();
  for (const xhr of [...uploads.values()]) xhr.abort();
}

function startUpload(job: UploadJob) {
  const { item, file } = job;
  const id = item.id;
  job.attempts++;
  item.status = "uploading";
  item.pct = 0;
  item.note = undefined;
  scheduleRender();

  const xhr = new XMLHttpRequest();
  uploads.set(id, xhr);
  xhr.open("POST", `/api/upload/${encodeURIComponent(currentRoom)}`);
  xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
  xhr.setRequestHeader("X-File-Mime", file.type || "application/octet-stream");
  xhr.setRequestHeader("X-Upload-Token", uploadToken);

  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    item.pct = Math.round((e.loaded / e.total) * 100);
    // Update in place rather than re-rendering the whole feed
    const el = feedEl.querySelector(`[data-upload="${id}"]`);
    el?.querySelector<HTMLElement>("[data-bar]")?.style.setProperty("width", item.pct + "%");
    const pct = el?.querySelector("[data-pct]");
    if (pct) pct.textContent = item.pct + "%";
  };

  const finish = () => {
    uploads.delete(id);
    pumpUploads();
  };

  xhr.onload = () => {
    if (xhr.status === 429 && job.attempts < MAX_UPLOAD_ATTEMPTS) {
      // Wait out the server's rate limit, then go back to the front of the queue
      const wait = Math.min(Number(xhr.getResponseHeader("Retry-After")) || 5, 60);
      item.status = "queued";
      item.note = `Rate limited, retrying in ${wait}s`;
      uploadRetryTimers.set(id, setTimeout(() => {
        uploadRetryTimers.delete(id);
        uploadQueue.unshift(job);
        pumpUploads();
      }, wait * 1000));
      scheduleRender();
      finish();
      return;
    }

    removeUploadItem(id);
    if (xhr.status >= 200 && xhr.status < 300) {
      const info = JSON.parse(xhr.responseText) as FileInfo;
      upsertFile(info);
      sendMsg({ type: "file-notify", fileId: info.fileId, fileName: info.fileName, fileSize: info.fileSize });
    } else {
      showToast(xhr.responseText || `Upload of "${file.name}" failed`);
    }
    finish();
  };

  xhr.onerror = () => {
    removeUploadItem(id);
    showToast(`Upload of "${file.name}" failed`);
    finish();
  };

  xhr.onabort = () => {
    removeUploadItem(id);
    finish();
  };

  xhr.send(file);
}

// ── Mobile Drawer ────────────────────────────────────────────
function openDrawer() {
  sidebar.classList.remove("-translate-x-full");
  drawerBackdrop.classList.remove("hidden");
}

function closeDrawer() {
  sidebar.classList.add("-translate-x-full");
  drawerBackdrop.classList.add("hidden");
}

btnMobilePeers.addEventListener("click", openDrawer);
drawerBackdrop.addEventListener("click", closeDrawer);
btnCloseDrawer.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
});

// ── Init ─────────────────────────────────────────────────────
function init() {
  // Check for room in URL params
  const params = new URLSearchParams(location.search);
  const roomParam = params.get("room");
  if (roomParam) {
    inputRoom.value = roomParam;
  }

  try {
    inputName.value = localStorage.getItem(NAME_STORAGE_KEY) ?? "";
  } catch {}

  // Fetch server info
  fetch("/api/info")
    .then((r) => r.json())
    .then((info: any) => {
      serverInfo.textContent = `${info.peers} ${info.peers === 1 ? "device" : "devices"} online`;
    })
    .catch(() => {});

  // Generate a default room code
  if (!inputRoom.value) {
    inputRoom.value = generateRoomCode();
  }

  // Focus the first thing that still needs input
  if (inputName.value) btnJoin.focus();
  else inputName.focus();

  // Connect WebSocket
  connect();

  // Set favicon dynamically (avoids Bun HTML bundler resolving the path)
  const faviconLink = document.createElement("link");
  faviconLink.rel = "icon";
  faviconLink.type = "image/svg+xml";
  faviconLink.href = "/favicon.svg";
  document.head.appendChild(faviconLink);

  // Apple touch icon (injected dynamically to avoid bundler resolving the file)
  const appleTouchIcon = document.createElement("link");
  appleTouchIcon.rel = "apple-touch-icon";
  appleTouchIcon.href = "/apple-touch-icon.png";
  document.head.appendChild(appleTouchIcon);

  // Web app manifest (injected dynamically to avoid bundler resolving the file)
  const manifestLink = document.createElement("link");
  manifestLink.rel = "manifest";
  manifestLink.href = "/manifest.json";
  document.head.appendChild(manifestLink);

  // Set logo images dynamically
  const logoJoin = document.getElementById("logo-join") as HTMLImageElement | null;
  const logoHeader = document.getElementById("logo-header") as HTMLImageElement | null;
  if (logoJoin) logoJoin.src = "/favicon.svg";
  if (logoHeader) logoHeader.src = "/favicon.svg";

  renderFeed();
  updateStatus(false);
  refreshIcons();
}

init();
