import { app, BrowserWindow, Tray, Menu, nativeImage, desktopCapturer, screen, systemPreferences } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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

const CAPTURE_IDLE_MS = 30 * 1000;

let captureWindow = null;
let captureReady = null;
let captureIdleTimer = null;

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

async function findScreenSource(thumbnailSize = { width: 0, height: 0 }) {
  const { display } = primaryDisplayInfo();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  const source = sources.find(s => s.display_id === String(display.id)) || sources[0];
  if (!source) throw new Error('No screen source available');
  return source;
}

function stopCaptureWindow() {
  clearTimeout(captureIdleTimer);
  captureIdleTimer = null;
  captureReady = null;
  if (captureWindow && !captureWindow.isDestroyed()) captureWindow.destroy();
  captureWindow = null;
}

// A hidden window keeps a live desktop MediaStream open, so grabbing a frame takes
// milliseconds instead of a full desktopCapturer.getSources() round trip per frame.
function startCaptureWindow() {
  if (captureReady) return captureReady;
  captureReady = (async () => {
    const source = await findScreenSource();
    captureWindow = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    });
    captureWindow.on('closed', () => {
      captureWindow = null;
      captureReady = null;
    });
    await captureWindow.loadFile(join(__dirname, 'screen-capture.html'));
    await captureWindow.webContents.executeJavaScript(
      `window.startCapture(${JSON.stringify(source.id)}, ${MAX_STREAM_WIDTH})`
    );
  })();
  captureReady.catch(() => stopCaptureWindow());
  return captureReady;
}

async function grabStreamFrame() {
  await startCaptureWindow();
  clearTimeout(captureIdleTimer);
  captureIdleTimer = setTimeout(stopCaptureWindow, CAPTURE_IDLE_MS);
  // The first frames can take a moment to arrive after the stream starts.
  for (let attempt = 0; attempt < 20; attempt++) {
    const dataUrl = await captureWindow.webContents.executeJavaScript(
      `window.grabFrame(${STREAM_JPEG_QUALITY / 100})`
    );
    if (dataUrl) return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Screen stream produced no frames');
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

// Captures the primary display with Electron's native capturer (Windows, macOS, Linux).
async function captureDesktop() {
  const { width, height } = primaryDisplayInfo();
  let image;
  try {
    image = await grabStreamFrame();
  } catch (err) {
    console.error('[screen] live stream capture failed, using thumbnail capture', err);
    stopCaptureWindow();
    image = await grabThumbnailFrame();
  }
  return { image, mime: 'image/jpeg', width, height };
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
    const { startServer: importedStartServer, setScreenCapturer } = await import('./index.js');
    startServer = importedStartServer;
    setScreenCapturer(captureDesktop);

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
