export class SearchTool {
    name = 'search';
    description = 'Search the web for information. Returns search results with titles, URLs, and snippets.';
    definition = {
        type: 'function',
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
    async execute(args) {
        const query = args.query;
        const numResults = args.numResults || 5;
        if (!query) {
            return { success: false, output: '', error: 'Search query is required' };
        }
        try {
            // Use Google search via scraping (basic approach)
            const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${numResults}`;
            const response = await fetch(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
            });
            if (!response.ok) {
                return { success: false, output: '', error: `Search failed: HTTP ${response.status}` };
            }
            const html = await response.text();
            // Basic HTML parsing for search results
            const results = [];
            // Extract search results using regex patterns
            const linkPattern = /<a[^>]*href="\/url\?q=([^&"]+)[^"]*"[^>]*>(.*?)<\/a>/g;
            const snippetPattern = /<div[^>]*class="[^"]*"[^>]*>(.*?)<\/div>/g;
            let match;
            while ((match = linkPattern.exec(html)) && results.length < numResults) {
                const url = decodeURIComponent(match[1]);
                const title = match[2].replace(/<[^>]+>/g, '').trim();
                if (title && url && !url.includes('google.com')) {
                    results.push({
                        title,
                        url,
                        snippet: '',
                    });
                }
            }
            if (results.length === 0) {
                return {
                    success: true,
                    output: `Search completed for "${query}" but parsing returned no results. Try opening a browser instead.`,
                    data: { query, results: [] },
                };
            }
            const output = results
                .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`)
                .join('\n\n');
            return {
                success: true,
                output: `Search results for "${query}":\n\n${output}`,
                data: { query, results },
            };
        }
        catch (error) {
            return {
                success: false,
                output: '',
                error: `Search failed: ${error.message}. Try using the browser tool to search directly.`,
            };
        }
    }
}
//# sourceMappingURL=search.js.map