require('dotenv').config();
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = process.env.PORT || 3000;
let serverProcess;

function waitForServer(port, maxMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      if (Date.now() - start > maxMs) {
        return reject(new Error(`Server did not start on port ${port} within ${maxMs}ms`));
      }
      const req = http.get(`http://localhost:${port}/`, res => {
        res.resume();
        resolve();
      });
      req.on('error', () => setTimeout(attempt, 250));
      req.setTimeout(500, () => { req.destroy(); setTimeout(attempt, 250); });
    }
    attempt();
  });
}

app.whenReady().then(async () => {
  // Spawn using system node (not Electron's built-in node) so native modules work
  serverProcess = spawn('node', [path.join(__dirname, 'server.js')], {
    env: { ...process.env },
    stdio: ['ignore', 'inherit', 'inherit']
  });

  serverProcess.on('error', err => {
    console.error('Server process error:', err.message);
  });

  try {
    await waitForServer(PORT);
  } catch (err) {
    console.error(err.message);
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Spike',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  win.loadURL(`http://localhost:${PORT}`);

  win.on('closed', () => {
    if (serverProcess) serverProcess.kill();
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});
