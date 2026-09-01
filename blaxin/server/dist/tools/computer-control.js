import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
export class ComputerControlTool {
    name = 'computer-control';
    description = 'Control the computer: mouse clicks, keyboard input, window management, application launching, and scrolling.';
    definition = {
        type: 'function',
        function: {
            name: 'computer-control',
            description: 'Control the desktop GUI: click, type, scroll, manage windows, launch applications.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: [
                            'mouse_click', 'mouse_move', 'mouse_double_click', 'mouse_right_click',
                            'mouse_drag', 'type_text', 'key_press', 'key_combo',
                            'scroll', 'scroll_up', 'scroll_down',
                            'launch_app', 'focus_window', 'close_window', 'minimize_window', 'maximize_window',
                            'list_windows', 'get_active_window',
                            'get_mouse_position', 'get_screen_size',
                        ],
                        description: 'The action to perform',
                    },
                    x: {
                        type: 'number',
                        description: 'X coordinate for mouse actions',
                    },
                    y: {
                        type: 'number',
                        description: 'Y coordinate for mouse actions',
                    },
                    text: {
                        type: 'string',
                        description: 'Text to type (for type_text action)',
                    },
                    key: {
                        type: 'string',
                        description: 'Key name (for key_press/key_combo, e.g., "Return", "ctrl+c")',
                    },
                    app: {
                        type: 'string',
                        description: 'Application name or command (for launch_app)',
                    },
                    windowTitle: {
                        type: 'string',
                        description: 'Window title for window management actions',
                    },
                    amount: {
                        type: 'number',
                        description: 'Scroll amount (for scroll actions)',
                    },
                    endX: {
                        type: 'number',
                        description: 'End X for drag operations',
                    },
                    endY: {
                        type: 'number',
                        description: 'End Y for drag operations',
                    },
                },
                required: ['action'],
            },
        },
    };
    async runXdotool(args) {
        try {
            const { stdout } = await execAsync(`DISPLAY=:0 xdotool ${args.join(' ')}`, {
                timeout: 5000,
            });
            return stdout.trim();
        }
        catch (error) {
            throw new Error(`xdotool failed: ${error.message}`);
        }
    }
    async runXte(commands) {
        const script = commands.join('\n');
        try {
            await execAsync(`DISPLAY=:0 xte '${script}'`, {
                timeout: 5000,
            });
        }
        catch (error) {
            // xte might not be available, try xdotool instead
            throw new Error(`xte failed: ${error.message}`);
        }
    }
    async execute(args) {
        const action = args.action;
        try {
            switch (action) {
                case 'mouse_click': {
                    const x = args.x;
                    const y = args.y;
                    await this.runXdotool(['mousemove', String(x), String(y), 'click', '1']);
                    return { success: true, output: `Clicked at (${x}, ${y})` };
                }
                case 'mouse_double_click': {
                    const x = args.x;
                    const y = args.y;
                    await this.runXdotool(['mousemove', String(x), String(y), 'click', '--repeat', '2', '1']);
                    return { success: true, output: `Double-clicked at (${x}, ${y})` };
                }
                case 'mouse_right_click': {
                    const x = args.x;
                    const y = args.y;
                    await this.runXdotool(['mousemove', String(x), String(y), 'click', '3']);
                    return { success: true, output: `Right-clicked at (${x}, ${y})` };
                }
                case 'mouse_move': {
                    const x = args.x;
                    const y = args.y;
                    await this.runXdotool(['mousemove', String(x), String(y)]);
                    return { success: true, output: `Moved mouse to (${x}, ${y})` };
                }
                case 'mouse_drag': {
                    const x = args.x;
                    const y = args.y;
                    const endX = args.endX;
                    const endY = args.endY;
                    await this.runXdotool([
                        'mousemove', String(x), String(y),
                        'mousedown', '1',
                        'mousemove', String(endX), String(endY),
                        'mouseup', '1',
                    ]);
                    return { success: true, output: `Dragged from (${x}, ${y}) to (${endX}, ${endY})` };
                }
                case 'type_text': {
                    const text = args.text;
                    // Escape special characters for xdotool
                    const escaped = text.replace(/'/g, "'\\''");
                    await this.runXdotool(['type', '--clearmodifiers', escaped]);
                    return { success: true, output: `Typed text (${text.length} chars)` };
                }
                case 'key_press': {
                    const key = args.key;
                    await this.runXdotool(['key', key]);
                    return { success: true, output: `Pressed key: ${key}` };
                }
                case 'key_combo': {
                    const key = args.key;
                    await this.runXdotool(['key', key]);
                    return { success: true, output: `Key combo: ${key}` };
                }
                case 'scroll': {
                    const amount = args.amount || 3;
                    for (let i = 0; i < Math.abs(amount); i++) {
                        await this.runXdotool(['click', '5']);
                    }
                    return { success: true, output: `Scrolled ${amount} clicks` };
                }
                case 'scroll_up': {
                    await this.runXdotool(['click', '4']);
                    return { success: true, output: 'Scrolled up' };
                }
                case 'scroll_down': {
                    await this.runXdotool(['click', '5']);
                    return { success: true, output: 'Scrolled down' };
                }
                case 'launch_app': {
                    const app = args.app;
                    try {
                        await execAsync(`DISPLAY=:0 nohup ${app} &>/dev/null &`, { timeout: 5000 });
                        return { success: true, output: `Launched: ${app}` };
                    }
                    catch {
                        // Try with xdg-open
                        try {
                            await execAsync(`DISPLAY=:0 nohup xdg-open "${app}" &>/dev/null &`, { timeout: 5000 });
                            return { success: true, output: `Launched via xdg-open: ${app}` };
                        }
                        catch (error) {
                            return { success: false, output: '', error: `Failed to launch ${app}: ${error.message}` };
                        }
                    }
                }
                case 'focus_window': {
                    const title = args.windowTitle;
                    await this.runXdotool(['search', '--name', title, 'windowactivate']);
                    return { success: true, output: `Focused window: ${title}` };
                }
                case 'close_window': {
                    const title = args.windowTitle;
                    if (title) {
                        const windowId = await this.runXdotool(['search', '--name', title]);
                        if (windowId) {
                            await this.runXdotool(['windowclose', windowId.split('\n')[0]]);
                            return { success: true, output: `Closed window: ${title}` };
                        }
                    }
                    // Fallback: close active window
                    await this.runXdotool(['key', 'alt+F4']);
                    return { success: true, output: 'Closed active window' };
                }
                case 'minimize_window': {
                    const title = args.windowTitle;
                    if (title) {
                        const windowId = await this.runXdotool(['search', '--name', title]);
                        if (windowId) {
                            await this.runXdotool(['windowminimize', windowId.split('\n')[0]]);
                            return { success: true, output: `Minimized window: ${title}` };
                        }
                    }
                    await this.runXdotool(['key', 'alt+F9']);
                    return { success: true, output: 'Minimized active window' };
                }
                case 'maximize_window': {
                    const title = args.windowTitle;
                    if (title) {
                        const windowId = await this.runXdotool(['search', '--name', title]);
                        if (windowId) {
                            await this.runXdotool(['key', '--window', windowId.split('\n')[0], 'super+Up']);
                            return { success: true, output: `Maximized window: ${title}` };
                        }
                    }
                    await this.runXdotool(['key', 'super+Up']);
                    return { success: true, output: 'Maximized active window' };
                }
                case 'list_windows': {
                    const output = await this.runXdotool(['search', '--name', '']);
                    const windows = output.split('\n').filter(Boolean);
                    const windowNames = [];
                    for (const id of windows.slice(0, 20)) {
                        try {
                            const name = await this.runXdotool(['getwindowname', id]);
                            windowNames.push(`${id}: ${name}`);
                        }
                        catch { }
                    }
                    return {
                        success: true,
                        output: windowNames.length > 0 ? windowNames.join('\n') : 'No windows found',
                        data: { windows: windowNames },
                    };
                }
                case 'get_active_window': {
                    const name = await this.runXdotool(['getactivewindow', 'getwindowname']);
                    return { success: true, output: `Active window: ${name}`, data: { windowName: name } };
                }
                case 'get_mouse_position': {
                    const pos = await this.runXdotool(['getmouselocation']);
                    return { success: true, output: pos, data: { position: pos } };
                }
                case 'get_screen_size': {
                    try {
                        const { stdout } = await execAsync('DISPLAY=:0 xdpyinfo | grep dimensions', { timeout: 3000 });
                        return { success: true, output: stdout.trim(), data: { screenInfo: stdout.trim() } };
                    }
                    catch {
                        return { success: true, output: 'Unable to determine screen size', data: {} };
                    }
                }
                default:
                    return { success: false, output: '', error: `Unknown action: ${action}` };
            }
        }
        catch (error) {
            return { success: false, output: '', error: `Computer control failed: ${error.message}` };
        }
    }
    requiresConfirmation(args) {
        const action = args.action;
        return ['close_window', 'launch_app'].includes(action);
    }
}
//# sourceMappingURL=computer-control.js.map