require('dotenv').config();
const builder = require('electron-builder');
const fs = require('fs');
const path = require('path');
const Platform = builder.Platform;
const Arch = builder.Arch;

// Check command line arguments
const buildMac = process.argv.includes('--mac');
const buildWin = process.argv.includes('--win');
const buildLinux = process.argv.includes('--linux');

// Detect implicit "current platform" builds (when no flags are provided)
const noExplicitPlatformFlags = !buildMac && !buildWin && !buildLinux;
const isImplicitWin = noExplicitPlatformFlags && process.platform === 'win32';
const isImplicitLinux = noExplicitPlatformFlags && process.platform === 'linux';

// Read package.json
const pkgJsonPath = path.join(__dirname, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

// If no flags, default to current platform
const targets = [];
if (buildMac) targets.push(Platform.MAC);
if (buildWin) targets.push(Platform.WINDOWS);
if (buildLinux) targets.push(Platform.LINUX);

if (targets.length === 0) {
  console.log("No platform flags detected (--mac, --win, --linux). Building for current platform only.");
}

// Determine Mac targets
let macTargets = [
  {
    target: 'dmg',
    arch: ['universal']
  },
  {
    target: 'zip',
    arch: ['universal']
  }
];

builder.build({
  targets: (buildWin && targets.length === 1 && targets[0] === Platform.WINDOWS)
    ? Platform.WINDOWS.createTarget(['nsis', 'zip'], Arch.x64)
    : (targets.length > 0 ? builder.createTargets(targets) : undefined),
  config: {
    appId: 'com.redd.block',
    productName: 'ReDD Block',
    copyright: 'Copyright © 2025 Reduce Digital Distraction Ltd',
    directories: {
      output: 'dist',
      buildResources: 'assets'
    },
    mac: {
      identity: process.env.APPLE_IDENTITY,
      category: 'public.app-category.productivity',
      target: macTargets,
      icon: 'assets/icon.icns',
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.plist',
      extendInfo: {
        "ITSAppUsesNonExemptEncryption": false
      }
    },
    win: {
      target: [
        {
          target: 'nsis',
          arch: ['x64']
        },
        {
          target: 'zip',
          arch: ['x64']
        },
        {
          target: 'appx',
          arch: ['x64']
        }
      ],
      icon: 'assets/icon.ico'
    },
    appx: {
      applicationId: 'ReDDBlock',
      displayName: 'ReDD Block',
      identityName: 'ReDDBlock',
      publisher: 'CN=ReddFocus',
      publisherDisplayName: 'Reduce Digital Distraction Project'
    },
    linux: {
      target: [
        {
          target: 'AppImage',
          arch: ['x64', 'arm64']
        },
        {
          target: 'deb',
          arch: ['x64', 'arm64']
        }
      ],
      category: 'Utility',
      icon: 'assets/icon.png',
      artifactName: 'redd-block-${version}-${arch}.${ext}'
    },
    defaultArch: 'x64'
  }
}).then(() => {
  console.log('Build complete!');

  // Rename linux files to enforce consistent 'x64' naming
  if (buildLinux) {
    const distDir = path.join(__dirname, 'dist');
    try {
      const files = fs.readdirSync(distDir);
      files.forEach(file => {
        if (file.includes('amd64')) {
          const newName = file.replace('amd64', 'x64');
          fs.renameSync(path.join(distDir, file), path.join(distDir, newName));
          console.log(`Renamed ${file} to ${newName}`);
        } else if (file.includes('x86_64')) {
          const newName = file.replace('x86_64', 'x64');
          fs.renameSync(path.join(distDir, file), path.join(distDir, newName));
          console.log(`Renamed ${file} to ${newName}`);
        }
      });
    } catch (e) {
      console.error('Error renaming linux files:', e);
    }
  }
}).catch((error) => {
  console.error('Build failed:', error);
  process.exit(1);
});
