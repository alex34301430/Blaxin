import { Tool, ToolResult } from '../types.js';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

type DisplayServer = 'x11' | 'wayland' | 'unknown';

// Keys are never passed through a shell; this charset guard simply
// prevents nonsense input from reaching xdotool/ydotool.
const KEY_SAFE_PATTERN = /^[A-Za-z0-9_+\-.]{1,40}$/;

export class ComputerControlTool implements Tool {
  name = 'computer-control';
  description = 'Control the computer: mouse clicks, keyboard input, window management, application launching, and scrolling. Supports both X11 and Wayland.';

  private displayServer: DisplayServer = 'unknown';

  definition = {
    type: 'function' as const,
    function: {
      name: 'computer-control',
      description: 'Control the desktop GUI: click, type, scroll, manage windows, launch applications. Works on both X11 and Wayland.',
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
          x: { type: 'number', description: 'X coordinate for mouse actions' },
          y: { type: 'number', description: 'Y coordinate for mouse actions' },
          text: { type: 'string', description: 'Text to type (for type_text action)' },
          key: { type: 'string', description: 'Key name (for key_press/key_combo, e.g., "Return", "ctrl+c")' },
          app: { type: 'string', description: 'Application name or command (for launch_app)' },
          windowTitle: { type: 'string', description: 'Window title for window management actions' },
          amount: { type: 'number', description: 'Scroll amount (for scroll actions)' },
          endX: { type: 'number', description: 'End X for drag operations' },
          endY: { type: 'number', description: 'End Y for drag operations' },
        },
        required: ['action'],
      },
    },
  };

  private async detectDisplayServer(): Promise<DisplayServer> {
    if (this.displayServer !== 'unknown') return this.displayServer;

    if (process.env.WAYLAND_DISPLAY) {
      this.displayServer = 'wayland';
    } else if (process.env.DISPLAY) {
      this.displayServer = 'x11';
    } else {
      // Try to detect
      try {
        await execAsync('which xdotool', { timeout: 2000 });
        this.displayServer = 'x11';
      } catch {
        try {
          await execAsync('which ydotool', { timeout: 2000 });
          this.displayServer = 'wayland';
        } catch {
          this.displayServer = 'x11'; // Default fallback
        }
      }
    }

    return this.displayServer;
  }

  /** Run a command with explicit argv — no shell interpolation. */
  private async runTool(args: string[], timeout = 10000): Promise<string> {
    const env = {
      ...process.env,
      DISPLAY: process.env.DISPLAY || ':0',
    };
    try {
      const { stdout } = await execFileAsync(args[0], args.slice(1), { timeout, env });
      return stdout.trim();
    } catch (error: any) {
      throw new Error(`${args[0]} failed: ${error.message}`);
    }
  }

  /** Run a fixed, literal shell pipeline (no user input involved). */
  private async runLiteral(cmd: string, timeout = 5000): Promise<string> {
    const { stdout } = await execAsync(cmd, { timeout });
    return stdout.trim();
  }

  private num(value: unknown, label: string): number {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${label} must be a valid number`);
    return Math.round(n);
  }

  // ── X11 (xdotool) methods ─────────────────────────────────

  private xdotoolMove(x: number, y: number): Promise<string> {
    return this.runTool(['xdotool', 'mousemove', String(x), String(y)]);
  }

  private xdotoolClick(button = 1): Promise<string> {
    return this.runTool(['xdotool', 'click', String(button)]);
  }

  private xdotoolDoubleClick(x: number, y: number): Promise<string> {
    return this.runTool(['xdotool', 'mousemove', String(x), String(y), 'click', '--repeat', '2', '1']);
  }

  private xdotoolType(text: string): Promise<string> {
    return this.runTool(['xdotool', 'type', '--clearmodifiers', text]);
  }

  private xdotoolKey(key: string): Promise<string> {
    return this.runTool(['xdotool', 'key', key]);
  }

  private xdotoolSearch(query: string): Promise<string[]> {
    return this.runTool(['xdotool', 'search', '--name', query])
      .then((output) => output.split('\n').filter(Boolean));
  }

  private xdotoolGetActiveWindow(): Promise<string> {
    return this.runTool(['xdotool', 'getactivewindow', 'getwindowname']);
  }

  private async xdotoolWindowAction(windowId: string, action: string, key: string): Promise<string> {
    if (/^0x[0-9a-fA-F]+$/.test(windowId)) {
      return this.runTool(['xdotool', action, windowId]);
    }
    return this.runTool(['xdotool', 'key', key]);
  }

  // ── Wayland (ydotool) methods ──────────────────────────────

  private ydotoolMove(x: number, y: number): Promise<string> {
    return this.runTool(['ydotool', 'mousemove', '--absolute', String(x), String(y)]);
  }

  private ydotoolClick(button = 1): Promise<string> {
    // ydotool button: 0x110=left, 0x111=right, 0x112=middle
    const buttonMap: Record<number, string> = { 1: '0x110', 2: '0x112', 3: '0x111' };
    return this.runTool(['ydotool', 'click', buttonMap[button] || '0x110']);
  }

  private ydotoolDoubleClick(x: number, y: number): Promise<string> {
    return this.ydotoolMove(x, y).then(() =>
      this.runTool(['ydotool', 'click', '--next-delay', '50', '0x110', '0x110'])
    );
  }

  private ydotoolType(text: string): Promise<string> {
    return this.runTool(['ydotool', 'type', '--', text]);
  }

  private ydotoolKey(key: string): Promise<string> {
    // Map common xdotool key names to ydotool names
    const keyMap: Record<string, string> = {
      'Return': 'KP_Enter', 'enter': 'KP_Enter',
      'Tab': 'Tab', 'tab': 'Tab',
      'space': 'Space', 'BackSpace': 'BackSpace',
      'Delete': 'Delete', 'Escape': 'Escape',
      'ctrl+c': 'LEFTCTRL+c', 'ctrl+v': 'LEFTCTRL+v',
      'ctrl+a': 'LEFTCTRL+a', 'ctrl+x': 'LEFTCTRL+x',
      'ctrl+z': 'LEFTCTRL+z', 'alt+F4': 'LEFTALT+F4',
      'alt+F9': 'LEFTALT+F9', 'super+Up': 'SUPER+Up',
    };
    const ykey = keyMap[key] || key;
    return this.runTool(['ydotool', 'key', ykey]);
  }

  private ydotoolScroll(direction: 'up' | 'down', clicks = 1): Promise<string> {
    const args = ['ydotool', 'scroll', '--'];
    for (let i = 0; i < clicks; i++) {
      args.push(direction === 'up' ? '-5' : '5');
    }
    return this.runTool(args);
  }

  // ── Unified interface ──────────────────────────────────────

  private async moveMouse(x: number, y: number): Promise<void> {
    const ds = await this.detectDisplayServer();
    if (ds === 'wayland') {
      await this.ydotoolMove(x, y);
    } else {
      await this.xdotoolMove(x, y);
    }
  }

  private async clickMouse(button = 1): Promise<void> {
    const ds = await this.detectDisplayServer();
    if (ds === 'wayland') {
      await this.ydotoolClick(button);
    } else {
      await this.xdotoolClick(button);
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;

    try {
      switch (action) {
        case 'mouse_click': {
          const x = this.num(args.x, 'x');
          const y = this.num(args.y, 'y');
          await this.moveMouse(x, y);
          await this.clickMouse(1);
          return { success: true, output: `Clicked at (${x}, ${y})` };
        }

        case 'mouse_double_click': {
          const x = this.num(args.x, 'x');
          const y = this.num(args.y, 'y');
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolDoubleClick(x, y);
          } else {
            await this.xdotoolDoubleClick(x, y);
          }
          return { success: true, output: `Double-clicked at (${x}, ${y})` };
        }

        case 'mouse_right_click': {
          const x = this.num(args.x, 'x');
          const y = this.num(args.y, 'y');
          await this.moveMouse(x, y);
          await this.clickMouse(3);
          return { success: true, output: `Right-clicked at (${x}, ${y})` };
        }

        case 'mouse_move': {
          const x = this.num(args.x, 'x');
          const y = this.num(args.y, 'y');
          await this.moveMouse(x, y);
          return { success: true, output: `Moved mouse to (${x}, ${y})` };
        }

        case 'mouse_drag': {
          const x = this.num(args.x, 'x');
          const y = this.num(args.y, 'y');
          const endX = this.num(args.endX, 'endX');
          const endY = this.num(args.endY, 'endY');
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolMove(x, y);
            await this.runTool(['ydotool', 'mousedown', '0x110']);
            await this.ydotoolMove(endX, endY);
            await this.runTool(['ydotool', 'mouseup', '0x110']);
          } else {
            await this.runTool(['xdotool', 'mousemove', String(x), String(y), 'mousedown', '1',
              'mousemove', String(endX), String(endY), 'mouseup', '1']);
          }
          return { success: true, output: `Dragged from (${x}, ${y}) to (${endX}, ${endY})` };
        }

        case 'type_text': {
          const text = String(args.text ?? '');
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolType(text);
          } else {
            await this.xdotoolType(text);
          }
          return { success: true, output: `Typed text (${text.length} chars)` };
        }

        case 'key_press':
        case 'key_combo': {
          const key = String(args.key ?? '');
          if (!KEY_SAFE_PATTERN.test(key)) {
            return { success: false, output: '', error: 'Invalid key name. Use names like "Return", "ctrl+c", "alt+F4".' };
          }
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolKey(key);
          } else {
            await this.xdotoolKey(key);
          }
          return { success: true, output: `Pressed key: ${key}` };
        }

        case 'scroll': {
          const amount = this.num(args.amount ?? 3, 'amount');
          if (amount === 0) return { success: true, output: 'Scrolled 0 clicks' };
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolScroll(amount > 0 ? 'down' : 'up', Math.abs(amount));
          } else {
            const btn = amount > 0 ? '5' : '4';
            for (let i = 0; i < Math.abs(amount); i++) {
              await this.xdotoolClick(Number(btn));
            }
          }
          return { success: true, output: `Scrolled ${amount} clicks` };
        }

        case 'scroll_up': {
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolScroll('up');
          } else {
            await this.xdotoolClick(4);
          }
          return { success: true, output: 'Scrolled up' };
        }

        case 'scroll_down': {
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolScroll('down');
          } else {
            await this.xdotoolClick(5);
          }
          return { success: true, output: 'Scrolled down' };
        }

        case 'launch_app': {
          const app = String(args.app ?? '').trim();
          if (!app) return { success: false, output: '', error: 'App name is required' };
          const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0' };
          try {
            await execFileAsync('nohup', [app], { timeout: 5000, env });
            return { success: true, output: `Launched: ${app}` };
          } catch {
            try {
              await execFileAsync('nohup', ['xdg-open', app], { timeout: 5000, env });
              return { success: true, output: `Launched via xdg-open: ${app}` };
            } catch (error: any) {
              return { success: false, output: '', error: `Failed to launch ${app}: ${error.message}` };
            }
          }
        }

        case 'focus_window': {
          const title = String(args.windowTitle ?? '');
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.runLiteral('xdg-activate focus 2>/dev/null || true', 3000);
            return { success: true, output: `Attempted to focus: ${title} (Wayland limited)` };
          }
          const windowIds = await this.xdotoolSearch(title);
          if (windowIds.length > 0) {
            await this.xdotoolWindowAction(windowIds[0], 'windowactivate', '');
            return { success: true, output: `Focused window: ${title}` };
          }
          return { success: false, output: '', error: `Window not found: ${title}` };
        }

        case 'close_window': {
          const ds = await this.detectDisplayServer();
          const title = String(args.windowTitle ?? '');
          if (ds === 'wayland') {
            await this.ydotoolKey('alt+F4');
            return { success: true, output: 'Sent close shortcut (Wayland)' };
          }
          if (title) {
            const windowIds = await this.xdotoolSearch(title);
            if (windowIds.length > 0) {
              await this.runTool(['xdotool', 'windowclose', windowIds[0]]);
              return { success: true, output: `Closed window: ${title}` };
            }
          }
          await this.xdotoolKey('alt+F4');
          return { success: true, output: 'Closed active window' };
        }

        case 'minimize_window': {
          const ds = await this.detectDisplayServer();
          const title = String(args.windowTitle ?? '');
          if (ds === 'wayland') {
            await this.ydotoolKey('alt+F9');
            return { success: true, output: 'Minimized active window (Wayland)' };
          }
          if (title) {
            const windowIds = await this.xdotoolSearch(title);
            if (windowIds.length > 0) {
              await this.runTool(['xdotool', 'windowminimize', windowIds[0]]);
              return { success: true, output: `Minimized window: ${title}` };
            }
          }
          await this.xdotoolKey('alt+F9');
          return { success: true, output: 'Minimized active window' };
        }

        case 'maximize_window': {
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolKey('super+Up');
            return { success: true, output: 'Maximized window (Wayland)' };
          }
          await this.xdotoolKey('super+Up');
          return { success: true, output: 'Maximized active window' };
        }

        case 'list_windows': {
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            try {
              const { stdout } = await execAsync('wmctrl -l 2>/dev/null || swaymsg -t get_tree 2>/dev/null || true', { timeout: 3000 });
              return { success: true, output: stdout.trim() || 'Window listing limited on Wayland', data: {} };
            } catch {
              return { success: true, output: 'Window listing not available on this Wayland session', data: {} };
            }
          }
          const windows = await this.xdotoolSearch('');
          const windowNames: string[] = [];
          for (const id of windows.slice(0, 20)) {
            try {
              const name = await this.runTool(['xdotool', 'getwindowname', id]);
              windowNames.push(`${id}: ${name}`);
            } catch { /* skip unreadable windows */ }
          }
          return {
            success: true,
            output: windowNames.length > 0 ? windowNames.join('\n') : 'No windows found',
            data: { windows: windowNames },
          };
        }

        case 'get_active_window': {
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            return { success: true, output: 'Active window detection limited on Wayland', data: {} };
          }
          const name = await this.xdotoolGetActiveWindow();
          return { success: true, output: `Active window: ${name}`, data: { windowName: name } };
        }

        case 'get_mouse_position': {
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            return { success: true, output: 'Mouse position detection limited on Wayland', data: {} };
          }
          const pos = await this.runTool(['xdotool', 'getmouselocation']);
          return { success: true, output: pos, data: { position: pos } };
        }

        case 'get_screen_size': {
          try {
            const { stdout } = await execAsync('xdpyinfo | grep dimensions 2>/dev/null || wlr-randr 2>/dev/null || echo "Unable to determine"', {
              timeout: 3000,
              env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
            });
            return { success: true, output: stdout.trim(), data: { screenInfo: stdout.trim() } };
          } catch {
            return { success: true, output: 'Unable to determine screen size', data: {} };
          }
        }

        default:
          return { success: false, output: '', error: `Unknown action: ${action}` };
      }
    } catch (error: any) {
      return { success: false, output: '', error: `Computer control failed: ${error.message}` };
    }
  }

  requiresConfirmation(args: Record<string, unknown>): boolean {
    const action = args.action as string;
    return ['close_window', 'launch_app'].includes(action);
  }
}
