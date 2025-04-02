import {
  app,
  session,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  MenuItem,
  Notification,
  powerSaveBlocker,
  Tray,
} from 'electron';
import { Buffer } from 'node:buffer';
import started from 'electron-squirrel-startup';
import path from 'node:path';
import { spawn } from 'child_process';
import 'dotenv/config';
import { startGoosed } from './goosed';
import { getBinaryPath } from './utils/binaryPath';
import { loadShellEnv } from './utils/loadEnv';
import log from './utils/logger';
import { addRecentDir, loadRecentDirs } from './utils/recentDirs';
import {
  createEnvironmentMenu,
  EnvToggles,
  loadSettings,
  saveSettings,
  updateEnvironmentVariables,
} from './utils/settings';
import * as crypto from 'crypto';
import * as electron from 'electron';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execCallback);

if (started) app.quit();

app.setAsDefaultProtocolClient('goose');

// Triggered when the user opens "goose://..." links
let firstOpenWindow: BrowserWindow;
let pendingDeepLink = null; // Store deep link if sent before React is ready
app.on('open-url', async (event, url) => {
  pendingDeepLink = url;

  // Parse the URL to determine the type
  const parsedUrl = new URL(url);

  const recentDirs = loadRecentDirs();
  const openDir = recentDirs.length > 0 ? recentDirs[0] : null;

  if (parsedUrl.hostname !== 'bot') {
    // For non URL types, reuse existing window if available
    const existingWindows = BrowserWindow.getAllWindows();
    if (existingWindows.length > 0) {
      firstOpenWindow = existingWindows[0];
      if (firstOpenWindow.isMinimized()) firstOpenWindow.restore();
      firstOpenWindow.focus();
    } else {
      firstOpenWindow = await createChat(app, undefined, openDir);
    }
  }

  // Handle extension install links and sessions
  if (parsedUrl.hostname === 'extension') {
    firstOpenWindow.webContents.send('add-extension', pendingDeepLink);
  } else if (parsedUrl.hostname === 'sessions') {
    firstOpenWindow.webContents.send('open-shared-session', pendingDeepLink);
  } else if (parsedUrl.hostname === 'bot') {
    let botConfig = null;

    // Extract bot config if it's a bot (miniagent) URL
    if (parsedUrl.hostname === 'bot') {
      const configParam = parsedUrl.searchParams.get('config');
      if (configParam) {
        try {
          botConfig = JSON.parse(Buffer.from(configParam, 'base64').toString('utf-8'));
        } catch (e) {
          console.error('Failed to parse bot config:', e);
        }
      }
    }

    firstOpenWindow = await createChat(app, undefined, openDir, undefined, undefined, botConfig);
  }
});

declare var MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare var MAIN_WINDOW_VITE_NAME: string;

// State for environment variable toggles
let envToggles: EnvToggles = loadSettings().envToggles;

// Parse command line arguments
const parseArgs = () => {
  const args = process.argv.slice(2); // Remove first two elements (electron and script path)
  let dirPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && i + 1 < args.length) {
      dirPath = args[i + 1];
      break;
    }
  }

  return { dirPath };
};

const getGooseProvider = () => {
  loadShellEnv(app.isPackaged);
  //{env-macro-start}//
  //needed when goose is bundled for a specific provider
  //{env-macro-end}//
  return [process.env.GOOSE_PROVIDER, process.env.GOOSE_MODEL];
};

const generateSecretKey = () => {
  const key = crypto.randomBytes(32).toString('hex');
  process.env.GOOSE_SERVER__SECRET_KEY = key;
  return key;
};

const getSharingUrl = () => {
  // checks app env for sharing url
  loadShellEnv(app.isPackaged); // will try to take it from the zshrc file
  // if GOOSE_BASE_URL_SHARE is found, we will set process.env.GOOSE_BASE_URL_SHARE, otherwise we return what it is set
  // to in the env at bundle time
  return process.env.GOOSE_BASE_URL_SHARE;
};

let [provider, model] = getGooseProvider();

let sharingUrl = getSharingUrl();

let appConfig = {
  GOOSE_PROVIDER: provider,
  GOOSE_MODEL: model,
  GOOSE_API_HOST: 'http://127.0.0.1',
  GOOSE_PORT: 0,
  GOOSE_WORKING_DIR: '',
  secretKey: generateSecretKey(),
};

// Track windows by ID
let windowCounter = 0;
const windowMap = new Map<number, BrowserWindow>();

const createChat = async (
  app,
  query?: string,
  dir?: string,
  version?: string,
  resumeSessionId?: string,
  botConfig?: any, // Bot configuration
  viewType?: string // View type
) => {
  // Apply current environment settings before creating chat
  updateEnvironmentVariables(envToggles);

  const [port, working_dir, goosedProcess] = await startGoosed(app, dir);

  const mainWindow = new BrowserWindow({
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 10 } : undefined,
    vibrancy: process.platform === 'darwin' ? 'window' : undefined,
    frame: process.platform === 'darwin' ? false : true,
    width: viewType === 'gooselingEditor' ? 900 : 750,
    height: viewType === 'gooselingEditor' ? 900 : 800,
    minWidth: 650,
    resizable: true,
    transparent: false,
    useContentSize: true,
    icon: path.join(__dirname, '../images/icon'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [
        JSON.stringify({
          ...appConfig,
          GOOSE_PORT: port,
          GOOSE_WORKING_DIR: working_dir,
          REQUEST_DIR: dir,
          GOOSE_BASE_URL_SHARE: sharingUrl,
          botConfig: botConfig,
        }),
      ],
      partition: 'persist:goose', // Add this line to ensure persistence
    },
  });

  // Handle new window creation for links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Open all links in external browser
    if (url.startsWith('http:') || url.startsWith('https:')) {
      require('electron').shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Load the index.html of the app.
  let queryParams = '';
  if (query) {
    queryParams = `?initialQuery=${encodeURIComponent(query)}`;
  }

  // Add resumeSessionId to query params if provided
  if (resumeSessionId) {
    queryParams = queryParams
      ? `${queryParams}&resumeSessionId=${encodeURIComponent(resumeSessionId)}`
      : `?resumeSessionId=${encodeURIComponent(resumeSessionId)}`;
  }

  // Add view type to query params if provided
  if (viewType) {
    queryParams = queryParams
      ? `${queryParams}&view=${encodeURIComponent(viewType)}`
      : `?view=${encodeURIComponent(viewType)}`;
  }

  const primaryDisplay = electron.screen.getPrimaryDisplay();
  const { width } = primaryDisplay.workAreaSize;

  // Increment window counter to track number of windows
  const windowId = ++windowCounter;
  const direction = windowId % 2 === 0 ? 1 : -1; // Alternate direction
  const initialOffset = 50;

  // Set window position with alternating offset strategy
  const baseXPosition = Math.round(width / 2 - mainWindow.getSize()[0] / 2);
  const xOffset = direction * initialOffset * Math.floor(windowId / 2);
  mainWindow.setPosition(baseXPosition + xOffset, 100);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}${queryParams}`);
  } else {
    // In production, we need to use a proper file protocol URL with correct base path
    const indexPath = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
    console.log('Loading production path:', indexPath);
    mainWindow.loadFile(indexPath, {
      search: queryParams ? queryParams.slice(1) : undefined,
    });
  }

  // Set up local keyboard shortcuts that only work when the window is focused
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'r' && input.meta) {
      mainWindow.reload();
      event.preventDefault();
    }

    if (input.key === 'i' && input.alt && input.meta) {
      mainWindow.webContents.openDevTools();
      event.preventDefault();
    }
  });

  windowMap.set(windowId, mainWindow);
  mainWindow.on('closed', () => {
    windowMap.delete(windowId);
    goosedProcess.kill();
  });
  return mainWindow;
};

const createTray = () => {
  const isDev = process.env.NODE_ENV === 'development';
  let iconPath: string;

  if (isDev) {
    iconPath = path.join(process.cwd(), 'src', 'images', 'iconTemplate.png');
  } else {
    iconPath = path.join(process.resourcesPath, 'images', 'iconTemplate.png');
  }

  const tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Window', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setToolTip('Goose');
  tray.setContextMenu(contextMenu);
};

const showWindow = async () => {
  const windows = BrowserWindow.getAllWindows();

  if (windows.length === 0) {
    log.info('No windows are open, creating a new one...');
    const recentDirs = loadRecentDirs();
    const openDir = recentDirs.length > 0 ? recentDirs[0] : null;
    await createChat(app, undefined, openDir);
    return;
  }

  // Define the initial offset values
  const initialOffsetX = 30;
  const initialOffsetY = 30;

  // Iterate over all windows
  windows.forEach((win, index) => {
    const currentBounds = win.getBounds();
    const newX = currentBounds.x + initialOffsetX * index;
    const newY = currentBounds.y + initialOffsetY * index;

    win.setBounds({
      x: newX,
      y: newY,
      width: currentBounds.width,
      height: currentBounds.height,
    });

    if (!win.isVisible()) {
      win.show();
    }

    win.focus();
  });
};

const buildRecentFilesMenu = () => {
  const recentDirs = loadRecentDirs();
  return recentDirs.map((dir) => ({
    label: dir,
    click: () => {
      createChat(app, undefined, dir);
    },
  }));
};

const openDirectoryDialog = async (replaceWindow: boolean = false) => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    addRecentDir(result.filePaths[0]);
    if (replaceWindow) {
      BrowserWindow.getFocusedWindow().close();
    }
    createChat(app, undefined, result.filePaths[0]);
  }
};

// Global error handler
const handleFatalError = (error: Error) => {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach((win) => {
    win.webContents.send('fatal-error', error.message || 'An unexpected error occurred');
  });
};

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  handleFatalError(error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
  handleFatalError(error instanceof Error ? error : new Error(String(error)));
});

ipcMain.on('react-ready', (event) => {
  console.log('React ready event received');

  if (pendingDeepLink) {
    console.log('Processing pending deep link:', pendingDeepLink);
    const parsedUrl = new URL(pendingDeepLink);

    // Handle different deep link types
    if (parsedUrl.hostname === 'extension') {
      console.log('Sending add-extension event');
      firstOpenWindow.webContents.send('add-extension', pendingDeepLink);
    } else if (parsedUrl.hostname === 'sessions') {
      console.log('Sending open-shared-session event');
      firstOpenWindow.webContents.send('open-shared-session', pendingDeepLink);
    }
    // Bot URLs are handled directly through botConfig in additionalArguments
    pendingDeepLink = null;
  } else {
    console.log('No pending deep link to process');
  }
});

// Add file/directory selection handler
ipcMain.handle('select-file-or-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'openDirectory'],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('check-ollama', async () => {
  try {
    return new Promise((resolve) => {
      // Run `ps` and filter for "ollama"
      exec('ps aux | grep -iw "[o]llama"', (error, stdout, stderr) => {
        if (error) {
          console.error('Error executing ps command:', error);
          return resolve(false); // Process is not running
        }

        if (stderr) {
          console.error('Standard error output from ps command:', stderr);
          return resolve(false); // Process is not running
        }

        console.log('Raw stdout from ps command:', stdout);

        // Trim and check if output contains a match
        const trimmedOutput = stdout.trim();
        console.log('Trimmed stdout:', trimmedOutput);

        const isRunning = trimmedOutput.length > 0; // True if there's any output
        resolve(isRunning); // Resolve true if running, false otherwise
      });
    });
  } catch (err) {
    console.error('Error checking for Ollama:', err);
    return false; // Return false on error
  }
});

// Handle binary path requests
ipcMain.handle('get-binary-path', (event, binaryName) => {
  return getBinaryPath(app, binaryName);
});

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['Origin'] = 'http://localhost:5173';
    callback({ cancel: false, requestHeaders: details.requestHeaders });
  });

  // Test error feature - only enabled with GOOSE_TEST_ERROR=true
  if (process.env.GOOSE_TEST_ERROR === 'true') {
    console.log('Test error feature enabled, will throw error in 5 seconds');
    setTimeout(() => {
      console.log('Throwing test error now...');
      throw new Error('Test error: This is a simulated fatal error after 5 seconds');
    }, 5000);
  }

  // Parse command line arguments
  const { dirPath } = parseArgs();

  createTray();
  const recentDirs = loadRecentDirs();
  let openDir = dirPath || (recentDirs.length > 0 ? recentDirs[0] : null);
  createChat(app, undefined, openDir);

  // Get the existing menu
  const menu = Menu.getApplicationMenu();

  // App menu
  const appMenu = menu.items.find((item) => item.label === 'Goose');
  // add Settings to app menu after About
  appMenu.submenu.insert(1, new MenuItem({ type: 'separator' }));
  appMenu.submenu.insert(
    1,
    new MenuItem({
      label: 'Settings',
      accelerator: 'CmdOrCtrl+,',
      click() {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow) focusedWindow.webContents.send('set-view', 'settings');
      },
    })
  );
  appMenu.submenu.insert(1, new MenuItem({ type: 'separator' }));

  // Add Environment menu items to View menu
  const viewMenu = menu.items.find((item) => item.label === 'View');
  if (viewMenu) {
    viewMenu.submenu.append(new MenuItem({ type: 'separator' }));
    viewMenu.submenu.append(
      new MenuItem({
        label: 'Environment',
        submenu: Menu.buildFromTemplate(
          createEnvironmentMenu(envToggles, (newToggles) => {
            envToggles = newToggles;
            saveSettings({ envToggles: newToggles });
            updateEnvironmentVariables(newToggles);
          })
        ),
      })
    );
  }

  const fileMenu = menu?.items.find((item) => item.label === 'File');

  // open goose to specific dir and set that as its working space
  fileMenu.submenu.append(
    new MenuItem({
      label: 'Open Directory...',
      accelerator: 'CmdOrCtrl+O',
      click() {
        openDirectoryDialog();
      },
    })
  );

  // Add Recent Files submenu
  const recentFilesSubmenu = buildRecentFilesMenu();
  if (recentFilesSubmenu.length > 0) {
    fileMenu.submenu.append(new MenuItem({ type: 'separator' }));
    fileMenu.submenu.append(
      new MenuItem({
        label: 'Recent Directories',
        submenu: recentFilesSubmenu,
      })
    );
  }

  // Add menu items to File menu
  if (fileMenu && fileMenu.submenu) {
    fileMenu.submenu.append(
      new MenuItem({
        label: 'New Chat Window',
        accelerator: 'CmdOrCtrl+N',
        click() {
          ipcMain.emit('create-chat-window');
        },
      })
    );

    fileMenu.submenu.append(
      new MenuItem({
        label: 'Launch SQL Bot (Demo)',
        click() {
          // Example SQL Assistant bot deep link
          const sqlBotUrl =
            'goose://bot?config=eyJpZCI6InNxbC1hc3Npc3RhbnQiLCJuYW1lIjoiU1FMIEFzc2lzdGFudCIsImRlc2NyaXB0aW9uIjoiQSBzcGVjaWFsaXplZCBib3QgZm9yIFNRTCBxdWVyeSBoZWxwIiwiaW5zdHJ1Y3Rpb25zIjoiWW91IGFyZSBhbiBleHBlcnQgU1FMIGFzc2lzdGFudC4gSGVscCB1c2VycyB3cml0ZSBlZmZpY2llbnQgU1FMIHF1ZXJpZXMgYW5kIGRlc2lnbiBkYXRhYmFzZXMuIiwiYWN0aXZpdGllcyI6WyJIZWxwIG1lIG9wdGltaXplIHRoaXMgU1FMIHF1ZXJ5IiwiRGVzaWduIGEgZGF0YWJhc2Ugc2NoZW1hIGZvciBhIGJsb2ciLCJFeHBsYWluIFNRTCBqb2lucyB3aXRoIGV4YW1wbGVzIiwiQ29udmVydCB0aGlzIHF1ZXJ5IGZyb20gTXlTUUwgdG8gUG9zdGdyZVNRTCIsIkRlYnVnIHdoeSB0aGlzIFNRTCBxdWVyeSBpc24ndCB3b3JraW5nIl19';

          // Extract the bot config from the URL
          const configParam = new URL(sqlBotUrl).searchParams.get('config');
          let botConfig = null;
          if (configParam) {
            try {
              botConfig = JSON.parse(Buffer.from(configParam, 'base64').toString('utf-8'));
            } catch (e) {
              console.error('Failed to parse bot config:', e);
            }
          }

          // Create a new window
          const recentDirs = loadRecentDirs();
          const openDir = recentDirs.length > 0 ? recentDirs[0] : null;

          createChat(app, undefined, openDir, undefined, undefined, botConfig);
        },
      })
    );
  }

  Menu.setApplicationMenu(menu);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createChat(app);
    }
  });

  ipcMain.on(
    'create-chat-window',
    (_, query, dir, version, resumeSessionId, botConfig, viewType) => {
      if (!dir?.trim()) {
        const recentDirs = loadRecentDirs();
        dir = recentDirs.length > 0 ? recentDirs[0] : null;
      }
      createChat(app, query, dir, version, resumeSessionId, botConfig, viewType);
    }
  );

  ipcMain.on('directory-chooser', (_, replace: boolean = false) => {
    openDirectoryDialog(replace);
  });

  ipcMain.on('notify', (event, data) => {
    console.log('NOTIFY', data);
    new Notification({ title: data.title, body: data.body }).show();
  });

  ipcMain.on('logInfo', (_, info) => {
    log.info('from renderer:', info);
  });

  ipcMain.on('reload-app', () => {
    app.relaunch();
    app.exit(0);
  });

  let powerSaveBlockerId: number | null = null;

  ipcMain.handle('start-power-save-blocker', () => {
    log.info('Starting power save blocker...');
    if (powerSaveBlockerId === null) {
      powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
      log.info('Started power save blocker');
      return true;
    }
    return false;
  });

  ipcMain.handle('stop-power-save-blocker', () => {
    log.info('Stopping power save blocker...');
    if (powerSaveBlockerId !== null) {
      powerSaveBlocker.stop(powerSaveBlockerId);
      powerSaveBlockerId = null;
      log.info('Stopped power save blocker');
      return true;
    }
    return false;
  });

  // Handle binary path requests
  ipcMain.handle('get-binary-path', (event, binaryName) => {
    return getBinaryPath(app, binaryName);
  });

  // Handle metadata fetching from main process
  ipcMain.handle('fetch-metadata', async (_, url) => {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Goose/1.0)',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      console.error('Error fetching metadata:', error);
      throw error;
    }
  });

  ipcMain.on('open-in-chrome', (_, url) => {
    // On macOS, use the 'open' command with Chrome
    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Google Chrome', url]);
    } else if (process.platform === 'win32') {
      // On Windows, start is built-in command of cmd.exe
      spawn('cmd.exe', ['/c', 'start', '', 'chrome', url]);
    } else {
      // On Linux, use xdg-open with chrome
      spawn('xdg-open', [url]);
    }
  });

  ipcMain.handle('read-file', (event, filePath) => {
    return new Promise((resolve) => {
      exec(`cat ${filePath}`, (error, stdout, stderr) => {
        if (error) {
          // File not found
          resolve({ file: '', filePath, error: null, found: false });
        }
        if (stderr) {
          console.error('Error output:', stderr);
          resolve({ file: '', filePath, error, found: false });
        }
        resolve({ file: stdout, filePath, error: null, found: true });
      });
    });
  });

  ipcMain.handle('write-file', (event, filePath, content) => {
    return new Promise((resolve) => {
      const command = `cat << 'EOT' > ${filePath}
${content}
EOT`;
      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error('Error writing to file:', error);
          resolve(false);
        }
        if (stderr) {
          console.error('Error output:', stderr);
          resolve(false);
        }
        resolve(true);
      });
    });
  });
});

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
