import { Tool, ToolResult } from '../types.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

type DisplayServer = 'x11' | 'wayland' | 'unknown';

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

  private async runCommand(cmd: string, timeout = 5000): Promise<string> {
    try {
      const { stdout } = await execAsync(cmd, { timeout });
      return stdout.trim();
    } catch (error: any) {
      throw new Error(`Command failed: ${error.message}`);
    }
  }

  // ── X11 (xdotool) methods ─────────────────────────────────

  private async xdotoolMove(x: number, y: number): Promise<void> {
    await this.runCommand(`DISPLAY=:0 xdotool mousemove ${x} ${y}`);
  }

  private async xdotoolClick(button: number = 1): Promise<void> {
    await this.runCommand(`DISPLAY=:0 xdotool click ${button}`);
  }

  private async xdotoolDoubleClick(x: number, y: number): Promise<void> {
    await this.runCommand(`DISPLAY=:0 xdotool mousemove ${x} ${y} click --repeat 2 1`);
  }

  private async xdotoolType(text: string): Promise<void> {
    const escaped = text.replace(/'/g, "'\\''");
    await this.runCommand(`DISPLAY=:0 xdotool type --clearmodifiers '${escaped}'`);
  }

  private async xdotoolKey(key: string): Promise<void> {
    await this.runCommand(`DISPLAY=:0 xdotool key ${key}`);
  }

  private async xdotoolSearch(query: string): Promise<string[]> {
    const output = await this.runCommand(`DISPLAY=:0 xdotool search --name "${query}"`);
    return output.split('\n').filter(Boolean);
  }

  private async xdotoolGetActiveWindow(): Promise<string> {
    return await this.runCommand('DISPLAY=:0 xdotool getactivewindow getwindowname');
  }

  // ── Wayland (ydotool) methods ──────────────────────────────

  private async ydotoolMove(x: number, y: number): Promise<void> {
    await this.runCommand(`ydotool mousemove --absolute ${x} ${y}`);
  }

  private async ydotoolClick(button: number = 1): Promise<void> {
    // ydotool button: 0x110=left, 0x111=right, 0x112=middle
    const buttonMap: Record<number, number> = { 1: 0x110, 2: 0x112, 3: 0x111 };
    await this.runCommand(`ydotool click ${buttonMap[button] || 0x110}`);
  }

  private async ydotoolDoubleClick(x: number, y: number): Promise<void> {
    await this.ydotoolMove(x, y);
    await this.runCommand('ydotool click --next-delay 50 0x110 0x110');
  }

  private async ydotoolType(text: string): Promise<void> {
    await this.runCommand(`ydotool type -- '${text}'`);
  }

  private async ydotoolKey(key: string): Promise<void> {
    // Map xdotool key names to ydotool
    const keyMap: Record<string, string> = {
      'Return': 'KP_Enter', 'enter': 'KP_Enter',
      'Tab': 'Tab', 'tab': 'Tab',
      'space': 'Space', 'BackSpace': 'BackSpace',
      'Delete': 'Delete', 'Escape': 'Escape',
      'ctrl+c': 'LEFTCTRL+c', 'ctrl+v': 'LEFTCTRL+v',
      'ctrl+a': 'LEFTCTRL+a', 'ctrl+x': 'LEFTCTRL+x',
      'ctrl+z': 'LEFTCTRL+z', 'alt+F4': 'LEFTALT+F4',
    };
    const ykey = keyMap[key] || key;
    await this.runCommand(`ydotool key ${ykey}`);
  }

  private async ydotoolScroll(direction: 'up' | 'down'): Promise<void> {
    await this.runCommand(`ydotool scroll ${direction === 'up' ? '-- -5' : '5'}`);
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

  private async clickMouse(button: number = 1): Promise<void> {
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
          const x = args.x as number;
          const y = args.y as number;
          await this.moveMouse(x, y);
          await this.clickMouse(1);
          return { success: true, output: `Clicked at (${x}, ${y})` };
        }

        case 'mouse_double_click': {
          const x = args.x as number;
          const y = args.y as number;
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolDoubleClick(x, y);
          } else {
            await this.xdotoolDoubleClick(x, y);
          }
          return { success: true, output: `Double-clicked at (${x}, ${y})` };
        }

        case 'mouse_right_click': {
          const x = args.x as number;
          const y = args.y as number;
          await this.moveMouse(x, y);
          await this.clickMouse(3);
          return { success: true, output: `Right-clicked at (${x}, ${y})` };
        }

        case 'mouse_move': {
          const x = args.x as number;
          const y = args.y as number;
          await this.moveMouse(x, y);
          return { success: true, output: `Moved mouse to (${x}, ${y})` };
        }

        case 'mouse_drag': {
          const x = args.x as number;
          const y = args.y as number;
          const endX = args.endX as number;
          const endY = args.endY as number;
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolMove(x, y);
            await this.runCommand('ydotool mousedown 0x110');
            await this.ydotoolMove(endX, endY);
            await this.runCommand('ydotool mouseup 0x110');
          } else {
            await this.runCommand(
              `DISPLAY=:0 xdotool mousemove ${x} ${y} mousedown 1 mousemove ${endX} ${endY} mouseup 1`
            );
          }
          return { success: true, output: `Dragged from (${x}, ${y}) to (${endX}, ${endY})` };
        }

        case 'type_text': {
          const text = args.text as string;
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
          const key = args.key as string;
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolKey(key);
          } else {
            await this.xdotoolKey(key);
          }
          return { success: true, output: `Pressed key: ${key}` };
        }

        case 'scroll': {
          const amount = (args.amount as number) || 3;
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            for (let i = 0; i < Math.abs(amount); i++) {
              await this.ydotoolScroll(amount > 0 ? 'down' : 'up');
            }
          } else {
            const btn = amount > 0 ? '5' : '4';
            for (let i = 0; i < Math.abs(amount); i++) {
              await this.runCommand(`DISPLAY=:0 xdotool click ${btn}`);
            }
          }
          return { success: true, output: `Scrolled ${amount} clicks` };
        }

        case 'scroll_up': {
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolScroll('up');
          } else {
            await this.runCommand('DISPLAY=:0 xdotool click 4');
          }
          return { success: true, output: 'Scrolled up' };
        }

        case 'scroll_down': {
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolScroll('down');
          } else {
            await this.runCommand('DISPLAY=:0 xdotool click 5');
          }
          return { success: true, output: 'Scrolled down' };
        }

        case 'launch_app': {
          const app = args.app as string;
          const ds = await this.detectDisplayServer();
          const display = ds === 'wayland' ? '' : 'DISPLAY=:0 ';
          try {
            await execAsync(`${display}nohup ${app} &>/dev/null &`, { timeout: 5000 });
            return { success: true, output: `Launched: ${app}` };
          } catch {
            try {
              await execAsync(`${display}nohup xdg-open "${app}" &>/dev/null &`, { timeout: 5000 });
              return { success: true, output: `Launched via xdg-open: ${app}` };
            } catch (error: any) {
              return { success: false, output: '', error: `Failed to launch ${app}: ${error.message}` };
            }
          }
        }

        case 'focus_window': {
          const title = args.windowTitle as string;
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            // ydotool doesn't have window focus; use xdg-activation
            await execAsync(`xdg-activate focus 2>/dev/null || true`, { timeout: 3000 });
            return { success: true, output: `Attempted to focus: ${title} (Wayland limited)` };
          }
          const windowIds = await this.xdotoolSearch(title);
          if (windowIds.length > 0) {
            await this.runCommand(`DISPLAY=:0 xdotool windowactivate ${windowIds[0]}`);
            return { success: true, output: `Focused window: ${title}` };
          }
          return { success: false, output: '', error: `Window not found: ${title}` };
        }

        case 'close_window': {
          const ds = await this.detectDisplayServer();
          const title = args.windowTitle as string;
          if (ds === 'wayland') {
            // Close via keyboard shortcut
            await this.ydotoolKey('LEFTALT+F4');
            return { success: true, output: 'Sent close shortcut (Wayland)' };
          }
          if (title) {
            const windowIds = await this.xdotoolSearch(title);
            if (windowIds.length > 0) {
              await this.runCommand(`DISPLAY=:0 xdotool windowclose ${windowIds[0]}`);
              return { success: true, output: `Closed window: ${title}` };
            }
          }
          await this.runCommand('DISPLAY=:0 xdotool key alt+F4');
          return { success: true, output: 'Closed active window' };
        }

        case 'minimize_window': {
          const ds = await this.detectDisplayServer();
          const title = args.windowTitle as string;
          if (ds === 'wayland') {
            await this.ydotoolKey('LEFTALT+F9');
            return { success: true, output: 'Minimized active window (Wayland)' };
          }
          if (title) {
            const windowIds = await this.xdotoolSearch(title);
            if (windowIds.length > 0) {
              await this.runCommand(`DISPLAY=:0 xdotool windowminimize ${windowIds[0]}`);
              return { success: true, output: `Minimized window: ${title}` };
            }
          }
          await this.runCommand('DISPLAY=:0 xdotool key alt+F9');
          return { success: true, output: 'Minimized active window' };
        }

        case 'maximize_window': {
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolKey('SUPER+Up');
            return { success: true, output: 'Maximized window (Wayland)' };
          }
          await this.runCommand('DISPLAY=:0 xdotool key super+Up');
          return { success: true, output: 'Maximized active window' };
        }

        case 'list_windows': {
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            // Use wmctrl or just report limitation
            try {
              const { stdout } = await execAsync('wmctrl -l 2>/dev/null || swaymsg -t get_tree 2>/dev/null || true', { timeout: 3000 });
              return { success: true, output: stdout.trim() || 'Window listing limited on Wayland', data: {} };
            } catch {
              return { success: true, output: 'Window listing not available on this Wayland session', data: {} };
            }
          }
          const output = await this.runCommand('DISPLAY=:0 xdotool search --name ""');
          const windows = output.split('\n').filter(Boolean);
          const windowNames: string[] = [];
          for (const id of windows.slice(0, 20)) {
            try {
              const name = await this.runCommand(`DISPLAY=:0 xdotool getwindowname ${id}`);
              windowNames.push(`${id}: ${name}`);
            } catch {}
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
          const pos = await this.runCommand('DISPLAY=:0 xdotool getmouselocation');
          return { success: true, output: pos, data: { position: pos } };
        }

        case 'get_screen_size': {
          try {
            const { stdout } = await execAsync('DISPLAY=:0 xdpyinfo | grep dimensions 2>/dev/null || wlr-randr 2>/dev/null || echo "Unable to determine"', { timeout: 3000 });
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
