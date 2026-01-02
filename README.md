# ReDD Block

Block distracting websites and apps to stay focused on what matters.

## Features

- **Website Blocking**: Block distracting websites across all browsers using system-level hosts file modification and firewall rules
- **App Blocking**: Automatically minimize distracting macOS apps every 500ms while a block is running
- **Flexible Blocklists**: Create multiple blocklists for different scenarios (work, study, etc.) with custom emojis and colors
- **Visual Timeline**: See your blocks on an interactive 24-hour timeline with smooth scrolling
- **Slider-Based Scheduling**: Intuitive duration selection (15 min to 12 hours) with visual preview
- **Override Protection**: Configurable difficulty to cancel blocks (random words, gibberish, or custom text)
- **Multiple Concurrent Blocks**: Run multiple blocklists simultaneously
- **Background Operation**: Blocks continue running even when the app is closed via a privileged helper daemon
- **Drag & Drop Reordering**: Rearrange blocklists by dragging them
- **One-Time Password**: Only requires your password once on first setup - all subsequent blocks start instantly

## Installation

### Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev
```

### Building

```bash
# Build the helper daemon (required before packaging)
cd helper && npx pkg . --targets node18-macos-arm64 --output dist/redd-block-helper && cd ..

# Build for current platform
npm run build

# Build for specific platforms
npm run build:mac
npm run build:win
npm run build:linux
```

## How It Works

### Website Blocking
ReDD Block uses a dual approach for robust website blocking:
1. **Hosts File**: Modifies `/etc/hosts` to redirect blocked domains to `127.0.0.1`
2. **Firewall Rules (macOS)**: Uses `pf` (packet filter) to block IP addresses, preventing bypass via direct IP access

### App Blocking
On macOS, blocked applications are automatically hidden every 500ms while a block is active. The app uses System Events to detect running apps and hide blocked ones, providing a consistent reminder to stay focused.

### Privileged Helper Daemon
To avoid repeated password prompts, ReDD Block installs a privileged helper daemon on first use. This daemon runs in the background with root privileges and handles all hosts file and firewall modifications. After initial setup (which requires your password once), all blocks start instantly without any prompts.

The helper is:
- **Open source**: See the code in `/helper`
- **Secure**: Communicates via Unix domain socket with the app
- **Persistent**: Runs as a launchd daemon, survives app restarts and reboots
- **Tamper-resistant**: Blocks cannot be easily overridden while active

## Architecture

```
redd-block/
├── main.js              # Electron main process
├── src/
│   ├── index.html       # Main UI
│   ├── app.js           # Renderer process logic
│   └── styles.css       # Styling
├── helper/
│   ├── redd-block-helper.js  # Privileged daemon (runs as root)
│   ├── installer.js          # Helper installation logic
│   ├── ipc-client.js         # IPC communication with daemon
│   └── dist/                 # Compiled standalone binary
└── build/               # Build configuration
```

## Requirements

- **macOS**: 10.15+ (Catalina or later)
- **Linux**: systemd-based distributions (Ubuntu, Debian, Fedora, etc.)
- **Windows**: Not yet supported

## License

CC-BY-NC-ND-3.0

---

Made with ♥ by [reddfocus.org](https://reddfocus.org)
