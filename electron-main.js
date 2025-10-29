import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron';
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
    const { startServer: importedStartServer } = await import('./index.js');
    startServer = importedStartServer;
    
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
