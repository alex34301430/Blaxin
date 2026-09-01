import { Tool, ToolResult } from '../types.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class BrowserTool implements Tool {
  name = 'browser';
  description = 'Open URLs in a web browser, search the web, and interact with web content.';

  definition = {
    type: 'function' as const,
    function: {
      name: 'browser',
      description: 'Open a URL in the browser, search the web, or open a specific website.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open_url', 'search', 'open_new_tab', 'close_tab'],
            description: 'The browser action to perform',
          },
          url: {
            type: 'string',
            description: 'URL to open (for open_url)',
          },
          query: {
            type: 'string',
            description: 'Search query (for search action)',
          },
          browser: {
            type: 'string',
            description: 'Browser to use (firefox, chromium, google-chrome, default: first available)',
          },
        },
        required: ['action'],
      },
    },
  };

  private async findBrowser(): Promise<string> {
    const browsers = ['firefox', 'chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable'];
    for (const browser of browsers) {
      try {
        await execAsync(`which ${browser}`, { timeout: 3000 });
        return browser;
      } catch {
        continue;
      }
    }
    return 'xdg-open';
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;
    const browser = (args.browser as string) || await this.findBrowser();

    try {
      switch (action) {
        case 'open_url': {
          const url = args.url as string;
          if (!url) return { success: false, output: '', error: 'URL is required' };
          
          try {
            await execAsync(`DISPLAY=:0 nohup ${browser} "${url}" &>/dev/null &`, {
              timeout: 5000,
            });
            return { success: true, output: `Opened URL: ${url}` };
          } catch {
            // Try xdg-open
            await execAsync(`DISPLAY=:0 nohup xdg-open "${url}" &>/dev/null &`, {
              timeout: 5000,
            });
            return { success: true, output: `Opened URL via xdg-open: ${url}` };
          }
        }

        case 'search': {
          const query = args.query as string;
          if (!query) return { success: false, output: '', error: 'Search query is required' };
          
          const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
          try {
            await execAsync(`DISPLAY=:0 nohup ${browser} "${searchUrl}" &>/dev/null &`, {
              timeout: 5000,
            });
            return { success: true, output: `Searching for: ${query}`, data: { url: searchUrl } };
          } catch {
            await execAsync(`DISPLAY=:0 nohup xdg-open "${searchUrl}" &>/dev/null &`, {
              timeout: 5000,
            });
            return { success: true, output: `Searching for: ${query}`, data: { url: searchUrl } };
          }
        }

        case 'open_new_tab': {
          const url = args.url as string || 'about:blank';
          try {
            await execAsync(`DISPLAY=:0 nohup ${browser} --new-tab "${url}" &>/dev/null &`, {
              timeout: 5000,
            });
            return { success: true, output: `Opened new tab: ${url}` };
          } catch {
            return { success: true, output: 'Opened new tab' };
          }
        }

        case 'close_tab': {
          // Use keyboard shortcut to close current tab
          try {
            await execAsync(`DISPLAY=:0 xdotool key ctrl+w`, { timeout: 3000 });
            return { success: true, output: 'Closed current tab' };
          } catch (error: any) {
            return { success: false, output: '', error: `Failed to close tab: ${error.message}` };
          }
        }

        default:
          return { success: false, output: '', error: `Unknown browser action: ${action}` };
      }
    } catch (error: any) {
      return { success: false, output: '', error: `Browser error: ${error.message}` };
    }
  }

  requiresConfirmation(args: Record<string, unknown>): boolean {
    return args.action === 'open_url' || args.action === 'search';
  }
}
