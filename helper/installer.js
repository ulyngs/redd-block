/**
 * Helper Installer for ReDD Block
 * 
 * This module handles the one-time installation of the privileged helper daemon.
 * It requires admin privileges to copy files and register the daemon service.
 */

const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const sudo = require('sudo-prompt');
const { app } = require('electron');

const HELPER_NAME = 'redd-block-helper';
const INSTALL_PATH = process.platform === 'win32'
    ? path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'ReDD Block', 'helper')
    : '/usr/local/lib/redd-block/helper';

const PLIST_PATH = '/Library/LaunchDaemons/org.reddfocus.redd-block-helper.plist';
const SYSTEMD_PATH = '/etc/systemd/system/redd-block-helper.service';

/**
 * Get the path to the helper files in the app bundle
 */
function getSourceHelperPath() {
    // In development, helper is in the project root
    // In production, it's in the app's resources
    const devPath = path.join(__dirname, '..', 'helper');
    const prodPath = path.join(process.resourcesPath, 'helper');

    if (fs.existsSync(devPath)) {
        return devPath;
    }
    return prodPath;
}

/**
 * Check if the helper is installed
 */
function isHelperInstalled() {
    if (process.platform === 'darwin') {
        return fs.existsSync(PLIST_PATH) && fs.existsSync(path.join(INSTALL_PATH, 'redd-block-helper.js'));
    } else if (process.platform === 'linux') {
        return fs.existsSync(SYSTEMD_PATH) && fs.existsSync(path.join(INSTALL_PATH, 'redd-block-helper.js'));
    } else if (process.platform === 'win32') {
        // Check if Windows service exists
        try {
            execSync('sc query "ReddBlockHelper"', { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }
    return false;
}

/**
 * Install the helper on macOS
 */
function installMacOS() {
    return new Promise((resolve, reject) => {
        const sourcePath = getSourceHelperPath();

        // Use the compiled binary (includes Node.js, no dependencies)
        const helperBinary = path.join(sourcePath, 'dist', 'redd-block-helper');

        // Check if compiled binary exists
        if (!fs.existsSync(helperBinary)) {
            return reject(new Error('Helper binary not found. Please rebuild the helper.'));
        }

        // Generate plist content - now just runs the binary directly (no Node required)
        const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>org.reddfocus.redd-block-helper</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>${INSTALL_PATH}/redd-block-helper</string>
    </array>
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>KeepAlive</key>
    <true/>
    
    <key>Nice</key>
    <integer>5</integer>
    
    <key>StandardOutPath</key>
    <string>/var/log/redd-block-helper.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/redd-block-helper.log</string>
</dict>
</plist>`;

        // Write plist to temp file
        const tempPlistPath = '/tmp/org.reddfocus.redd-block-helper.plist';
        fs.writeFileSync(tempPlistPath, plistContent);

        // Create install script
        const installScript = `
            # Create install directory
            mkdir -p "${INSTALL_PATH}"
            mkdir -p /var/lib/redd-block
            
            # Copy the compiled helper binary
            cp "${helperBinary}" "${INSTALL_PATH}/"
            
            # Copy generated plist
            cp "${tempPlistPath}" "${PLIST_PATH}"
            
            # Set permissions
            chmod 644 "${PLIST_PATH}"
            chmod 755 "${INSTALL_PATH}/redd-block-helper"
            chown -R root:wheel "${INSTALL_PATH}"
            
            # Load the daemon
            launchctl unload "${PLIST_PATH}" 2>/dev/null || true
            launchctl load -w "${PLIST_PATH}"
            
            echo "Helper installed successfully"
        `;

        sudo.exec(installScript, { name: 'ReDD Block Website Blocker' }, (error, stdout, stderr) => {
            if (error) {
                if (error.message && error.message.includes('User did not grant permission')) {
                    reject(new Error('Permission denied'));
                } else {
                    reject(error);
                }
            } else {
                console.log('Helper installation output:', stdout);
                if (stderr) console.warn('Helper installation stderr:', stderr);
                resolve(true);
            }
        });
    });
}

/**
 * Install the helper on Linux
 */
function installLinux() {
    return new Promise((resolve, reject) => {
        const sourcePath = getSourceHelperPath();
        const helperScript = path.join(sourcePath, 'redd-block-helper.js');
        const serviceSource = path.join(sourcePath, 'redd-block-helper.service');

        const installScript = `
            # Create install directory
            mkdir -p "${INSTALL_PATH}"
            mkdir -p /var/lib/redd-block
            
            # Copy helper files
            cp "${helperScript}" "${INSTALL_PATH}/"
            cp "${path.join(sourcePath, 'ipc-client.js')}" "${INSTALL_PATH}/"
            
            # Copy systemd service
            cp "${serviceSource}" "${SYSTEMD_PATH}"
            
            # Set permissions
            chmod 644 "${SYSTEMD_PATH}"
            chmod 755 "${INSTALL_PATH}/redd-block-helper.js"
            
            # Enable and start the service
            systemctl daemon-reload
            systemctl enable redd-block-helper
            systemctl start redd-block-helper
            
            echo "Helper installed successfully"
        `;

        sudo.exec(installScript, { name: 'ReDD Block' }, (error, stdout, stderr) => {
            if (error) {
                if (error.message && error.message.includes('User did not grant permission')) {
                    reject(new Error('Permission denied'));
                } else {
                    reject(error);
                }
            } else {
                console.log('Helper installation output:', stdout);
                if (stderr) console.warn('Helper installation stderr:', stderr);
                resolve(true);
            }
        });
    });
}

/**
 * Install the helper on Windows
 * Uses a Windows Service created via nssm (Non-Sucking Service Manager)
 * or alternatively a Scheduled Task running at SYSTEM level
 */
function installWindows() {
    return new Promise((resolve, reject) => {
        const sourcePath = getSourceHelperPath();

        // Use the compiled binary for Windows
        const helperBinary = path.join(sourcePath, 'dist', 'redd-block-helper-win.exe');

        // For development, check if we have a Windows binary, otherwise use node
        const hasWindowsBinary = fs.existsSync(helperBinary);

        // Create data directory
        const dataDir = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'ReDD Block');

        // Get the full path to node.exe - we're already running in Node so use process.execPath
        // This ensures SYSTEM user can find node even if it's not in system PATH
        const nodePath = process.execPath;

        // Build the script path for the helper
        const helperScriptPath = path.join(INSTALL_PATH, 'redd-block-helper.js');

        // Build PowerShell install script
        // For the scheduled task version, we need to be careful with escaping
        let installScript;

        if (hasWindowsBinary) {
            installScript = `
# Create install directory
New-Item -ItemType Directory -Force -Path "${INSTALL_PATH}"
New-Item -ItemType Directory -Force -Path "${dataDir}"

# Copy helper binary
Copy-Item "${helperBinary}" "${path.join(INSTALL_PATH, 'redd-block-helper.exe')}" -Force

# Create Windows Service using sc.exe
sc.exe create "ReddBlockHelper" binpath= "${path.join(INSTALL_PATH, 'redd-block-helper.exe')}" start= auto displayname= "ReDD Block Helper"
sc.exe description "ReddBlockHelper" "Background service for ReDD Block website blocker"
sc.exe start "ReddBlockHelper"

Write-Host "Helper installed successfully"
`;
        } else {
            // Development mode: run helper directly without scheduled task
            // This avoids SYSTEM user permission issues with named pipes

            // Build the script using string concatenation
            // Use single quotes in PowerShell for paths with spaces
            const scriptLines = [
                '# Create install directory',
                "New-Item -ItemType Directory -Force -Path '" + INSTALL_PATH + "'",
                "New-Item -ItemType Directory -Force -Path '" + dataDir + "'",
                '',
                '# Copy helper script files',
                "Copy-Item '" + path.join(sourcePath, 'redd-block-helper.js') + "' '" + INSTALL_PATH + "\\' -Force",
                "Copy-Item '" + path.join(sourcePath, 'ipc-client.js') + "' '" + INSTALL_PATH + "\\' -Force",
                '',
                '# Start the helper process directly (development mode)',
                "Start-Process -FilePath '" + nodePath + "' -ArgumentList '\"" + helperScriptPath + "\"' -WorkingDirectory '" + INSTALL_PATH + "' -WindowStyle Hidden",
                '',
                '# Wait for the helper to start and create the pipe',
                'Start-Sleep -Seconds 2',
                '',
                'Write-Host "Helper installed and started (development mode)"'
            ];
            installScript = scriptLines.join('\r\n');
        }

        // Write the PowerShell script to a temp file to avoid escaping issues
        const tempScriptPath = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'redd-block-install.ps1');
        fs.writeFileSync(tempScriptPath, installScript, 'utf8');

        // Execute the PowerShell script file with admin privileges
        // Using -File instead of -Command avoids escaping issues
        sudo.exec('powershell.exe -ExecutionPolicy Bypass -File "' + tempScriptPath + '"',
            { name: 'ReDD Block Website Blocker' },
            (error, stdout, stderr) => {
                // Clean up temp script
                try {
                    fs.unlinkSync(tempScriptPath);
                } catch (e) {
                    // Ignore cleanup errors
                }

                if (error) {
                    if (error.message && error.message.includes('User did not grant permission')) {
                        reject(new Error('Permission denied'));
                    } else {
                        reject(error);
                    }
                } else {
                    console.log('Helper installation output:', stdout);
                    if (stderr) console.warn('Helper installation stderr:', stderr);
                    resolve(true);
                }
            }
        );
    });
}

/**
 * Install the helper daemon
 * @returns {Promise<boolean>}
 */
async function installHelper() {
    if (process.platform === 'darwin') {
        return installMacOS();
    } else if (process.platform === 'linux') {
        return installLinux();
    } else if (process.platform === 'win32') {
        return installWindows();
    } else {
        throw new Error(`Unsupported platform: ${process.platform} `);
    }
}

/**
 * Uninstall the helper daemon
 */
async function uninstallHelper() {
    return new Promise((resolve, reject) => {
        let uninstallScript;

        if (process.platform === 'darwin') {
            uninstallScript = `
                launchctl unload "${PLIST_PATH}" 2 > /dev/null || true
        rm - f "${PLIST_PATH}"
        rm - rf "${INSTALL_PATH}"
        rm - rf /var/lib/redd - block
                echo "Helper uninstalled"
            `;
        } else if (process.platform === 'linux') {
            uninstallScript = `
                systemctl stop redd - block - helper 2 > /dev/null || true
                systemctl disable redd - block - helper 2 > /dev/null || true
        rm - f "${SYSTEMD_PATH}"
        rm - rf "${INSTALL_PATH}"
        rm - rf /var/lib/redd - block
                systemctl daemon - reload
                echo "Helper uninstalled"
            `;
        } else {
            return reject(new Error(`Unsupported platform: ${process.platform} `));
        }

        sudo.exec(uninstallScript, { name: 'ReDD Block' }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve(true);
            }
        });
    });
}

module.exports = {
    isHelperInstalled,
    installHelper,
    uninstallHelper,
    getSourceHelperPath
};
