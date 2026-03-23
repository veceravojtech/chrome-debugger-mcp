// Link discovery handler for MCP bridge.
// Extracts all navigable links from a page via chrome.scripting.executeScript.

async function discoverLinks(params) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: params.tabId },
      func: () => {
        const seen = new Set();
        const links = [];
        const anchors = document.querySelectorAll('a[href]');

        for (const a of anchors) {
          try {
            const url = new URL(a.href, document.baseURI).href;

            // Skip non-navigable protocols
            if (url.startsWith('javascript:') || url.startsWith('mailto:') ||
                url.startsWith('tel:') || url.startsWith('data:')) {
              continue;
            }

            // Deduplicate by URL
            if (seen.has(url)) continue;
            seen.add(url);

            const attributes = {};
            if (a.rel) attributes.rel = a.rel;
            if (a.target) attributes.target = a.target;
            if (a.title) attributes.title = a.title;
            if (a.id) attributes.id = a.id;
            if (a.className) attributes.class = a.className;

            links.push({
              url,
              text: (a.textContent || '').trim(),
              attributes,
            });
          } catch {
            // Skip malformed URLs
          }
        }
        return links;
      },
    });
    return results[0].result;
  } catch (err) {
    throw new Error(`Failed to discover links for tab ${params.tabId}: ${err.message}`);
  }
}

export const linkHandlers = {
  discoverLinks,
};
