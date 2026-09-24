import { app, BrowserWindow, Tray, Menu, nativeImage, desktopCapturer, screen, systemPreferences, ipcMain, session } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow = null;
let tray = null;
let serverInfo = null;

// Set data directory before importing index.js
// Delay import until app is ready so we can set the environment variable
let startServer;

const MAX_STREAM_WIDTH = 1600;
const STREAM_JPEG_QUALITY = 70;

const screenHostToken = randomUUID();

let hostWindow = null;
let hostReady = null;
// 'loopbackWithMute' captures system audio while silencing the computer's speakers
// (Windows); plain 'loopback' captures without muting.
let loopbackMode = 'loopback';

// Desktop size in the units the mouse uses: physical pixels on Windows/Linux, points on macOS.
function primaryDisplayInfo() {
  const display = screen.getPrimaryDisplay();
  const pointUnits = process.platform === 'darwin';
  return {
    display,
    pixelWidth: Math.round(display.size.width * display.scaleFactor),
    pixelHeight: Math.round(display.size.height * display.scaleFactor),
    width: pointUnits ? display.size.width : Math.round(display.size.width * display.scaleFactor),
    height: pointUnits ? display.size.height : Math.round(display.size.height * display.scaleFactor)
  };
}

function getDesktopSize() {
  const { width, height } = primaryDisplayInfo();
  return { width, height };
}

async function findScreenSource(thumbnailSize = { width: 0, height: 0 }) {
  const { display } = primaryDisplayInfo();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  const source = sources.find(s => s.display_id === String(display.id)) || sources[0];
  if (!source) throw new Error('No screen source available');
  return source;
}

function stopHostWindow() {
  hostReady = null;
  if (hostWindow && !hostWindow.isDestroyed()) hostWindow.destroy();
  hostWindow = null;
}

// A hidden window keeps a live desktop MediaStream open and streams it to phones over
// WebRTC (hardware-encoded video + system audio). It also hands out JPEG frames for the
// socket fallback, which takes milliseconds instead of a desktopCapturer round trip.
function ensureHostWindow() {
  if (hostReady) return hostReady;
  hostReady = (async () => {
    const source = await findScreenSource();
    hostWindow = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        preload: join(__dirname, 'electron', 'screen-host-preload.cjs')
      }
    });
    hostWindow.on('closed', () => {
      hostWindow = null;
      hostReady = null;
    });
    const query = new URLSearchParams({ token: screenHostToken, source: source.id });
    await hostWindow.loadURL(`http://localhost:${serverInfo.port}/screen-host?${query}`);
  })();
  hostReady.catch((err) => {
    console.error('[screen] host window failed', err);
    stopHostWindow();
  });
  return hostReady;
}

async function grabStreamFrame() {
  await ensureHostWindow();
  const dataUrl = await hostWindow.webContents.executeJavaScript(
    `window.grabFrame(${STREAM_JPEG_QUALITY / 100})`
  );
  if (!dataUrl) throw new Error('Screen stream produced no frames');
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

async function grabThumbnailFrame() {
  const { pixelWidth, pixelHeight } = primaryDisplayInfo();
  const scale = Math.min(1, MAX_STREAM_WIDTH / pixelWidth);
  const source = await findScreenSource({
    width: Math.round(pixelWidth * scale),
    height: Math.round(pixelHeight * scale)
  });
  if (source.thumbnail.isEmpty()) throw new Error('Screen thumbnail is empty');
  return source.thumbnail.toJPEG(STREAM_JPEG_QUALITY);
}

// JPEG capture for the socket fallback stream (Windows, macOS, Linux).
async function captureDesktop() {
  let image;
  try {
    image = await grabStreamFrame();
  } catch (err) {
    console.error('[screen] live stream capture failed, using thumbnail capture', err);
    image = await grabThumbnailFrame();
  }
  return { image, mime: 'image/jpeg', ...getDesktopSize() };
}

function createWindow(port, networkIP) {
  const url = `http://localhost:${port}/qr`;
  
  mainWindow = new BrowserWindow({
    width: 550,
    height: 650,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    },
    icon: join(__dirname, 'public', 'icon.png'),
    title: 'Unire Remote - QR Code',
    autoHideMenuBar: true
  });

  mainWindow.loadURL(url);

  // Refresh button is now part of the HTML, no injection needed

  // When window is closed, quit the app (user requested this behavior)
  mainWindow.on('close', (event) => {
    // Quit app immediately when window is closed
    app.quit();
  });

  // Prevent navigation away from QR page
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!navigationUrl.includes('/qr')) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });
}

function createTray(port, networkIP) {
  // Try to use icon.png, fallback to system default
  let trayIcon = null;
  try {
    trayIcon = nativeImage.createFromPath(join(__dirname, 'public', 'icon.png'));
    if (trayIcon.isEmpty()) {
      trayIcon = null;
    }
  } catch (err) {
    console.log('Could not load tray icon, using default');
  }

  tray = new Tray(trayIcon || nativeImage.createEmpty());
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show QR Code',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow(port, networkIP);
        }
      }
    },
    {
      label: 'Refresh QR Code',
      click: () => {
        if (mainWindow) {
          mainWindow.reload();
        }
      }
    },
    {
      label: `Server: ${networkIP}:${port}`,
      enabled: false
    },
    {
      type: 'separator'
    },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setToolTip(`Unire Remote - ${networkIP}:${port}`);
  tray.setContextMenu(contextMenu);

  // Show window on tray click (platform-specific)
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    } else {
      createWindow(port, networkIP);
    }
  });
}

app.whenReady().then(async () => {
  try {
    // Set data directory BEFORE importing index.js
    // This ensures the database path uses Electron's userData directory
    process.env.UNIRE_DATA_DIR = app.getPath('userData');
    
    // Now import index.js - database will use the correct path
    const { startServer: importedStartServer, setScreenCapturer, setScreenHost, dispatchRemoteInput } = await import('./index.js');
    startServer = importedStartServer;
    setScreenCapturer(captureDesktop);
    setScreenHost({ token: screenHostToken, ensure: ensureHostWindow, getDesktopSize });
    ipcMain.on('unire:input', (event, viewerId, message) => {
      if (!hostWindow || event.sender !== hostWindow.webContents) return;
      dispatchRemoteInput(viewerId, message);
    });
    ipcMain.handle('unire:loopback-mode', (event, muted) => {
      if (!hostWindow || event.sender !== hostWindow.webContents) return null;
      loopbackMode = muted && process.platform === 'win32' ? 'loopbackWithMute' : 'loopback';
      return loopbackMode;
    });
    // System audio for the phone: only the hidden host window may capture it.
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      const hostFrame = hostWindow && !hostWindow.isDestroyed() ? hostWindow.webContents.mainFrame : null;
      const fromHost = hostFrame && request.frame &&
        request.frame.processId === hostFrame.processId && request.frame.routingId === hostFrame.routingId;
      if (!fromHost) return callback({});
      try {
        callback({ video: await findScreenSource(), audio: loopbackMode });
      } catch {
        callback({});
      }
    });

    // macOS requires Screen Recording permission; asking early triggers the system prompt.
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
    }
    
    // Remove application menu
    Menu.setApplicationMenu(null);
    
    // Start the server
    serverInfo = await startServer();
    const { port, networkIP } = serverInfo;

    // Create window and tray
    createWindow(port, networkIP);
    createTray(port, networkIP);
  } catch (error) {
    console.error('Failed to start server:', error);
    app.quit();
  }
});

// Quit when all windows are closed (user requested app to stop when window closes)
app.on('window-all-closed', () => {
  app.quit();
});

// Quit when explicitly requested
app.on('before-quit', () => {
  if (tray) {
    tray.destroy();
  }
});
