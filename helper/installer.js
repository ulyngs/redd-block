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
 */
function installWindows() {
    return new Promise((resolve, reject) => {
        // For Windows, we'll use a simpler approach with a scheduled task
        // or the node-windows package in a future update
        reject(new Error('Windows helper installation not yet implemented'));
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
        throw new Error(`Unsupported platform: ${process.platform}`);
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
                launchctl unload "${PLIST_PATH}" 2>/dev/null || true
                rm -f "${PLIST_PATH}"
                rm -rf "${INSTALL_PATH}"
                rm -rf /var/lib/redd-block
                echo "Helper uninstalled"
            `;
        } else if (process.platform === 'linux') {
            uninstallScript = `
                systemctl stop redd-block-helper 2>/dev/null || true
                systemctl disable redd-block-helper 2>/dev/null || true
                rm -f "${SYSTEMD_PATH}"
                rm -rf "${INSTALL_PATH}"
                rm -rf /var/lib/redd-block
                systemctl daemon-reload
                echo "Helper uninstalled"
            `;
        } else {
            return reject(new Error(`Unsupported platform: ${process.platform}`));
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
