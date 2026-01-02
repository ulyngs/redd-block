/**
 * IPC Client for ReDD Block Helper Daemon
 * 
 * This module provides a simple interface for the main Electron app
 * to communicate with the privileged helper daemon.
 */

const net = require('net');
const path = require('path');

const SOCKET_PATH = process.platform === 'win32'
    ? '\\\\.\\pipe\\redd-block-helper'
    : '/tmp/redd-block-helper.sock';

const CONNECTION_TIMEOUT = 5000;
const RESPONSE_TIMEOUT = 10000;

class HelperClient {
    constructor() {
        this.connected = false;
        this.socket = null;
    }

    /**
     * Send a command to the helper daemon
     * @param {Object} command - The command to send
     * @returns {Promise<Object>} - The response from the daemon
     */
    async send(command) {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            let responseBuffer = '';
            let resolved = false;

            const cleanup = () => {
                if (!socket.destroyed) {
                    socket.destroy();
                }
            };

            const connectionTimeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    reject(new Error('Connection timeout - helper daemon may not be running'));
                }
            }, CONNECTION_TIMEOUT);

            const responseTimeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    reject(new Error('Response timeout'));
                }
            }, RESPONSE_TIMEOUT);

            socket.on('connect', () => {
                clearTimeout(connectionTimeout);
                // Send the command as JSON with newline delimiter
                socket.write(JSON.stringify(command) + '\n');
            });

            socket.on('data', (data) => {
                responseBuffer += data.toString();

                // Check for complete response (newline-delimited)
                const newlineIndex = responseBuffer.indexOf('\n');
                if (newlineIndex !== -1) {
                    const responseStr = responseBuffer.substring(0, newlineIndex);

                    if (!resolved) {
                        resolved = true;
                        clearTimeout(connectionTimeout);
                        clearTimeout(responseTimeout);
                        cleanup();

                        try {
                            const response = JSON.parse(responseStr);
                            resolve(response);
                        } catch (err) {
                            reject(new Error('Invalid response from helper: ' + responseStr));
                        }
                    }
                }
            });

            socket.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(connectionTimeout);
                    clearTimeout(responseTimeout);
                    cleanup();

                    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
                        reject(new Error('Helper daemon not running. Please install the helper first.'));
                    } else {
                        reject(err);
                    }
                }
            });

            socket.on('close', () => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(connectionTimeout);
                    clearTimeout(responseTimeout);
                    reject(new Error('Connection closed unexpectedly'));
                }
            });

            socket.connect(SOCKET_PATH);
        });
    }

    /**
     * Check if the helper daemon is running
     */
    async isRunning() {
        try {
            const response = await this.send({ action: 'ping' });
            return response.success === true;
        } catch (err) {
            return false;
        }
    }

    /**
     * Start a block
     * @param {string[]} domains - Domains to block
     * @param {number} endTime - Unix timestamp when block should end
     * @param {string} blocklistId - ID of the blocklist
     */
    async startBlock(domains, endTime, blocklistId) {
        return this.send({
            action: 'start-block',
            domains,
            endTime,
            blocklistId
        });
    }

    /**
     * Clear the current block
     */
    async clearBlock() {
        return this.send({ action: 'clear-block' });
    }

    /**
     * Get the current block status
     */
    async getStatus() {
        return this.send({ action: 'get-status' });
    }
}

// Export a singleton instance
module.exports = new HelperClient();
