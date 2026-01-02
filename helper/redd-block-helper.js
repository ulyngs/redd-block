#!/usr/bin/env node
/**
 * ReDD Block Helper Daemon
 * 
 * This privileged helper runs as root and manages website blocking.
 * It communicates with the main Electron app via IPC (Unix socket on macOS/Linux,
 * named pipe on Windows).
 * 
 * The daemon:
 * - Listens for commands from the main app
 * - Manages the hosts file and firewall rules
 * - Automatically clears blocks when they expire
 * - Re-applies rules if the hosts file is tampered with
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { execSync, exec } = require('child_process');
const os = require('os');

// Configuration
const SOCKET_PATH = process.platform === 'win32'
    ? '\\\\.\\pipe\\redd-block-helper'
    : '/tmp/redd-block-helper.sock';

const DATA_PATH = process.platform === 'win32'
    ? path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'ReDD Block', 'helper-state.json')
    : '/var/lib/redd-block/helper-state.json';

const HOSTS_PATH = process.platform === 'win32'
    ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    : '/etc/hosts';

const BLOCK_MARKER_START = '# BEGIN REDD BLOCK';
const BLOCK_MARKER_END = '# END REDD BLOCK';

// State
let currentBlock = null; // { domains: [], endTime: number, blocklistId: string }
let checkupInterval = null;
let hostsBackup = null;

// Logging
function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

function logError(message, error) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ERROR: ${message}`, error);
}

// State persistence
function ensureDataDir() {
    const dir = path.dirname(DATA_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function loadState() {
    try {
        ensureDataDir();
        if (fs.existsSync(DATA_PATH)) {
            const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
            if (data.currentBlock && data.currentBlock.endTime > Date.now()) {
                currentBlock = data.currentBlock;
                log(`Restored active block: ${currentBlock.domains.length} domains until ${new Date(currentBlock.endTime).toISOString()}`);
            }
        }
    } catch (err) {
        logError('Failed to load state', err);
    }
}

function saveState() {
    try {
        ensureDataDir();
        fs.writeFileSync(DATA_PATH, JSON.stringify({ currentBlock }, null, 2));
    } catch (err) {
        logError('Failed to save state', err);
    }
}

// Hosts file management
function readHostsFile() {
    try {
        return fs.readFileSync(HOSTS_PATH, 'utf8');
    } catch (err) {
        logError('Failed to read hosts file', err);
        return '';
    }
}

function writeHostsFile(content) {
    try {
        fs.writeFileSync(HOSTS_PATH, content);
        return true;
    } catch (err) {
        logError('Failed to write hosts file', err);
        return false;
    }
}

function backupHostsFile() {
    hostsBackup = readHostsFile();
}

function containsBlock(content) {
    return content.includes(BLOCK_MARKER_START);
}

function removeBlockFromHosts(content) {
    const startIndex = content.indexOf(BLOCK_MARKER_START);
    const endIndex = content.indexOf(BLOCK_MARKER_END);

    if (startIndex === -1) return content;

    const before = content.substring(0, startIndex).trimEnd();
    const after = endIndex !== -1
        ? content.substring(endIndex + BLOCK_MARKER_END.length).trimStart()
        : '';

    return before + (after ? '\n' + after : '');
}

function addBlockToHosts(content, domains) {
    // First remove any existing block
    content = removeBlockFromHosts(content);

    // Build the block section
    const blockLines = [
        '',
        BLOCK_MARKER_START,
        '# Managed by ReDD Block - DO NOT EDIT',
    ];

    domains.forEach(domain => {
        // Clean the domain
        const cleanDomain = domain
            .replace(/^https?:\/\//, '')
            .replace(/\/.*$/, '')
            .toLowerCase();

        // Add IPv4 and IPv6 entries
        blockLines.push(`0.0.0.0 ${cleanDomain}`);
        blockLines.push(`0.0.0.0 www.${cleanDomain}`);
        blockLines.push(`:: ${cleanDomain}`);
        blockLines.push(`:: www.${cleanDomain}`);
    });

    blockLines.push(BLOCK_MARKER_END);
    blockLines.push('');

    return content.trimEnd() + '\n' + blockLines.join('\n');
}

// Firewall management
function applyFirewallRules(domains) {
    if (process.platform === 'darwin') {
        return applyFirewallRulesMacOS(domains);
    } else if (process.platform === 'win32') {
        return applyFirewallRulesWindows(domains);
    }
    return true; // Linux uses hosts file only for now
}

function applyFirewallRulesMacOS(domains) {
    try {
        // Create pf anchor file
        const anchorPath = '/etc/pf.anchors/com.redd.block';
        const rules = [];

        // Resolve domains to IPs and add block rules
        // For simplicity, we'll rely primarily on hosts file blocking
        // and use pf as a backup for apps that bypass hosts

        fs.writeFileSync(anchorPath, rules.join('\n'));

        // Load the anchor
        execSync('pfctl -a com.redd.block -f /etc/pf.anchors/com.redd.block 2>/dev/null || true');

        return true;
    } catch (err) {
        logError('Failed to apply macOS firewall rules', err);
        return false;
    }
}

function applyFirewallRulesWindows(domains) {
    try {
        // Remove any existing ReDD Block firewall rules first
        try {
            execSync('netsh advfirewall firewall delete rule name="ReDD Block"', { stdio: 'ignore' });
        } catch (e) {
            // Rule might not exist, that's fine
        }

        // Add outbound block rules for each domain
        // Windows Firewall doesn't block by domain name, so we resolve to IPs
        // For now, we'll rely primarily on hosts file and add this as a placeholder
        // for future IP-based blocking

        log('Windows firewall rules: relying on hosts file blocking');
        return true;
    } catch (err) {
        logError('Failed to apply Windows firewall rules', err);
        return false;
    }
}

function clearFirewallRules() {
    if (process.platform === 'darwin') {
        return clearFirewallRulesMacOS();
    } else if (process.platform === 'win32') {
        return clearFirewallRulesWindows();
    }
    return true;
}

function clearFirewallRulesMacOS() {
    try {
        execSync('pfctl -a com.redd.block -F all 2>/dev/null || true');

        // Remove anchor file
        const anchorPath = '/etc/pf.anchors/com.redd.block';
        if (fs.existsSync(anchorPath)) {
            fs.unlinkSync(anchorPath);
        }

        return true;
    } catch (err) {
        logError('Failed to clear macOS firewall rules', err);
        return false;
    }
}

function clearFirewallRulesWindows() {
    try {
        execSync('netsh advfirewall firewall delete rule name="ReDD Block"', { stdio: 'ignore' });
        return true;
    } catch (err) {
        // Rule might not exist, which is fine
        return true;
    }
}

function flushDNSCache() {
    try {
        if (process.platform === 'darwin') {
            execSync('dscacheutil -flushcache 2>/dev/null || true');
            execSync('killall -HUP mDNSResponder 2>/dev/null || true');
        } else if (process.platform === 'win32') {
            execSync('ipconfig /flushdns');
        } else {
            // Linux - varies by distro
            execSync('systemd-resolve --flush-caches 2>/dev/null || true');
        }
    } catch (err) {
        // DNS flush errors are non-fatal
        log('Note: DNS cache flush may have failed (non-fatal)');
    }
}

// Block management
function startBlock(domains, endTime, blocklistId) {
    log(`Starting block: ${domains.length} domains until ${new Date(endTime).toISOString()}`);

    // Backup current hosts file
    backupHostsFile();

    // Apply hosts file blocking
    const hostsContent = readHostsFile();
    const newContent = addBlockToHosts(hostsContent, domains);

    if (!writeHostsFile(newContent)) {
        return { success: false, error: 'Failed to write hosts file' };
    }

    // Apply firewall rules
    applyFirewallRules(domains);

    // Flush DNS cache
    flushDNSCache();

    // Update state
    currentBlock = { domains, endTime, blocklistId };
    saveState();

    // Start the checkup timer if not already running
    if (!checkupInterval) {
        startCheckupTimer();
    }

    log('Block started successfully');
    return { success: true };
}

function clearBlock() {
    if (!currentBlock) {
        return { success: true, message: 'No active block' };
    }

    log('Clearing block...');

    // Remove hosts file blocking
    const hostsContent = readHostsFile();
    const cleanContent = removeBlockFromHosts(hostsContent);

    if (!writeHostsFile(cleanContent)) {
        return { success: false, error: 'Failed to clear hosts file' };
    }

    // Clear firewall rules
    clearFirewallRules();

    // Flush DNS cache
    flushDNSCache();

    // Update state
    currentBlock = null;
    saveState();

    log('Block cleared successfully');
    return { success: true };
}

function getStatus() {
    if (!currentBlock) {
        return { active: false };
    }

    const remaining = Math.max(0, currentBlock.endTime - Date.now());
    return {
        active: true,
        domains: currentBlock.domains,
        endTime: currentBlock.endTime,
        blocklistId: currentBlock.blocklistId,
        remainingMs: remaining
    };
}

// Checkup timer - runs every second
function startCheckupTimer() {
    if (checkupInterval) return;

    log('Starting checkup timer');

    checkupInterval = setInterval(() => {
        // Check if block has expired
        if (currentBlock && Date.now() >= currentBlock.endTime) {
            log('Block has expired, clearing automatically');
            clearBlock();
            return;
        }

        // If there's an active block, check integrity
        if (currentBlock) {
            checkBlockIntegrity();
        } else {
            // No active block, stop the timer
            stopCheckupTimer();
        }
    }, 1000);
}

function stopCheckupTimer() {
    if (checkupInterval) {
        log('Stopping checkup timer');
        clearInterval(checkupInterval);
        checkupInterval = null;
    }
}

function checkBlockIntegrity() {
    if (!currentBlock) return;

    const hostsContent = readHostsFile();

    if (!containsBlock(hostsContent)) {
        log('Block was removed from hosts file, re-applying...');
        const newContent = addBlockToHosts(hostsContent, currentBlock.domains);
        writeHostsFile(newContent);
        flushDNSCache();
    }
}

// IPC Server
function handleCommand(command) {
    log(`Received command: ${command.action}`);

    switch (command.action) {
        case 'start-block':
            return startBlock(command.domains, command.endTime, command.blocklistId);

        case 'clear-block':
            return clearBlock();

        case 'get-status':
            return getStatus();

        case 'ping':
            return { success: true, message: 'pong' };

        default:
            return { success: false, error: `Unknown command: ${command.action}` };
    }
}

function startServer() {
    // Clean up old socket if it exists
    if (process.platform !== 'win32' && fs.existsSync(SOCKET_PATH)) {
        fs.unlinkSync(SOCKET_PATH);
    }

    const server = net.createServer((socket) => {
        log('Client connected');

        let buffer = '';

        socket.on('data', (data) => {
            buffer += data.toString();

            // Handle complete messages (newline-delimited JSON)
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;

                try {
                    const command = JSON.parse(line);
                    const response = handleCommand(command);
                    socket.write(JSON.stringify(response) + '\n');
                } catch (err) {
                    logError('Failed to parse command', err);
                    socket.write(JSON.stringify({ success: false, error: 'Invalid JSON' }) + '\n');
                }
            }
        });

        socket.on('error', (err) => {
            logError('Socket error', err);
        });

        socket.on('close', () => {
            log('Client disconnected');
        });
    });

    server.on('error', (err) => {
        logError('Server error', err);
        process.exit(1);
    });

    server.listen(SOCKET_PATH, () => {
        log(`Helper daemon listening on ${SOCKET_PATH}`);

        // Set socket permissions (readable by all, but we'll add security later)
        if (process.platform !== 'win32') {
            fs.chmodSync(SOCKET_PATH, 0o666);
        }
    });

    // Handle graceful shutdown
    process.on('SIGTERM', () => {
        log('Received SIGTERM, shutting down...');
        server.close();
        stopCheckupTimer();
        process.exit(0);
    });

    process.on('SIGINT', () => {
        log('Received SIGINT, shutting down...');
        server.close();
        stopCheckupTimer();
        process.exit(0);
    });
}

// Main entry point
function main() {
    log('ReDD Block Helper Daemon starting...');
    log(`Platform: ${process.platform}`);
    log(`Running as: ${process.getuid ? `UID ${process.getuid()}` : 'N/A'}`);

    // Load any persisted state
    loadState();

    // If there's an active block, start the checkup timer
    if (currentBlock) {
        startCheckupTimer();
    }

    // Start the IPC server
    startServer();
}

main();
