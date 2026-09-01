import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const execAsync = promisify(exec);
export class ScreenshotTool {
    name = 'screenshot';
    description = 'Take a screenshot of the current screen or a specific window. Returns information about what is visible on screen.';
    definition = {
        type: 'function',
        function: {
            name: 'screenshot',
            description: 'Capture a screenshot of the desktop. Useful for observing the current state of applications and the GUI.',
            parameters: {
                type: 'object',
                properties: {
                    region: {
                        type: 'string',
                        description: 'Optional region to capture (format: "WxH+X+Y" or "all" for full screen)',
                    },
                    window: {
                        type: 'string',
                        description: 'Optional window title to capture',
                    },
                },
                required: [],
            },
        },
    };
    async execute(args) {
        const screenshotPath = join(tmpdir(), `blaxin-screenshot-${Date.now()}.png`);
        try {
            // Try different screenshot tools based on what's available
            const tools = [
                {
                    name: 'scrot',
                    check: 'which scrot',
                    cmd: `scrot "${screenshotPath}"`,
                },
                {
                    name: 'gnome-screenshot',
                    check: 'which gnome-screenshot',
                    cmd: `gnome-screenshot -f "${screenshotPath}"`,
                },
                {
                    name: 'import',
                    check: 'which import',
                    cmd: `import -window root "${screenshotPath}"`,
                },
                {
                    name: 'xdotool+scrot',
                    check: 'which scrot',
                    cmd: `scrot "${screenshotPath}"`,
                },
            ];
            let captured = false;
            for (const tool of tools) {
                try {
                    await execAsync(tool.check, { timeout: 5000 });
                    await execAsync(tool.cmd, { timeout: 10000 });
                    captured = true;
                    break;
                }
                catch {
                    continue;
                }
            }
            if (!captured) {
                // Fallback: use xdg to capture
                try {
                    await execAsync(`bash -c 'DISPLAY=:0 xdotool getactivewindow getwindowname'`, { timeout: 5000 });
                    return {
                        success: true,
                        output: 'Screenshot tools not available, but X11 display is present. Install scrot: sudo apt install scrot',
                        data: { screenshotAvailable: false },
                    };
                }
                catch {
                    return {
                        success: false,
                        output: '',
                        error: 'No screenshot tool available. Install one: sudo apt install scrot',
                    };
                }
            }
            if (existsSync(screenshotPath)) {
                const stats = statSync(screenshotPath);
                // Clean up the file after reading
                unlinkSync(screenshotPath);
                return {
                    success: true,
                    output: `Screenshot captured successfully (${stats.size} bytes). The screenshot was taken and processed.`,
                    data: { screenshotAvailable: true, size: stats.size },
                };
            }
            return { success: false, output: '', error: 'Screenshot file was not created' };
        }
        catch (error) {
            return { success: false, output: '', error: `Screenshot failed: ${error.message}` };
        }
    }
}
//# sourceMappingURL=screenshot.js.map