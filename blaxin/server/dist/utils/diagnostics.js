import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, accessSync, constants } from 'fs';
import { providers } from '../providers/index.js';
import { toolRegistry } from '../tools/index.js';
import { credentialStore } from './credentials.js';
const execAsync = promisify(exec);
async function runCheck(name, fn) {
    try {
        return await fn();
    }
    catch (error) {
        return {
            name,
            status: 'error',
            message: error.message || 'Check failed',
            suggestion: 'Something went wrong during this diagnostic check.',
        };
    }
}
async function checkCommand(name, cmd) {
    try {
        const { stdout } = await execAsync(cmd, { timeout: 5000 });
        return {
            name,
            status: 'ok',
            message: `${name} is available`,
            details: stdout.trim().split('\n')[0],
        };
    }
    catch {
        return {
            name,
            status: 'error',
            message: `${name} is not available`,
            suggestion: `Install ${name} to enable this feature.`,
        };
    }
}
function getDisplayServer() {
    if (process.env.WAYLAND_DISPLAY)
        return 'Wayland';
    if (process.env.DISPLAY)
        return 'X11';
    return 'Unknown';
}
export async function runDiagnostics() {
    const groups = [];
    // ── 1. Backend Server ────────────────────────────────────────
    const backendChecks = [];
    backendChecks.push({
        name: 'Node.js',
        status: 'ok',
        message: `Node.js ${process.version} is running`,
        details: `PID: ${process.pid}, Platform: ${process.platform} ${process.arch}`,
    });
    backendChecks.push({
        name: 'Server uptime',
        status: 'ok',
        message: `Server running for ${Math.round(process.uptime())}s`,
        details: `Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB used`,
    });
    const displayServer = getDisplayServer();
    backendChecks.push({
        name: 'Display server',
        status: displayServer !== 'Unknown' ? 'ok' : 'warning',
        message: `Display server: ${displayServer || 'Not detected'}`,
        details: displayServer === 'Wayland'
            ? `WAYLAND_DISPLAY: ${process.env.WAYLAND_DISPLAY}`
            : displayServer === 'X11'
                ? `DISPLAY: ${process.env.DISPLAY}`
                : 'No DISPLAY or WAYLAND_DISPLAY set',
        suggestion: displayServer === 'Unknown'
            ? 'Desktop control requires a display server. Set DISPLAY for X11 or ensure WAYLAND_DISPLAY is set.'
            : undefined,
    });
    groups.push({ name: 'Backend Server', icon: 'server', checks: backendChecks });
    // ── 2. AI Providers ──────────────────────────────────────────
    const providerChecks = [];
    const allProviders = providers.getAllProviders();
    for (const provider of allProviders) {
        const hasKey = provider.hasApiKey();
        const keyStatus = credentialStore.get(provider.id);
        if (!provider.apiKeyRequired) {
            // Provider like Ollama doesn't need API key
            providerChecks.push({
                name: provider.name,
                status: 'ok',
                message: `${provider.name} (no key required)`,
                details: 'Local provider — no API key needed',
            });
            continue;
        }
        if (!hasKey) {
            providerChecks.push({
                name: provider.name,
                status: 'warning',
                message: `${provider.name} — No API key configured`,
                suggestion: `Open Settings → AI Providers → ${provider.name} → Configure to add your API key.`,
            });
            continue;
        }
        // Try a lightweight validation
        try {
            const result = await provider.validateKey(keyStatus);
            if (result.valid) {
                providerChecks.push({
                    name: provider.name,
                    status: 'ok',
                    message: `${provider.name} — Connected`,
                    details: `Key: ${credentialStore.maskKey(keyStatus)}`,
                });
            }
            else {
                providerChecks.push({
                    name: provider.name,
                    status: 'error',
                    message: `${provider.name} — ${result.error || 'Validation failed'}`,
                    suggestion: 'Check that your API key is correct and not expired. You can update it in Settings → AI Providers.',
                });
            }
        }
        catch (error) {
            providerChecks.push({
                name: provider.name,
                status: 'error',
                message: `${provider.name} — Connection error`,
                details: error.message,
                suggestion: 'Check your internet connection and verify the provider is accessible.',
            });
        }
    }
    // Check active provider/model
    const activeProvider = providers.getActiveProvider();
    const activeModel = providers.getActiveModel();
    if (activeProvider && activeModel) {
        providerChecks.push({
            name: 'Active configuration',
            status: 'ok',
            message: `Using ${activeProvider} / ${activeModel}`,
        });
    }
    else {
        providerChecks.push({
            name: 'Active configuration',
            status: 'warning',
            message: 'No model selected',
            suggestion: 'Open Settings → Models to select a model for the agent to use.',
        });
    }
    groups.push({ name: 'AI Providers', icon: 'cpu', checks: providerChecks });
    // ── 3. Tools ─────────────────────────────────────────────────
    const toolChecks = [];
    const allTools = toolRegistry.getAllTools();
    const toolStatus = toolRegistry.getEnabledStatus();
    for (const tool of allTools) {
        const enabled = toolStatus[tool.name] ?? false;
        toolChecks.push({
            name: tool.name,
            status: enabled ? 'ok' : 'warning',
            message: `${tool.name} — ${enabled ? 'Enabled' : 'Disabled'}`,
            details: tool.description,
        });
    }
    groups.push({ name: 'Agent Tools', icon: 'tool', checks: toolChecks });
    // ── 4. Desktop Control ───────────────────────────────────────
    const desktopChecks = [];
    // Check xdotool (X11)
    const xdotoolCheck = await runCheck('xdotool', async () => {
        const result = await checkCommand('xdotool', 'which xdotool');
        if (result.status === 'ok' && displayServer === 'X11') {
            result.message = 'xdotool available (X11 desktop control ready)';
        }
        else if (result.status === 'ok' && displayServer === 'Wayland') {
            result.status = 'warning';
            result.message = 'xdotool available but running on Wayland (may not work)';
            result.suggestion = 'xdotool is X11-only. For Wayland, install ydotool instead.';
        }
        return result;
    });
    desktopChecks.push(xdotoolCheck);
    // Check ydotool (Wayland)
    const ydotoolCheck = await checkCommand('ydotool', 'which ydotool');
    if (displayServer === 'Wayland') {
        if (ydotoolCheck.status === 'ok') {
            desktopChecks.push({
                name: 'ydotool',
                status: 'ok',
                message: 'ydotool available (Wayland desktop control ready)',
            });
        }
        else {
            desktopChecks.push({
                name: 'ydotool',
                status: 'error',
                message: 'ydotool not available (Wayland desktop control disabled)',
                suggestion: 'Install ydotool: sudo apt install ydotool',
            });
        }
    }
    // Check screenshot tools
    const screenshotChecks = ['scrot', 'gnome-screenshot', 'import', 'grim'];
    let foundScreenshot = false;
    for (const tool of screenshotChecks) {
        const check = await checkCommand(tool, `which ${tool}`);
        if (check.status === 'ok') {
            if (!foundScreenshot) {
                desktopChecks.push({
                    name: 'Screenshot',
                    status: 'ok',
                    message: `${tool} available for screenshots`,
                    details: `Using: ${tool}`,
                });
                foundScreenshot = true;
            }
        }
    }
    if (!foundScreenshot) {
        desktopChecks.push({
            name: 'Screenshot',
            status: 'error',
            message: 'No screenshot tool found',
            suggestion: 'Install scrot (X11): sudo apt install scrot  |  Install grim (Wayland): sudo apt install grim',
        });
    }
    // Check clipboard
    const clipCheck = await runCheck('Clipboard', async () => {
        const xclip = await checkCommand('xclip', 'which xclip');
        const xsel = await checkCommand('xsel', 'which xsel');
        const wlClipboard = await checkCommand('wl-clipboard', 'which wl-copy');
        if (xclip.status === 'ok' || xsel.status === 'ok') {
            return {
                name: 'Clipboard',
                status: 'ok',
                message: 'Clipboard tool available (X11)',
                details: `Using: ${xclip.status === 'ok' ? 'xclip' : 'xsel'}`,
            };
        }
        if (wlClipboard.status === 'ok') {
            return {
                name: 'Clipboard',
                status: 'ok',
                message: 'Clipboard tool available (Wayland)',
                details: 'Using: wl-clipboard',
            };
        }
        return {
            name: 'Clipboard',
            status: 'warning',
            message: 'No clipboard tool found',
            suggestion: 'Install xclip: sudo apt install xclip  |  Or wl-clipboard: sudo apt install wl-clipboard',
        };
    });
    desktopChecks.push(clipCheck);
    groups.push({ name: 'Desktop Control', icon: 'monitor', checks: desktopChecks });
    // ── 5. Browser ───────────────────────────────────────────────
    const browserChecks = [];
    const browsers = ['firefox', 'chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable'];
    let foundBrowser = false;
    for (const browser of browsers) {
        const check = await runCheck(browser, async () => {
            const result = await checkCommand(browser, `which ${browser}`);
            if (result.status === 'ok') {
                result.message = `${browser} found`;
                result.details = `Path: ${result.details}`;
            }
            return result;
        });
        if (check.status === 'ok') {
            browserChecks.push(check);
            foundBrowser = true;
        }
    }
    if (!foundBrowser) {
        browserChecks.push({
            name: 'Web browser',
            status: 'error',
            message: 'No web browser found',
            suggestion: 'Install Firefox: sudo apt install firefox  |  Or Chromium: sudo apt install chromium-browser',
        });
    }
    groups.push({ name: 'Browser', icon: 'globe', checks: browserChecks });
    // ── 6. File System ───────────────────────────────────────────
    const fsChecks = [];
    const homeDir = process.env.HOME || '/tmp';
    fsChecks.push({
        name: 'Home directory',
        status: existsSync(homeDir) ? 'ok' : 'error',
        message: `Home: ${homeDir}`,
        details: existsSync(homeDir) ? 'Accessible' : 'Not found',
    });
    const tmpDir = '/tmp';
    fsChecks.push({
        name: 'Temp directory',
        status: existsSync(tmpDir) ? 'ok' : 'error',
        message: `Temp: ${tmpDir}`,
    });
    // Check write access
    try {
        accessSync(homeDir, constants.W_OK);
        fsChecks.push({
            name: 'Write access',
            status: 'ok',
            message: 'Write access to home directory',
        });
    }
    catch {
        fsChecks.push({
            name: 'Write access',
            status: 'warning',
            message: 'No write access to home directory',
            suggestion: 'BLAXIN needs write access to store configuration and credentials.',
        });
    }
    groups.push({ name: 'File System', icon: 'file', checks: fsChecks });
    // ── Overall status ───────────────────────────────────────────
    let hasError = false;
    let hasWarning = false;
    for (const group of groups) {
        for (const check of group.checks) {
            if (check.status === 'error') {
                hasError = true;
            }
            if (check.status === 'warning') {
                hasWarning = true;
            }
        }
        if (hasError)
            break;
    }
    const overall = hasError ? 'error' : hasWarning ? 'warning' : 'ok';
    return {
        overall,
        groups,
        timestamp: Date.now(),
    };
}
//# sourceMappingURL=diagnostics.js.map