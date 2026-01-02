const { app, BrowserWindow, ipcMain, Menu, shell, screen, Tray, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execFile } = require('child_process');
const log = require('electron-log');
const sudo = require('sudo-prompt');

// Helper daemon modules
const helperClient = require('./helper/ipc-client');
const helperInstaller = require('./helper/installer');

let mainWindow;
let tray;
let blockingInterval;

// Data file path for persistent storage
const dataPath = path.join(app.getPath('userData'), 'redd-block-data.json');

// Ensure logs go to a file
log.transports.file.level = 'info';

// Default data structure
const defaultData = {
    blocklists: [],
    activeBlocks: [],
    settings: {
        onboardingComplete: false
    }
};

// Load data from file
function loadData() {
    try {
        if (fs.existsSync(dataPath)) {
            return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        }
    } catch (e) {
        log.error('Error loading data:', e);
    }
    return defaultData;
}

// Save data to file
function saveData(data) {
    try {
        fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
    } catch (e) {
        log.error('Error saving data:', e);
    }
}

function createMenu() {
    const isMac = process.platform === 'darwin';

    const template = [
        ...(isMac ? [{
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        }] : []),
        {
            label: 'File',
            submenu: [
                isMac ? { role: 'close' } : { role: 'quit' }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                ...(isMac ? [
                    { role: 'pasteAndMatchStyle' },
                    { role: 'delete' },
                    { role: 'selectAll' }
                ] : [
                    { role: 'delete' },
                    { type: 'separator' },
                    { role: 'selectAll' }
                ])
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        {
            label: 'Window',
            submenu: [
                { role: 'minimize' },
                { role: 'zoom' },
                ...(isMac ? [
                    { type: 'separator' },
                    { role: 'front' },
                    { type: 'separator' },
                    { role: 'window' }
                ] : [
                    { role: 'close' }
                ])
            ]
        },
        {
            role: 'help',
            submenu: [
                {
                    label: 'Learn More',
                    click: async () => {
                        await shell.openExternal('https://reddfocus.org');
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 840,
        height: 650,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        },
        frame: false,
        resizable: true,
        minimizable: true,
        maximizable: true,
        closable: true,
        titleBarStyle: 'hidden',
        icon: path.join(__dirname, 'src/images/icon.png')
    });

    mainWindow.loadFile('src/index.html');

    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// Create system tray for background operation
function createTray() {
    const iconPath = path.join(__dirname, 'assets/icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon.resize({ width: 16, height: 16 }));

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Open ReDD Block',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                } else {
                    createMainWindow();
                }
            }
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                app.quit();
            }
        }
    ]);

    tray.setToolTip('ReDD Block');
    tray.setContextMenu(contextMenu);
}

// IPC handlers
ipcMain.handle('get-app-version', () => {
    return app.getVersion();
});

ipcMain.handle('load-data', () => {
    return loadData();
});

ipcMain.handle('save-data', (event, data) => {
    saveData(data);
    return true;
});

// Open app picker dialog (cross-platform)
ipcMain.handle('open-app-picker', async () => {
    let defaultPath = '/Applications';
    let filters = [{ name: 'Applications', extensions: ['app'] }];

    if (process.platform === 'win32') {
        defaultPath = 'C:\\Program Files';
        filters = [{ name: 'Executables', extensions: ['exe'] }];
    } else if (process.platform === 'linux') {
        defaultPath = '/usr/share/applications';
        filters = [{ name: 'Desktop Files', extensions: ['desktop'] }];
    }

    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Application to Block',
        defaultPath: defaultPath,
        properties: ['openFile'],
        filters: filters
    });

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    // Extract app name from path based on platform
    const appPath = result.filePaths[0];
    let appName;

    if (process.platform === 'darwin') {
        // macOS: /Applications/Safari.app -> Safari
        appName = path.basename(appPath, '.app');
    } else if (process.platform === 'win32') {
        // Windows: C:\Program Files\App\app.exe -> app
        appName = path.basename(appPath, '.exe');
    } else {
        // Linux: /usr/share/applications/firefox.desktop -> firefox
        appName = path.basename(appPath, '.desktop');
    }

    return appName;
});

// Get running applications (macOS)
ipcMain.handle('get-running-apps', async () => {
    if (process.platform !== 'darwin') return [];

    return new Promise((resolve) => {
        const script = `
      const apps = Application("System Events").processes.whose({backgroundOnly: false}).name();
      JSON.stringify(apps);
    `;

        exec(`osascript -l JavaScript -e '${script}'`, (error, stdout) => {
            if (error) {
                log.error('Error getting running apps:', error);
                resolve([]);
                return;
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (e) {
                resolve([]);
            }
        });
    });
});

// Minimize an application (macOS)
ipcMain.handle('minimize-app', async (event, appName) => {
    if (process.platform !== 'darwin') return false;

    return new Promise((resolve) => {
        const script = `
      tell application "System Events"
        set visible of process "${appName}" to false
      end tell
    `;

        exec(`osascript -e '${script}'`, (error) => {
            if (error) {
                log.error('Error minimizing app:', error);
                resolve(false);
                return;
            }
            resolve(true);
        });
    });
});

// Block websites using SelfControl-style dual approach:
// 1. Modify hosts file (with 0.0.0.0 and :: for IPv6)
// 2. Use pf (packet filter) firewall with proper anchor system
ipcMain.handle('block-websites', async (event, domains) => {
    const hostsPath = '/etc/hosts';
    const pfAnchorPath = '/etc/pf.anchors/com.redd.block';
    const pfConfPath = '/etc/pf.conf';
    const blockMarkerStart = '# BEGIN REDD BLOCK';
    const blockMarkerEnd = '# END REDD BLOCK';
    const pfAnchorName = 'com.redd.block';

    // Clean domains
    const cleanDomains = domains.map(d => d.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));

    if (cleanDomains.length === 0) {
        // Remove all blocking
        return new Promise((resolve) => {
            // Command to clear hosts file entries, pf rules, and remove anchor from pf.conf
            const clearCommand = `
                # Remove hosts file entries
                if grep -q "${blockMarkerStart}" ${hostsPath}; then
                    sed -i '' '/${blockMarkerStart}/,/${blockMarkerEnd}/d' ${hostsPath}
                fi
                
                # Clear pf anchor
                pfctl -a ${pfAnchorName} -F all 2>/dev/null || true
                
                # Remove anchor from pf.conf if present
                if grep -q "${pfAnchorName}" ${pfConfPath}; then
                    sed -i '' '/${pfAnchorName}/d' ${pfConfPath}
                fi
                
                # Flush DNS cache
                dscacheutil -flushcache
                killall -HUP mDNSResponder 2>/dev/null || true
                
                echo "Block cleared successfully"
            `;

            sudo.exec(clearCommand, { name: 'ReDD Block' }, (error, stdout, stderr) => {
                if (error && !error.message.includes('User did not grant permission')) {
                    log.warn('Error clearing block:', error);
                }
                log.info('Blocking rules cleared');
                resolve({ success: true });
            });
        });
    }

    // Resolve domains to IPs for pf rules
    const dns = require('dns').promises;
    const ipsToBlock = new Set();

    for (const domain of cleanDomains) {
        try {
            const addresses = await dns.resolve4(domain).catch(() => []);
            const wwwAddresses = await dns.resolve4(`www.${domain}`).catch(() => []);
            addresses.forEach(ip => ipsToBlock.add(ip));
            wwwAddresses.forEach(ip => ipsToBlock.add(ip));
        } catch (e) {
            log.warn(`Could not resolve ${domain}:`, e);
        }
    }

    // Build hosts file entries (SelfControl style: 0.0.0.0 and :: for IPv6)
    let hostsEntries = `\n${blockMarkerStart}\n`;
    for (const domain of cleanDomains) {
        hostsEntries += `0.0.0.0\t${domain}\n`;
        hostsEntries += `::\t${domain}\n`;
        hostsEntries += `0.0.0.0\twww.${domain}\n`;
        hostsEntries += `::\twww.${domain}\n`;
    }
    hostsEntries += `${blockMarkerEnd}\n`;

    // Build pf rules (SelfControl style: block return out)
    let pfRules = `# ReDD Block pf rules - generated ${new Date().toISOString()}\n`;
    pfRules += `# Options\n`;
    pfRules += `set block-policy drop\n`;
    pfRules += `set skip on lo0\n\n`;

    for (const ip of ipsToBlock) {
        pfRules += `block return out proto tcp from any to ${ip}\n`;
        pfRules += `block return out proto udp from any to ${ip}\n`;
    }

    // Also block by domain for good measure (if DNS bypassed)
    for (const domain of cleanDomains) {
        pfRules += `block return out proto tcp from any to ${domain}\n`;
        pfRules += `block return out proto udp from any to ${domain}\n`;
    }

    // Write temp files
    const tempHostsPath = path.join(app.getPath('temp'), 'redd-hosts-' + Date.now());
    const tempPfPath = path.join(app.getPath('temp'), 'redd-pf-' + Date.now());

    return new Promise((resolve) => {
        try {
            // Read current hosts file and append our entries
            let currentHosts = '';
            try {
                currentHosts = fs.readFileSync(hostsPath, 'utf8');
            } catch (e) {
                log.warn('Could not read hosts file, starting fresh');
            }

            // Remove any existing ReDD Block entries
            const startIdx = currentHosts.indexOf(blockMarkerStart);
            const endIdx = currentHosts.indexOf(blockMarkerEnd);
            if (startIdx !== -1 && endIdx !== -1) {
                currentHosts = currentHosts.substring(0, startIdx) + currentHosts.substring(endIdx + blockMarkerEnd.length);
            }

            // Append new entries
            const newHosts = currentHosts.trim() + hostsEntries;
            fs.writeFileSync(tempHostsPath, newHosts);
            fs.writeFileSync(tempPfPath, pfRules);
        } catch (e) {
            log.error('Error writing temp files:', e);
            return resolve({ success: false, error: 'Cannot write temp files' });
        }

        // SelfControl-style command sequence:
        // 1. Copy hosts file
        // 2. Create pf anchor file
        // 3. Add anchor to pf.conf if not present
        // 4. Enable pf and load rules
        // 5. Flush DNS cache
        const command = `
            # Copy hosts file
            cp "${tempHostsPath}" "${hostsPath}"
            chmod 644 "${hostsPath}"
            
            # Create pf anchor directory if needed
            mkdir -p /etc/pf.anchors
            
            # Copy pf rules to anchor file
            cp "${tempPfPath}" "${pfAnchorPath}"
            chmod 644 "${pfAnchorPath}"
            
            # Add anchor to pf.conf if not already there
            if ! grep -q "${pfAnchorName}" "${pfConfPath}"; then
                echo '' >> "${pfConfPath}"
                echo 'anchor "${pfAnchorName}"' >> "${pfConfPath}"
                echo 'load anchor "${pfAnchorName}" from "${pfAnchorPath}"' >> "${pfConfPath}"
            fi
            
            # Enable pf and load the configuration
            pfctl -e 2>/dev/null || true
            pfctl -f "${pfConfPath}" 2>/dev/null || true
            
            # Flush DNS cache
            dscacheutil -flushcache
            killall -HUP mDNSResponder 2>/dev/null || true
            
            # Show loaded rules for debugging
            pfctl -a ${pfAnchorName} -sr 2>/dev/null || echo "No rules loaded"
            
            echo "Block applied successfully"
        `;

        sudo.exec(command, { name: 'ReDD Block' }, (error, stdout, stderr) => {
            // Clean up temp files
            try {
                if (fs.existsSync(tempHostsPath)) fs.unlinkSync(tempHostsPath);
                if (fs.existsSync(tempPfPath)) fs.unlinkSync(tempPfPath);
            } catch (e) {
                log.warn('Could not clean up temp files:', e);
            }

            if (error) {
                if (error.message && error.message.includes('User did not grant permission')) {
                    log.info('User cancelled password prompt');
                    return resolve({ success: false, error: 'Permission denied', cancelled: true });
                }
                log.error('Error applying block:', error);
                return resolve({ success: false, error: error.message });
            }

            log.info(`Blocked ${cleanDomains.length} domains (${ipsToBlock.size} IPs) using hosts file + pf firewall`);
            log.info('stdout:', stdout);
            if (stderr) log.warn('stderr:', stderr);
            resolve({ success: true });
        });
    });
});

// ============================================
// HELPER DAEMON IPC HANDLERS (passwordless blocking)
// ============================================

// Check if the helper daemon is installed and running
ipcMain.handle('check-helper-status', async () => {
    const installed = helperInstaller.isHelperInstalled();
    let running = false;

    if (installed) {
        try {
            running = await helperClient.isRunning();
        } catch (err) {
            log.warn('Helper not responding:', err.message);
        }
    }

    return { installed, running };
});

// Install the helper daemon (requires one-time password)
ipcMain.handle('install-helper', async () => {
    try {
        await helperInstaller.installHelper();

        // Wait longer for the daemon to start, with retries
        let running = false;
        for (let i = 0; i < 5; i++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            try {
                running = await helperClient.isRunning();
                if (running) break;
            } catch (err) {
                log.info(`Helper not ready yet, attempt ${i + 1}/5`);
            }
        }

        log.info('Helper installation complete, running:', running);
        return { success: true, running };
    } catch (err) {
        log.error('Failed to install helper:', err);
        return { success: false, error: err.message };
    }
});

// Start a block via the helper daemon (no password required!)
ipcMain.handle('start-block-via-helper', async (event, { domains, endTime, blocklistId }) => {
    try {
        const result = await helperClient.startBlock(domains, endTime, blocklistId);
        log.info('Started block via helper:', result);
        return result;
    } catch (err) {
        log.error('Failed to start block via helper:', err);
        return { success: false, error: err.message };
    }
});

// Clear a block via the helper daemon (no password required!)
ipcMain.handle('clear-block-via-helper', async () => {
    try {
        const result = await helperClient.clearBlock();
        log.info('Cleared block via helper:', result);
        return result;
    } catch (err) {
        log.error('Failed to clear block via helper:', err);
        return { success: false, error: err.message };
    }
});

// Get block status from the helper daemon
ipcMain.handle('get-helper-block-status', async () => {
    try {
        return await helperClient.getStatus();
    } catch (err) {
        log.error('Failed to get helper status:', err);
        return { active: false, error: err.message };
    }
});

// Fallback: Block websites by modifying hosts file (for Windows/Linux)
async function blockWebsitesViaHosts(domains) {
    const hostsPath = process.platform === 'win32'
        ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
        : '/etc/hosts';

    let hostsContent;
    try {
        hostsContent = fs.readFileSync(hostsPath, 'utf8');
    } catch (e) {
        log.error('Error reading hosts file:', e);
        return { success: false, error: 'Cannot read hosts file' };
    }

    const blockMarkerStart = '# ReDD Block Start';
    const blockMarkerEnd = '# ReDD Block End';

    const startIdx = hostsContent.indexOf(blockMarkerStart);
    const endIdx = hostsContent.indexOf(blockMarkerEnd);
    if (startIdx !== -1 && endIdx !== -1) {
        hostsContent = hostsContent.substring(0, startIdx) + hostsContent.substring(endIdx + blockMarkerEnd.length);
    }

    if (domains.length > 0) {
        let blockEntries = `\n${blockMarkerStart}\n`;
        domains.forEach(domain => {
            const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
            blockEntries += `127.0.0.1\t${cleanDomain}\n`;
            blockEntries += `127.0.0.1\twww.${cleanDomain}\n`;
        });
        blockEntries += `${blockMarkerEnd}\n`;
        hostsContent = hostsContent.trim() + blockEntries;
    }

    return new Promise((resolve) => {
        const tempPath = path.join(app.getPath('temp'), 'hosts-temp-' + Date.now());

        try {
            fs.writeFileSync(tempPath, hostsContent);
        } catch (e) {
            log.error('Error writing temp file:', e);
            return resolve({ success: false, error: 'Cannot write temp file' });
        }

        let command;
        if (process.platform === 'win32') {
            command = `copy "${tempPath}" "${hostsPath}" && ipconfig /flushdns`;
        } else {
            command = `cp "${tempPath}" "${hostsPath}"`;
        }

        sudo.exec(command, { name: 'ReDD Block' }, (error) => {
            try {
                if (fs.existsSync(tempPath)) {
                    fs.unlinkSync(tempPath);
                }
            } catch (cleanupError) {
                log.warn('Could not clean up temp file:', cleanupError);
            }

            if (error) {
                if (error.message && error.message.includes('User did not grant permission')) {
                    return resolve({ success: false, error: 'Permission denied', cancelled: true });
                }
                log.error('Error writing hosts file:', error);
                return resolve({ success: false, error: error.message });
            }

            resolve({ success: true });
        });
    });
}


// Start blocking interval
function startBlockingInterval() {
    if (blockingInterval) return;

    blockingInterval = setInterval(async () => {
        const data = loadData();
        const now = Date.now();

        // Check for expired blocks
        let hasChanges = false;
        data.activeBlocks = data.activeBlocks.filter(block => {
            if (block.endTime <= now) {
                hasChanges = true;
                return false;
            }
            return true;
        });

        if (hasChanges) {
            saveData(data);
            // Update hosts file to remove expired blocks
            const allBlockedDomains = [];
            data.activeBlocks.forEach(block => {
                const blocklist = data.blocklists.find(bl => bl.id === block.blocklistId);
                if (blocklist) {
                    allBlockedDomains.push(...blocklist.websites);
                }
            });

            // This would need to be called differently since ipcMain.handle is for renderer
            // For now, we'll trigger a refresh
            if (mainWindow && mainWindow.webContents) {
                mainWindow.webContents.send('blocks-updated');
            }
        }

        // Minimize blocked apps
        if (process.platform === 'darwin') {
            const now = Date.now();
            const blockedApps = new Set();

            // Only include apps from currently active blocks (within time range)
            data.activeBlocks
                .filter(block => block.startTime <= now && block.endTime > now)
                .forEach(block => {
                    const blocklist = data.blocklists.find(bl => bl.id === block.blocklistId);
                    if (blocklist && blocklist.apps && blocklist.apps.length > 0) {
                        blocklist.apps.forEach(app => blockedApps.add(app));
                    }
                });

            if (blockedApps.size > 0) {
                log.info('Checking for blocked apps:', Array.from(blockedApps));

                // Get running apps and minimize blocked ones
                const script = `
          const apps = Application("System Events").processes.whose({backgroundOnly: false}).name();
          JSON.stringify(apps);
        `;

                exec(`osascript -l JavaScript -e '${script}'`, (error, stdout) => {
                    if (error) {
                        log.error('Error getting running apps:', error);
                        return;
                    }
                    try {
                        const runningApps = JSON.parse(stdout);
                        runningApps.forEach(appName => {
                            if (blockedApps.has(appName)) {
                                log.info('Hiding blocked app:', appName);
                                const hideScript = `
                  tell application "System Events"
                    set visible of process "${appName}" to false
                  end tell
                `;
                                exec(`osascript -e '${hideScript}'`, (err) => {
                                    if (err) log.error('Error hiding app:', err);
                                });
                            }
                        });
                    } catch (e) {
                        log.error('Error parsing running apps:', e);
                    }
                });
            }
        }
    }, 500); // Check every 500ms for responsive app blocking
}

// IPC listeners for window controls
ipcMain.on('window-minimize', () => {
    if (mainWindow) {
        mainWindow.minimize();
    }
});

ipcMain.on('window-maximize', () => {
    if (mainWindow) {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    }
});

ipcMain.on('window-close', () => {
    if (mainWindow) {
        mainWindow.hide(); // Hide instead of close to keep running in background
    }
});

app.on('ready', () => {
    createMainWindow();
    createMenu();
    createTray();
    startBlockingInterval();
});

app.on('window-all-closed', () => {
    // Don't quit on macOS - keep running in background
    if (process.platform !== 'darwin') {
        // On Windows/Linux, also keep running if there are active blocks
        const data = loadData();
        if (data.activeBlocks.length === 0) {
            app.quit();
        }
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createMainWindow();
    } else {
        mainWindow.show();
    }
});

app.on('before-quit', () => {
    // Clean up hosts file on quit (optional - could leave blocks in place)
    if (blockingInterval) {
        clearInterval(blockingInterval);
    }
});
