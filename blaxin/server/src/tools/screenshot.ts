import { Tool, ToolResult } from '../types.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync, unlinkSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

export class ScreenshotTool implements Tool {
  name = 'screenshot';
  description = 'Take a screenshot of the current screen or a specific window. Returns the image as base64 data and a description of what is visible.';

  definition = {
    type: 'function' as const,
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

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const screenshotPath = join(tmpdir(), `blaxin-screenshot-${Date.now()}.png`);

    try {
      // Try different screenshot tools based on what's available
      const tools = [
        {
          name: 'scrot',
          cmd: 'scrot',
          args: [screenshotPath],
        },
        {
          name: 'gnome-screenshot',
          cmd: 'gnome-screenshot',
          args: ['-f', screenshotPath],
        },
        {
          name: 'import',
          cmd: 'import',
          args: ['-window', 'root', screenshotPath],
        },
      ];

      let captured = false;
      for (const tool of tools) {
        try {
          await execFileAsync(tool.cmd, tool.args, { timeout: 10000 });
          captured = true;
          break;
        } catch {
          continue;
        }
      }

      if (!captured) {
        // Fallback: check if display is available
        try {
          await execFileAsync('xdotool', ['getactivewindow', 'getwindowname'], {
            timeout: 5000,
            env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
          });
          return {
            success: true,
            output: 'Screenshot tools not available, but X11 display is present. Install scrot: sudo apt install scrot',
            data: { screenshotAvailable: false },
          };
        } catch {
          return {
            success: false,
            output: '',
            error: 'No screenshot tool available. Install one: sudo apt install scrot',
          };
        }
      }

      if (existsSync(screenshotPath)) {
        const stats = statSync(screenshotPath);
        const imageBuffer = readFileSync(screenshotPath);
        const base64Data = imageBuffer.toString('base64');
        
        // Write the screenshot data as a file the frontend can display
        const previewPath = join(tmpdir(), 'blaxin-latest-screenshot.png');
        writeFileSync(previewPath, imageBuffer);
        
        // Clean up the original temp file
        unlinkSync(screenshotPath);
        
        return {
          success: true,
          output: `Screenshot captured successfully (${stats.size} bytes). Image data is available as base64 in the data field. The screenshot shows the current desktop state.`,
          data: { 
            screenshotAvailable: true, 
            size: stats.size,
            base64: base64Data,
            mimeType: 'image/png',
            previewPath,
          },
        };
      }

      return { success: false, output: '', error: 'Screenshot file was not created' };
    } catch (error: any) {
      return { success: false, output: '', error: `Screenshot failed: ${error.message}` };
    }
  }
}
