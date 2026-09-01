import { Tool, ToolResult } from '../types.js';

export class SearchTool implements Tool {
  name = 'search';
  description = 'Search the web for information. Returns search results with titles, URLs, and snippets.';

  definition = {
    type: 'function' as const,
    function: {
      name: 'search',
      description: 'Search the web for information about any topic.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query',
          },
          numResults: {
            type: 'number',
            description: 'Number of results to return (default: 5)',
          },
        },
        required: ['query'],
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = args.query as string;
    const numResults = (args.numResults as number) || 5;

    if (!query) {
      return { success: false, output: '', error: 'Search query is required' };
    }

    try {
      // Use DuckDuckGo Lite (HTML version) - more reliable for scraping
      const ddgUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
      
      const response = await fetch(ddgUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!response.ok) {
        // Fallback: try opening the browser search
        return { 
          success: false, 
          output: '', 
          error: `Search service returned HTTP ${response.status}. Try using the browser tool instead.` 
        };
      }

      const html = await response.text();
      
      const results: Array<{ title: string; url: string; snippet: string }> = [];
      
      // DuckDuckGo Lite uses simple table-based HTML
      // Extract result links: <a rel="nofollow" class="result-link" href="URL">TITLE</a>
      const linkPattern = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([^<]*(?:<[^>]+>[^<]*)*)<\/a>/gi;
      // Extract snippets from result snippets
      const snippetPattern = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
      
      // Collect all links
      const links: Array<{ url: string; title: string }> = [];
      let match;
      while ((match = linkPattern.exec(html))) {
        const url = match[1].trim();
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        if (title && url && !url.includes('duckduckgo.com')) {
          links.push({ url, title });
        }
      }
      
      // Collect snippets
      const snippets: string[] = [];
      while ((match = snippetPattern.exec(html))) {
        snippets.push(match[1].replace(/<[^>]+>/g, '').trim());
      }
      
      // Combine links and snippets
      for (let i = 0; i < Math.min(links.length, numResults); i++) {
        results.push({
          title: links[i].title,
          url: links[i].url,
          snippet: snippets[i] || '',
        });
      }

      if (results.length === 0) {
        // If DDG Lite parsing fails, try the HTML API as fallback
        try {
          const apiResponse = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
          if (apiResponse.ok) {
            const apiData = await apiResponse.json() as any;
            const abstract = apiData.AbstractText || '';
            const relatedTopics = (apiData.RelatedTopics || []).slice(0, numResults);
            
            if (abstract) {
              results.push({ title: query, url: apiData.AbstractURL || '', snippet: abstract });
            }
            for (const topic of relatedTopics) {
              if (topic.Text && topic.FirstURL) {
                results.push({ title: topic.Text.slice(0, 100), url: topic.FirstURL, snippet: '' });
              }
            }
          }
        } catch {}
      }

      if (results.length === 0) {
        return {
          success: true,
          output: `Search completed for "${query}" but no structured results were found. Try opening a browser to search directly.`,
          data: { query, results: [] },
        };
      }

      const output = results
        .map((r, i) => {
          let entry = `${i + 1}. ${r.title}\n   URL: ${r.url}`;
          if (r.snippet) entry += `\n   ${r.snippet}`;
          return entry;
        })
        .join('\n\n');

      return {
        success: true,
        output: `Search results for "${query}":\n\n${output}`,
        data: { query, results },
      };
    } catch (error: any) {
      return {
        success: false,
        output: '',
        error: `Search failed: ${error.message}. Try using the browser tool to search directly.`,
      };
    }
  }
}
