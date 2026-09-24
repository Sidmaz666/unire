import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import QRCode from "qrcode";
import cookieParser from "cookie-parser";
import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import cors from "cors";
import os from "os";
import { exec } from "child_process";
import screenshot from "screenshot-desktop";

// ===== nut-js imports =====
import { mouse, Button, Point, keyboard, Key } from "@nut-tree-fork/nut-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, {
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: false
  }
});
let activePort = null;
let screenCaptureInFlight = null;
let nativeScreenCapturer = null;
// WebRTC screen host (Electron hidden window): { token, ensure(), getDesktopSize() }
let screenHost = null;
let screenHostSocket = null;
const screenHostWaiters = new Set();
const SCREEN_FRAME_INTERVAL_MS = 100;

// Basic middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors());

// Static assets (client)
app.use(express.static(path.join(__dirname, "public")));

// ===== SQLite setup (better-sqlite3) =====
// Use a writable location even when packaged (e.g., Electron ASAR is read-only)
const dataDirectory = process.env.UNIRE_DATA_DIR || __dirname;
try { fs.mkdirSync(dataDirectory, { recursive: true }); } catch {}
const dbPath = path.join(dataDirectory, "data.sqlite3");
const db = new Database(dbPath);
db.exec(`
CREATE TABLE IF NOT EXISTS qr_tokens (
  token TEXT PRIMARY KEY,
  created_at INTEGER,
  expires_at INTEGER,
  used INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  created_at INTEGER,
  expires_at INTEGER
);
`);

// config
// QR tokens never expire - removed expiry
const SESSION_EXPIRY_MS = 1000 * 60 * 60 * 6; // 6 hours

// ===== util functions =====
function getNetworkIP() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  const isVirtualAdapter = (name) =>
    /virtualbox|vboxnet|vmware|vmnet|hyper-v|veth|docker|wsl|tun|tap|utun|ppp|loopback|bluetooth/i.test(name);
  const isPhysicalAdapter = (name) =>
    /wi-?fi|wireless|wlan|ethernet|^eth\d|^en\d|^wlp|^enp|^wlx/i.test(name);

  for (const [name, entries] of Object.entries(interfaces)) {
    if (isVirtualAdapter(name)) continue;

    for (const iface of entries || []) {
      if (iface.family !== 'IPv4' || iface.internal || iface.address.startsWith('169.254.')) {
        continue;
      }

      const isHomeLanAddress = iface.address.startsWith('192.168.') ||
        iface.address.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(iface.address);
      const physical = isPhysicalAdapter(name);
      const priority = physical && iface.address.startsWith('192.168.') ? 0 :
        physical && isHomeLanAddress ? 1 : isHomeLanAddress ? 2 : 3;
      candidates.push({ address: iface.address, priority });
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0]?.address ?? 'localhost';
}

function now() {
  return Date.now();
}

function openUrl(url) {
  const platform = process.platform;
  if (platform === 'win32') {
    exec(`start "" "${url}"`);
  } else if (platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

function createQrToken() {
  const token = uuidv4();
  const created_at = now();
  // Set expiry to far future (effectively never expires) - year 2099
  const expires_at = new Date('2099-12-31').getTime();
  const stmt = db.prepare("INSERT INTO qr_tokens (token, created_at, expires_at) VALUES (?, ?, ?)");
  stmt.run(token, created_at, expires_at);
  return token;
}

function consumeQrToken(token) {
  const row = db.prepare("SELECT token, expires_at, used FROM qr_tokens WHERE token = ?").get(token);
  if (!row) return { ok: false, reason: "invalid" };
  if (row.used) return { ok: false, reason: "used" };
  // Removed expiry check - tokens never expire now
  // mark used
  db.prepare("UPDATE qr_tokens SET used = 1 WHERE token = ?").run(token);
  // create session
  const sid = uuidv4();
  db.prepare("INSERT INTO sessions (sid, created_at, expires_at) VALUES (?, ?, ?)").run(sid, now(), now() + SESSION_EXPIRY_MS);
  return { ok: true, sid };
}

function verifySession(sid) {
  if (!sid) return false;
  const row = db.prepare("SELECT sid, expires_at FROM sessions WHERE sid = ?").get(sid);
  if (!row) return false;
  if (row.expires_at < now()) return false;
  return true;
}

// ===== routes =====

// QR generation endpoint (GET /qr)
// Returns a page with a QR representing a one-time login URL for the remote
app.get("/qr", async (req, res) => {
  const token = createQrToken();
  // build url that phone should open - use network IP for WiFi access
  const networkIP = getNetworkIP();
  const port = activePort ?? process.env.PORT ?? 8000;
  const base = `http://${networkIP}:${port}`;
  const url = `${base}/auth?token=${token}`;

  try {
    // generate dataURL PNG
    const dataUrl = await QRCode.toDataURL(url, { margin: 2, width: 300 });
    // simple html page embedding QR
    res.type("html").send(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Scan to Open Remote</title>
        <style>
          body {
            font-family: Arial, Helvetica, sans-serif;
            text-align: center;
            padding: 20px;
            margin: 0;
            background: #fff;
          }
          h2 {
            margin-top: 0;
            color: #333;
          }
          img {
            max-width: 100%;
            height: auto;
            margin: 20px 0;
          }
          a {
            color: #007acc;
            text-decoration: none;
            word-break: break-all;
            display: inline-block;
            margin-bottom: 20px;
          }
          a:hover {
            text-decoration: underline;
          }
          .refresh-btn {
            padding: 12px 24px;
            background: transparent;
            border: 2px solid #007acc;
            color: #007acc;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-family: Arial, Helvetica, sans-serif;
            font-weight: 500;
            transition: all 0.2s ease;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            text-decoration: none;
          }
          .refresh-btn:hover {
            background: #007acc;
            color: #fff;
          }
          .refresh-btn:active {
            transform: scale(0.98);
          }
          .refresh-icon {
            width: 16px;
            height: 16px;
            display: inline-block;
          }
        </style>
      </head>
      <body>
        <h2>Scan this QR with your phone</h2>
        <img src="${dataUrl}" alt="qr"/>
        <p><a href="${url}">${url}</a></p>
        <button class="refresh-btn" onclick="window.location.reload()">
          <svg class="refresh-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
          </svg>
          Refresh QR Code
        </button>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("QR error", err);
    res.status(500).json({ error: "failed to generate QR" });
  }
});

// Auth endpoint user lands on when scanning QR (/auth?token=...)
app.get("/auth", (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send("missing token");

  const result = consumeQrToken(token);
  if (!result.ok) {
    return res.status(400).send(`Token error: ${result.reason}`);
  }
  // set cookie and redirect to remote UI
  const sid = result.sid;
  res.cookie("sid", sid, { httpOnly: true, maxAge: SESSION_EXPIRY_MS });
  // redirect to remote UI (/) — the UI will check auth on load
  res.redirect("/");
});

// Middleware to protect remote UI
app.get("/", (req, res, next) => {
  // serve html only if authenticated
  const sid = req.cookies?.sid;
  if (!verifySession(sid)) {
    // Not authenticated - show small page instructing to scan QR
    return res.type("html").send(`
      <!doctype html>
      <html>
      <head><meta charset="utf-8"><title>Not Authenticated</title></head>
      <body style="font-family: Arial; text-align:center; padding:30px;">
        <h2>Not authenticated</h2>
        <p>Please visit <strong>/qr</strong> on this machine and scan the QR code with your phone to authenticate.</p>
        <p><a href="/qr">Open /qr</a></p>
      </body>
      </html>
    `);
  }
  // If authenticated, serve the client UI file
  return res.sendFile(path.join(__dirname, "public", "index.html"));
});

// A small endpoint client will call to verify session (used by frontend)
app.get("/api/session", (req, res) => {
  const sid = req.cookies?.sid;
  res.json({ authenticated: verifySession(sid) });
});

// Session logout endpoint
app.post("/api/logout", (req, res) => {
  const sid = req.cookies?.sid;
  if (sid) {
    db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
    res.clearCookie("sid");
  }
  res.json({ ok: true });
});

// Get screen resolution
app.get("/api/screen", (req, res) => {
  res.json({
    width: process.env.SCREEN_WIDTH || 1920,
    height: process.env.SCREEN_HEIGHT || 1080
  });
});

app.get("/api/cursor", async (req, res) => {
  if (!verifySession(req.cookies?.sid)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const position = await mouse.getPosition();
    res.json({ x: position.x, y: position.y });
  } catch (err) {
    console.error("[cursor] error", err);
    res.status(503).json({ error: "cursor position unavailable" });
  }
});

// Electron provides a native capturer (desktopCapturer); plain Node falls back to screenshot-desktop.
export function setScreenCapturer(capturer) {
  nativeScreenCapturer = capturer;
}

export function setScreenHost(host) {
  screenHost = host;
}

function waitForScreenHost(timeoutMs) {
  if (screenHostSocket) return Promise.resolve(screenHostSocket);
  return new Promise((resolve, reject) => {
    const waiter = (hostSocket) => {
      clearTimeout(timer);
      screenHostWaiters.delete(waiter);
      resolve(hostSocket);
    };
    const timer = setTimeout(() => {
      screenHostWaiters.delete(waiter);
      reject(new Error("screen host did not start"));
    }, timeoutMs);
    screenHostWaiters.add(waiter);
  });
}

// Page for the hidden Electron window that captures the desktop and serves WebRTC peers.
app.get("/screen-host", (req, res) => {
  if (!screenHost || req.query.token !== screenHost.token) {
    return res.status(404).end();
  }
  res.sendFile(path.join(__dirname, "screen-host.html"));
});

async function captureScreenFrame() {
  if (nativeScreenCapturer) {
    try {
      const frame = await nativeScreenCapturer();
      if (frame?.image?.length) return frame;
    } catch (err) {
      console.error("[screen] native capture failed, falling back", err);
    }
  }
  const image = await screenshot({ format: "jpg" });
  return { image, mime: "image/jpeg", width: null, height: null };
}

function captureSharedScreenFrame() {
  if (!screenCaptureInFlight) {
    screenCaptureInFlight = captureScreenFrame().finally(() => {
      screenCaptureInFlight = null;
    });
  }
  return screenCaptureInFlight;
}

app.get("/api/screen-image", async (req, res) => {
  if (!verifySession(req.cookies?.sid)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const frame = await captureSharedScreenFrame();
    if (frame.width && frame.height) {
      res.set("X-Screen-Width", String(frame.width));
      res.set("X-Screen-Height", String(frame.height));
    }
    res.set("Cache-Control", "no-store");
    res.type(frame.mime).send(frame.image);
  } catch (err) {
    console.error("[screen-image] error", err);
    res.status(503).json({ error: "screen capture unavailable" });
  }
});

// ===== Socket.IO for remote control =====
// We'll use a single namespace. Only allow sockets from authenticated users (based on cookie).
io.use((socket, next) => {
  // Read cookie from handshake headers
  const cookieHeader = socket.handshake.headers.cookie || "";
  const cookies = Object.fromEntries(cookieHeader.split(";").map(c => {
    const parts = c.split("=").map(p => p.trim());
    return parts.length >= 2 ? [parts[0], decodeURIComponent(parts.slice(1).join("="))] : null;
  }).filter(Boolean));
  const sid = cookies?.sid;
  const captureToken = socket.handshake.auth?.captureToken;
  if (screenHost && captureToken && captureToken === screenHost.token) {
    socket.data.isScreenHost = true;
    return next();
  }
  if (!verifySession(sid)) {
    return next(new Error("unauthorized"));
  }
  return next();
});

const REMOTE_INPUT_EVENTS = new Set([
  "move", "moveTo", "click", "mousedown", "mouseup", "scroll", "keyboard", "action"
]);

// Input that arrived over a viewer's WebRTC data channel (relayed by the Electron host
// window). It runs through the same handlers as that viewer's socket events, so cursor
// and modifier state stay shared between both transports.
export function dispatchRemoteInput(viewerId, message) {
  let parsed;
  try {
    parsed = typeof message === "string" ? JSON.parse(message) : message;
  } catch {
    return;
  }
  const event = parsed?.e;
  if (!REMOTE_INPUT_EVENTS.has(event)) return;
  const viewerSocket = io.sockets.sockets.get(viewerId);
  if (!viewerSocket || viewerSocket.data.isScreenHost) return;
  for (const listener of viewerSocket.listeners(event)) listener(parsed.d);
}

function registerScreenHost(socket) {
  screenHostSocket = socket;
  for (const waiter of [...screenHostWaiters]) waiter(socket);

  socket.on("rtc:signal", ({ to, data } = {}) => {
    if (to) io.to(to).emit("rtc:signal", data);
  });
  socket.on("rtc:error", ({ to, message } = {}) => {
    if (to) io.to(to).emit("rtc:error", { message });
  });
  socket.on("input:signal", ({ to, data } = {}) => {
    if (to) io.to(to).emit("input:signal", data);
  });
  socket.on("disconnect", () => {
    if (screenHostSocket === socket) screenHostSocket = null;
    io.emit("rtc:error", { message: "Screen host stopped" });
  });
}

io.on("connection", (socket) => {
  if (socket.data.isScreenHost) {
    registerScreenHost(socket);
    return;
  }
  console.log("remote client connected", socket.id);

  // Track position in memory to avoid slow OS queries
  let cachedPos = { x: null, y: null };
  let positionInitialized = false;
  
  // Track active modifier keys for keyboard shortcuts
  let activeModifiers = {
    ctrl: false,
    alt: false,
    shift: false,
    windows: false
  };
  let leftMouseButtonDown = false;
  
  // Initialize position once on connection
  mouse.getPosition().then(pos => {
    cachedPos.x = pos.x;
    cachedPos.y = pos.y;
    positionInitialized = true;
  }).catch(() => {
    positionInitialized = true;
  });

  // Relative moves are applied to a cached position for speed; once movement pauses,
  // re-read the real cursor so the cache never drifts off-screen (e.g. after edges or
  // absolute jumps from screen mode), which made the trackpad feel unresponsive.
  let resyncTimer = null;
  function scheduleCursorResync() {
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => {
      mouse.getPosition().then(pos => {
        cachedPos.x = pos.x;
        cachedPos.y = pos.y;
      }).catch(() => {});
    }, 120);
  }

  // Sync position every 5 seconds to prevent drift
  const syncInterval = setInterval(() => {
    if (positionInitialized && cachedPos.x !== null) {
      mouse.getPosition().then(pos => {
        cachedPos.x = pos.x;
        cachedPos.y = pos.y;
      }).catch(() => {});
    }
  }, 5000);

  // Live screen stream: frames are pushed one at a time and the next frame is only
  // captured after the client acknowledges the previous one, so slow links never queue up.
  let screenStreaming = false;
  let screenStreamId = 0;
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  async function pumpScreenFrames(streamId) {
    const isCurrent = () => screenStreaming && streamId === screenStreamId && socket.connected;
    while (isCurrent()) {
      const startedAt = Date.now();
      try {
        const frame = await captureSharedScreenFrame();
        if (!isCurrent()) break;
        await new Promise(resolve => {
          socket.timeout(5000).emit("screen:frame", {
            image: frame.image,
            mime: frame.mime,
            width: frame.width,
            height: frame.height
          }, () => resolve());
        });
      } catch (err) {
        console.error("[screen] capture error", err);
        socket.emit("screen:error", { message: "Screen capture unavailable" });
        await wait(1000);
        continue;
      }
      await wait(Math.max(0, SCREEN_FRAME_INTERVAL_MS - (Date.now() - startedAt)));
    }
  }

  socket.on("screen:start", () => {
    if (screenStreaming) return;
    screenStreaming = true;
    pumpScreenFrames(++screenStreamId);
  });

  socket.on("screen:stop", () => {
    screenStreaming = false;
  });

  socket.on("move", (data) => {
    try {
      if (!data || typeof data.dx !== "number" || typeof data.dy !== "number") return;
      if (data.dx === 0 && data.dy === 0) return;

      // Use cached position if not initialized yet
      if (!positionInitialized) {
        setTimeout(() => {
          const tempX = cachedPos.x || 0;
          const tempY = cachedPos.y || 0;
          cachedPos.x = tempX + data.dx;
          cachedPos.y = tempY + data.dy;
          mouse.setPosition(new Point(cachedPos.x, cachedPos.y)).catch(() => {});
        }, 5);
        return;
      }

      // Update cached position INSTANTLY
      cachedPos.x += data.dx;
      cachedPos.y += data.dy;
      
      // Clamp to reasonable bounds
      cachedPos.x = Math.max(0, Math.min(cachedPos.x, 99999));
      cachedPos.y = Math.max(0, Math.min(cachedPos.y, 99999));

      // Set position WITHOUT waiting - FIRE AND FORGET for speed!
      mouse.setPosition(new Point(cachedPos.x, cachedPos.y)).catch(() => {});
      scheduleCursorResync();
    } catch (err) {
      console.error("[move] error", err);
    }
  });

  // Absolute move used by screen mode taps.
  socket.on("moveTo", (data) => {
    if (!data || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
    cachedPos.x = Math.round(data.x);
    cachedPos.y = Math.round(data.y);
    positionInitialized = true;
    mouse.setPosition(new Point(cachedPos.x, cachedPos.y)).catch(() => {});
    scheduleCursorResync();
  });

  // WebRTC screen view: signalling is relayed between this viewer and the screen host.
  socket.on("rtc:start", async (options, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    if (!screenHost) return reply({ ok: false, reason: "unsupported" });
    try {
      if (!screenHostSocket) screenHost.ensure();
      const hostSocket = await waitForScreenHost(10000);
      hostSocket.emit("rtc:start", {
        viewerId: socket.id,
        smooth: Boolean(options?.smooth)
      });
      reply({ ok: true, ...screenHost.getDesktopSize() });
    } catch (err) {
      console.error("[rtc] start failed", err);
      reply({ ok: false, reason: "host unavailable" });
    }
  });

  socket.on("rtc:signal", (data) => {
    if (screenHostSocket && data) screenHostSocket.emit("rtc:signal", { from: socket.id, data });
  });

  socket.on("rtc:stop", () => {
    if (screenHostSocket) screenHostSocket.emit("rtc:stop", { viewerId: socket.id });
  });

  // Low-latency input over WebRTC data channels (signalled through the screen host).
  socket.on("input:start", async (_options, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    if (!screenHost) return reply({ ok: false, reason: "unsupported" });
    try {
      if (!screenHostSocket) screenHost.ensure();
      await waitForScreenHost(10000);
      reply({ ok: true });
    } catch {
      reply({ ok: false, reason: "host unavailable" });
    }
  });

  socket.on("input:signal", (data) => {
    if (screenHostSocket && data) screenHostSocket.emit("input:signal", { from: socket.id, data });
  });

  socket.on("click", async (data) => {
    try {
      const btn = (data && data.button) ? data.button : "left";
      if (btn === "left") {
        await mouse.click(Button.LEFT);
      } else if (btn === "right") {
        await mouse.click(Button.RIGHT);
      } else {
        await mouse.click(Button.MIDDLE);
      }
    } catch (err) {
      console.error("[click] error", err);
    }
  });

  // Handle mouse button press (for drag operations)
  socket.on("mousedown", async (data) => {
    try {
      const btn = (data && data.button) ? data.button : "left";
      if (btn === "left") {
        await mouse.pressButton(Button.LEFT);
        leftMouseButtonDown = true;
      } else if (btn === "right") {
        await mouse.pressButton(Button.RIGHT);
      } else {
        await mouse.pressButton(Button.MIDDLE);
      }
    } catch (err) {
      console.error("[mousedown] error", err);
    }
  });

  // Handle mouse button release (for drag operations)
  socket.on("mouseup", async (data) => {
    try {
      const btn = (data && data.button) ? data.button : "left";
      if (btn === "left") {
        await mouse.releaseButton(Button.LEFT);
        leftMouseButtonDown = false;
      } else if (btn === "right") {
        await mouse.releaseButton(Button.RIGHT);
      } else {
        await mouse.releaseButton(Button.MIDDLE);
      }
    } catch (err) {
      console.error("[mouseup] error", err);
    }
  });

  // High-level actions from control row
  socket.on("action", async (data) => {
    try {
      if (!data || !data.type) return;
      const type = data.type;
      // Try multimedia keys first when available
      const press = async (k) => { try { await keyboard.type(k); } catch(_) {} };
      if (type === 'VolumeUp') {
        if (Key.AudioVolumeUp) { await press(Key.AudioVolumeUp); return; }
        // Fallbacks
        if (process.platform === 'darwin') { exec(`osascript -e "set volume output volume (output volume of (get volume settings) + 6) --100%"`); return; }
        if (process.platform === 'linux') { exec(`pactl set-sink-volume @DEFAULT_SINK@ +5% || amixer -D pulse sset Master 5%+`); return; }
        if (process.platform === 'win32') { exec(`powershell -Command "(new-object -ComObject WScript.Shell).SendKeys([char]175)"`); return; }
      }
      if (type === 'VolumeDown') {
        if (Key.AudioVolumeDown) { await press(Key.AudioVolumeDown); return; }
        if (process.platform === 'darwin') { exec(`osascript -e "set volume output volume (output volume of (get volume settings) - 6) --100%"`); return; }
        if (process.platform === 'linux') { exec(`pactl set-sink-volume @DEFAULT_SINK@ -5% || amixer -D pulse sset Master 5%-`); return; }
        if (process.platform === 'win32') { exec(`powershell -Command "(new-object -ComObject WScript.Shell).SendKeys([char]174)"`); return; }
      }
      if (type === 'BrightnessUp') {
        if (Key.BrightnessUp) { await press(Key.BrightnessUp); return; }
        if (process.platform === 'darwin') { exec(`osascript -e 'tell application "System Events" to key code 144'`); return; }
        if (process.platform === 'linux') { exec(`brightnessctl set +10% || xbacklight -inc 10`); return; }
        if (process.platform === 'win32') { exec(`powershell -NoProfile -Command "$b=(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness).CurrentBrightness; $m=(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness).Levels; $n=[math]::Min($b+10,100); (Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1,$n)"`); return; }
      }
      if (type === 'BrightnessDown') {
        if (Key.BrightnessDown) { await press(Key.BrightnessDown); return; }
        if (process.platform === 'darwin') { exec(`osascript -e 'tell application "System Events" to key code 145'`); return; }
        if (process.platform === 'linux') { exec(`brightnessctl set 10%- || xbacklight -dec 10`); return; }
        if (process.platform === 'win32') { exec(`powershell -NoProfile -Command "$b=(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness).CurrentBrightness; $n=[math]::Max($b-10,0); (Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1,$n)"`); return; }
      }

      // Fallbacks for opening URLs / apps
      if (type === 'OpenBrowser') {
        const url = 'https://www.google.com';
        openUrl(url);
        return;
      }
      if (type === 'OpenYouTube') {
        const url = 'https://www.youtube.com';
        openUrl(url);
        return;
      }
    } catch (err) {
      console.error('[action] error', err);
    }
  });

  // Scroll events - handle mouse wheel scrolling
  socket.on("scroll", async (data) => {
    try {
      if (!data || typeof data.delta !== "number") return;
      const delta = data.delta;
      
      // Convert pixel delta to scroll ticks based on intensity
      const ticks = Math.abs(delta) / 5; // Rough conversion
      const scrollAmount = Math.max(1, Math.min(ticks, 50)); // Clamp 1-50 ticks
      
      // Execute scroll based on direction - NO AWAIT for speed!
      if (delta > 0) {
        mouse.scrollDown(scrollAmount).catch(() => {});
      } else {
        mouse.scrollUp(scrollAmount).catch(() => {});
      }
    } catch (err) {
      console.error("[scroll] error", err);
    }
  });

  socket.on("keyboard", async (data) => {
    try {
      if (!data || !data.key) return;
      const keyValue = data.key;
      
      // Map string keys to nut-js Key enum
      const keyMap = {
        'Backspace': Key.Backspace,
        'Enter': Key.Enter,
        ' ': Key.Space,
        'Shift': Key.LeftShift,
        'Control': Key.LeftControl,
        'Alt': Key.LeftAlt,
        'Ctrl': Key.LeftControl,
        'Escape': Key.Escape,
        'Tab': Key.Tab,
        'Super': Key.LeftSuper, // Windows key
        'Windows': Key.LeftSuper, // Windows key alias
        'ContextMenu': Key.LeftSuper, // Menu key
        'CapsLock': Key.CapsLock,
        'ArrowUp': Key.Up,
        'ArrowDown': Key.Down,
        'ArrowLeft': Key.Left,
        'ArrowRight': Key.Right,
        'Home': Key.Home,
        'End': Key.End,
        'PageUp': Key.PageUp,
        'PageDown': Key.PageDown,
        'Delete': Key.Delete,
        'Del': Key.Delete,
        'F1': Key.F1,
        'F2': Key.F2,
        'F3': Key.F3,
        'F4': Key.F4,
        'F5': Key.F5,
        'F6': Key.F6,
        'F7': Key.F7,
        'F8': Key.F8,
        'F9': Key.F9,
        'F10': Key.F10,
        'F11': Key.F11,
        'F12': Key.F12
      };
      
      // Handle modifier keys as real press/release events for held shortcuts.
      if (keyValue === 'Ctrl' || keyValue === 'Control') {
        const isDown = data.action ? data.action === 'down' : !activeModifiers.ctrl;
        activeModifiers.ctrl = isDown;
        if (isDown) {
          await keyboard.pressKey(Key.LeftControl);
        } else {
          await keyboard.releaseKey(Key.LeftControl);
        }
        return;
      } else if (keyValue === 'Alt') {
        const isDown = data.action ? data.action === 'down' : !activeModifiers.alt;
        activeModifiers.alt = isDown;
        if (isDown) {
          await keyboard.pressKey(Key.LeftAlt);
        } else {
          await keyboard.releaseKey(Key.LeftAlt);
        }
        return;
      } else if (keyValue === 'Shift') {
        const isDown = data.action ? data.action === 'down' : !activeModifiers.shift;
        activeModifiers.shift = isDown;
        if (isDown) {
          await keyboard.pressKey(Key.LeftShift);
        } else {
          await keyboard.releaseKey(Key.LeftShift);
        }
        return;
      } else if (keyValue === 'Windows' || keyValue === 'Super') {
        const isDown = data.action ? data.action === 'down' : !activeModifiers.windows;
        activeModifiers.windows = isDown;
        if (isDown) {
          await keyboard.pressKey(Key.LeftSuper);
        } else {
          await keyboard.releaseKey(Key.LeftSuper);
        }
        return;
      }
      
      // Handle other keys with potential modifier combinations
      const nutKey = keyMap[keyValue];
      
      if (nutKey) {
        // Special key (arrow, function key, etc.)
        await keyboard.type(nutKey);
      } else if (keyValue.length === 1) {
        // Single character - handle with active modifiers
        if (activeModifiers.ctrl || activeModifiers.alt || activeModifiers.shift || activeModifiers.windows) {
          // Modifier keys are already held by their explicit down events.
          await keyboard.type(keyValue);
        } else {
          // No modifiers, just type normally
          await keyboard.type(keyValue);
        }
      }
    } catch (err) {
      console.error("[keyboard] error", err);
    }
  });

  socket.on("disconnect", () => {
    console.log("client disconnected", socket.id);
    screenStreaming = false;
    clearTimeout(resyncTimer);
    if (screenHostSocket) {
      screenHostSocket.emit("rtc:stop", { viewerId: socket.id });
      screenHostSocket.emit("input:stop", { viewerId: socket.id });
    }
    if (leftMouseButtonDown) {
      mouse.releaseButton(Button.LEFT).catch(() => {});
      leftMouseButtonDown = false;
    }
    const heldModifiers = [
      ['ctrl', Key.LeftControl],
      ['alt', Key.LeftAlt],
      ['shift', Key.LeftShift],
      ['windows', Key.LeftSuper]
    ];
    for (const [name, key] of heldModifiers) {
      if (activeModifiers[name]) {
        keyboard.releaseKey(key).catch(() => {});
        activeModifiers[name] = false;
      }
    }
    clearInterval(syncInterval);
  });
});

// Function to start server (can be called from Electron or standalone)
export function startServer(port = null) {
  const PORT = port || process.env.PORT || 8000;
  activePort = PORT;
  const networkIP = getNetworkIP();

  return new Promise((resolve) => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running at http://localhost:${PORT}/`);
      if (networkIP !== 'localhost') {
        console.log(`Network IP: http://${networkIP}:${PORT}/`);
      }
      console.log(`Open http://${networkIP}:${PORT}/qr on the desktop to scan with your phone.`);
      resolve({ port: PORT, networkIP });
    });
  });
}

// If running standalone (not from Electron), start server immediately
if (!process.versions.electron) {
  startServer();
}
