#!/usr/bin/env node
/**
 * End-to-end test for chrome-debugger-mcp.
 *
 * 1. Spawns the MCP server as a child process (stdio transport).
 * 2. Connects a fake Chrome extension via WebSocket.
 * 3. Performs the version handshake.
 * 4. Sends MCP tool calls over stdio and verifies responses.
 *
 * The fake extension auto-replies to bridge commands with mock data.
 */

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

const PORT = 19222; // Use a non-default port to avoid conflicts
const TIMEOUT = 15_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Send a JSON-RPC message to the MCP server over stdin (newline-delimited JSON) */
function mcpRequest(proc, method, params = {}, id = null) {
  id = id || randomUUID();
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  proc.stdin.write(msg + '\n');
  return id;
}

/** Send a notification (no id) */
function mcpNotify(proc, method, params = {}) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  proc.stdin.write(msg + '\n');
}

/** Wait for MCP response with given id from stdout buffer */
function waitForResponse(responses, id, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`Timeout waiting for response id=${id}`));
    }, timeoutMs);

    const check = () => {
      const idx = responses.findIndex((r) => r.id === id);
      if (idx !== -1) {
        clearTimeout(deadline);
        resolve(responses.splice(idx, 1)[0]);
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results = [];

function assert(name, condition, detail = '') {
  if (condition) {
    passed++;
    results.push(`  ✓ ${name}`);
  } else {
    failed++;
    results.push(`  ✗ ${name}${detail ? ': ' + detail : ''}`);
  }
}

async function run() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Chrome Debugger MCP — End-to-End Test');
  console.log('═══════════════════════════════════════════════════════\n');

  // ── Step 1: Start MCP server ──────────────────────────────────────────
  console.log('▶ Starting MCP server on port', PORT);
  const server = spawn('node', ['bin/chrome-debugger-mcp.js', '--port', String(PORT)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: process.cwd(),
  });

  const responses = [];
  let lineBuf = '';

  server.stdout.on('data', (chunk) => {
    lineBuf += chunk.toString();
    // Parse newline-delimited JSON
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop(); // keep incomplete line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        responses.push(JSON.parse(trimmed));
      } catch {}
    }
  });

  let stderrLog = '';
  server.stderr.on('data', (chunk) => {
    stderrLog += chunk.toString();
  });

  // Wait for server to start listening
  await sleep(1500);

  assert('Server process started', !server.killed && server.exitCode === null);

  // ── Step 2: MCP initialize handshake ──────────────────────────────────
  console.log('▶ Performing MCP initialize handshake');
  const initId = mcpRequest(server, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e-test', version: '1.0.0' },
  });

  const initResp = await waitForResponse(responses, initId);
  assert('MCP initialize succeeds', !!initResp.result, JSON.stringify(initResp.error));
  assert('Server reports capabilities', !!initResp.result?.capabilities);
  assert('Server name is correct', initResp.result?.serverInfo?.name === 'chrome-debugger-mcp',
    `got: ${initResp.result?.serverInfo?.name}`);

  // Send initialized notification
  mcpNotify(server, 'notifications/initialized');
  await sleep(200);

  // ── Step 3: List available tools ──────────────────────────────────────
  console.log('▶ Listing MCP tools');
  const listToolsId = mcpRequest(server, 'tools/list', {});
  const toolsResp = await waitForResponse(responses, listToolsId);
  assert('tools/list succeeds', !!toolsResp.result, JSON.stringify(toolsResp.error));

  const tools = toolsResp.result?.tools || [];
  const toolNames = tools.map((t) => t.name);
  console.log(`  Found ${tools.length} tools: ${toolNames.join(', ')}`);

  assert('Has status tool', toolNames.includes('status'));
  assert('Has list_tabs tool', toolNames.includes('list_tabs'));
  assert('Has open_url tool', toolNames.includes('open_url'));
  assert('Has get_page_source tool', toolNames.includes('get_page_source'));
  assert('Has execute_js tool', toolNames.includes('execute_js'));
  assert('Has discover_links tool', toolNames.includes('discover_links'));
  assert('Has crawl_site tool', toolNames.includes('crawl_site'));
  assert('Has execute_on_page tool', toolNames.includes('execute_on_page'));

  // ── Step 4: Call status tool (no extension connected yet) ─────────────
  console.log('▶ Calling status tool (before extension connects)');
  const statusId1 = mcpRequest(server, 'tools/call', {
    name: 'status',
    arguments: {},
  });
  const statusResp1 = await waitForResponse(responses, statusId1);
  assert('status tool returns result', !!statusResp1.result, JSON.stringify(statusResp1.error));

  const statusData1 = JSON.parse(statusResp1.result?.content?.[0]?.text || '{}');
  assert('Server reports running', statusData1.serverRunning === true);
  assert('Extension shows disconnected', statusData1.extensionConnected === false);
  assert('Reports correct port', statusData1.wsPort === PORT, `got: ${statusData1.wsPort}`);

  // ── Step 5: Connect fake Chrome extension via WebSocket ───────────────
  console.log('▶ Connecting fake Chrome extension via WebSocket');
  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    socket.on('open', () => resolve(socket));
    socket.on('error', (err) => reject(err));
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });
  assert('WebSocket connected', ws.readyState === WebSocket.OPEN);

  // ── Step 6: Perform extension handshake ───────────────────────────────
  console.log('▶ Performing extension handshake');
  const handshakeId = randomUUID();

  // Set up listener BEFORE sending
  const handshakeReplyPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Handshake reply timeout')), 5000);
    ws.once('message', (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()));
    });
  });

  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: handshakeId,
    method: 'handshake',
    params: { version: '1.0.0' },
  }));

  const handshakeReply = await handshakeReplyPromise;

  assert('Handshake accepted', handshakeReply.result?.accepted === true,
    JSON.stringify(handshakeReply));
  assert('Server version in handshake', handshakeReply.result?.serverVersion === '1.0.0',
    `got: ${handshakeReply.result?.serverVersion}`);

  // ── Step 7: Set up fake extension responder ───────────────────────────
  console.log('▶ Setting up fake extension command responder');

  // Mock data the fake extension will return
  const mockTabs = [
    { id: 1, url: 'https://example.com/', title: 'Example Domain', active: true },
    { id: 2, url: 'https://github.com/', title: 'GitHub', active: false },
  ];

  // State for tab reuse simulation
  const openedTabs = new Map(); // url -> tabId
  let nextMockTabId = 100;

  function setupResponder(socket) {
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (!msg.method) return;

      let result;
      switch (msg.method) {
        case 'tabs.list':
          result = mockTabs;
          break;
        case 'tabs.open': {
          const url = msg.params?.url;
          const reuseTab = msg.params?.reuseTab;
          const reqTabId = msg.params?.tabId;

          // Simulate timeout for specific URL
          if (url === 'https://timeout-test.invalid/') {
            socket.send(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32603, message: 'Page failed to load within 30000ms' },
            }));
            return;
          }

          // Direct navigation by tabId
          if (reqTabId !== undefined) {
            // Simulate invalid tabId
            if (reqTabId === 99999) {
              socket.send(JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32603, message: `Tab ${reqTabId} not found` },
              }));
              return;
            }
            result = {
              tabId: reqTabId,
              url,
              title: 'Navigated Page',
              navigated: true,
              reused: false,
            };
            break;
          }

          // Tab reuse: return same tabId when URL was previously opened
          if (reuseTab !== false && openedTabs.has(url)) {
            result = {
              tabId: openedTabs.get(url),
              url,
              title: 'Loaded Page',
              reused: true,
            };
          } else {
            const tabId = nextMockTabId++;
            openedTabs.set(url, tabId);
            result = {
              tabId,
              url,
              title: 'Loaded Page',
              reused: false,
            };
          }
          break;
        }
        case 'tabs.close':
          result = { closed: true, tabId: msg.params?.tabId };
          break;
        case 'tabs.switch':
          result = { switched: true, tabId: msg.params?.tabId };
          break;
        case 'tabs.reload':
          result = { reloaded: true, tabId: msg.params?.tabId };
          break;
        case 'dom.getSource':
          result = { html: '<html><body>Hello World</body></html>', url: 'https://example.com/' };
          break;
        case 'dom.getRendered':
          result = { html: '<html><body>Hello Rendered World</body></html>', url: 'https://example.com/' };
          break;
        case 'scripting.execute':
          result = { value: 42, type: 'number' };
          break;
        case 'resources.list':
          result = [
            { url: 'https://example.com/style.css', type: 'stylesheet' },
            { url: 'https://example.com/app.js', type: 'script' },
          ];
          break;
        case 'cookies.get':
          result = [{ name: 'session', value: 'abc123', domain: '.example.com' }];
          break;
        case 'storage.get':
          result = { items: { theme: 'dark', lang: 'en' } };
          break;
        case 'links.discover':
          result = [
            { url: 'https://example.com/about', text: 'About' },
            { url: 'https://example.com/contact', text: 'Contact' },
          ];
          break;
        case 'page.executeOnPage': {
          const url = msg.params?.url;
          const script = msg.params?.script;

          // Simulate timeout for specific URL (same URL used by open_url timeout test)
          if (url === 'https://timeout-test.invalid/') {
            socket.send(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32603, message: 'Page failed to load within 30000ms' },
            }));
            return;
          }

          // Simulate script error when script contains 'throw'
          if (script && script.includes('throw')) {
            socket.send(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32603, message: `Script execution failed: ${script}` },
            }));
            return;
          }

          // Happy path — simulate successful atomic execution
          result = {
            result: `Executed: ${script}`,
            url,
            duration: 150,
          };
          break;
        }
        case 'screenshot.capture':
          result = { dataUrl: 'data:image/png;base64,iVBOR...', format: 'png' };
          break;
        default:
          socket.send(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `Unknown method: ${msg.method}` },
          }));
          return;
      }

      socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  }

  setupResponder(ws);
  await sleep(200);

  // ── Step 8: Call status tool (extension now connected) ────────────────
  console.log('▶ Calling status tool (extension connected)');
  const statusId2 = mcpRequest(server, 'tools/call', {
    name: 'status',
    arguments: {},
  });
  const statusResp2 = await waitForResponse(responses, statusId2);
  const statusData2 = JSON.parse(statusResp2.result?.content?.[0]?.text || '{}');
  assert('Extension now connected', statusData2.extensionConnected === true);
  assert('Extension version reported', statusData2.extensionVersion === '1.0.0',
    `got: ${statusData2.extensionVersion}`);

  // ── Step 9: Call list_tabs ────────────────────────────────────────────
  console.log('▶ Calling list_tabs tool');
  const listTabsId = mcpRequest(server, 'tools/call', {
    name: 'list_tabs',
    arguments: {},
  });
  const listTabsResp = await waitForResponse(responses, listTabsId);
  assert('list_tabs returns result', !!listTabsResp.result, JSON.stringify(listTabsResp.error));

  const tabsData = JSON.parse(listTabsResp.result?.content?.[0]?.text || '[]');
  assert('Returns 2 tabs', Array.isArray(tabsData) && tabsData.length === 2, `got: ${JSON.stringify(tabsData)}`);
  assert('First tab is example.com', tabsData[0]?.url === 'https://example.com/');
  assert('Second tab is github.com', tabsData[1]?.url === 'https://github.com/');

  // ── Step 10: Call open_url ────────────────────────────────────────────
  console.log('▶ Calling open_url tool');
  const openUrlId = mcpRequest(server, 'tools/call', {
    name: 'open_url',
    arguments: { url: 'https://nodejs.org/' },
  });
  const openUrlResp = await waitForResponse(responses, openUrlId);
  assert('open_url returns result', !!openUrlResp.result, JSON.stringify(openUrlResp.error));

  const openResult = JSON.parse(openUrlResp.result?.content?.[0]?.text || '{}');
  assert('New tab has correct URL', openResult.url === 'https://nodejs.org/');
  assert('New tab has tabId', typeof openResult.tabId === 'number');
  assert('New tab has title', typeof openResult.title === 'string' && openResult.title.length > 0);
  assert('New tab is not reused', openResult.reused === false);

  // ── Step 11: Call get_page_source ─────────────────────────────────────
  console.log('▶ Calling get_page_source tool');
  const sourceId = mcpRequest(server, 'tools/call', {
    name: 'get_page_source',
    arguments: { tabId: 1 },
  });
  const sourceResp = await waitForResponse(responses, sourceId);
  assert('get_page_source returns result', !!sourceResp.result);

  const sourceData = JSON.parse(sourceResp.result?.content?.[0]?.text || '{}');
  assert('HTML source returned', sourceData.html?.includes('Hello World'));

  // ── Step 12: Call get_rendered_dom ─────────────────────────────────────
  console.log('▶ Calling get_rendered_dom tool');
  const renderedId = mcpRequest(server, 'tools/call', {
    name: 'get_rendered_dom',
    arguments: { tabId: 1 },
  });
  const renderedResp = await waitForResponse(responses, renderedId);
  assert('get_rendered_dom returns result', !!renderedResp.result);

  const renderedData = JSON.parse(renderedResp.result?.content?.[0]?.text || '{}');
  assert('Rendered DOM returned', renderedData.html?.includes('Rendered World'));

  // ── Step 13: Call execute_js ──────────────────────────────────────────
  console.log('▶ Calling execute_js tool');
  const execJsId = mcpRequest(server, 'tools/call', {
    name: 'execute_js',
    arguments: { tabId: 1, script: '6 * 7' },
  });
  const execJsResp = await waitForResponse(responses, execJsId);
  assert('execute_js returns result', !!execJsResp.result);

  const jsResult = JSON.parse(execJsResp.result?.content?.[0]?.text || '{}');
  assert('JS execution returns value', jsResult.value === 42);

  // ── Step 14: Call get_page_resources ───────────────────────────────────
  console.log('▶ Calling get_page_resources tool');
  const resId = mcpRequest(server, 'tools/call', {
    name: 'get_page_resources',
    arguments: { tabId: 1 },
  });
  const resResp = await waitForResponse(responses, resId);
  assert('get_page_resources returns result', !!resResp.result);

  const resources = JSON.parse(resResp.result?.content?.[0]?.text || '[]');
  assert('Returns 2 resources', Array.isArray(resources) && resources.length === 2);

  // ── Step 15: Call take_screenshot ──────────────────────────────────────
  console.log('▶ Calling take_screenshot tool');
  const ssId = mcpRequest(server, 'tools/call', {
    name: 'take_screenshot',
    arguments: { tabId: 1 },
  });
  const ssResp = await waitForResponse(responses, ssId);
  assert('take_screenshot returns result', !!ssResp.result);

  const ssData = JSON.parse(ssResp.result?.content?.[0]?.text || '{}');
  assert('Screenshot dataUrl returned', ssData.dataUrl?.startsWith('data:image/png'));

  // ── Step 16: Call close_tab ───────────────────────────────────────────
  console.log('▶ Calling close_tab tool');
  const closeTabId = mcpRequest(server, 'tools/call', {
    name: 'close_tab',
    arguments: { tabId: 2 },
  });
  const closeTabResp = await waitForResponse(responses, closeTabId);
  assert('close_tab returns result', !!closeTabResp.result);

  const closeData = JSON.parse(closeTabResp.result?.content?.[0]?.text || '{}');
  assert('Tab closed successfully', closeData.closed === true);

  // ── Step 17: Call switch_tab ──────────────────────────────────────────
  console.log('▶ Calling switch_tab tool');
  const switchTabId = mcpRequest(server, 'tools/call', {
    name: 'switch_tab',
    arguments: { tabId: 1 },
  });
  const switchTabResp = await waitForResponse(responses, switchTabId);
  assert('switch_tab returns result', !!switchTabResp.result);

  const switchData = JSON.parse(switchTabResp.result?.content?.[0]?.text || '{}');
  assert('Tab switched successfully', switchData.switched === true);

  // ── Step 18: Call reload_tab ──────────────────────────────────────────
  console.log('▶ Calling reload_tab tool');
  const reloadTabId = mcpRequest(server, 'tools/call', {
    name: 'reload_tab',
    arguments: { tabId: 1 },
  });
  const reloadTabResp = await waitForResponse(responses, reloadTabId);
  assert('reload_tab returns result', !!reloadTabResp.result);

  const reloadData = JSON.parse(reloadTabResp.result?.content?.[0]?.text || '{}');
  assert('Tab reloaded successfully', reloadData.reloaded === true);

  // ── Step 19: Call discover_links ──────────────────────────────────────
  console.log('▶ Calling discover_links tool');
  const linksId = mcpRequest(server, 'tools/call', {
    name: 'discover_links',
    arguments: { tabId: 1 },
  });
  const linksResp = await waitForResponse(responses, linksId);
  assert('discover_links returns result', !!linksResp.result);

  const links = JSON.parse(linksResp.result?.content?.[0]?.text || '[]');
  assert('Returns 2 links', Array.isArray(links) && links.length === 2);
  assert('First link is /about', links[0]?.url === 'https://example.com/about');

  // ── Step 20: Test open_url tab reuse ──────────────────────────────────
  console.log('▶ Testing open_url tab reuse');
  const reuseId = mcpRequest(server, 'tools/call', {
    name: 'open_url',
    arguments: { url: 'https://nodejs.org/' },
  });
  const reuseResp = await waitForResponse(responses, reuseId);
  assert('tab reuse returns result', !!reuseResp.result, JSON.stringify(reuseResp.error));

  const reuseResult = JSON.parse(reuseResp.result?.content?.[0]?.text || '{}');
  assert('Reused tab has same tabId', reuseResult.tabId === openResult.tabId);
  assert('Reused tab reports reused: true', reuseResult.reused === true);
  assert('Reused tab has title', typeof reuseResult.title === 'string' && reuseResult.title.length > 0);

  // ── Step 21: Test open_url with reuseTab=false ──────────────────────
  console.log('▶ Testing open_url reuseTab=false');
  const forceNewId = mcpRequest(server, 'tools/call', {
    name: 'open_url',
    arguments: { url: 'https://nodejs.org/', reuseTab: false },
  });
  const forceNewResp = await waitForResponse(responses, forceNewId);
  assert('force new tab returns result', !!forceNewResp.result, JSON.stringify(forceNewResp.error));

  const forceNewResult = JSON.parse(forceNewResp.result?.content?.[0]?.text || '{}');
  assert('Force new tab has different tabId', forceNewResult.tabId !== openResult.tabId);
  assert('Force new tab reports reused: false', forceNewResult.reused === false);

  // ── Step 22: Test open_url timeout error handling ───────────────────
  console.log('▶ Testing open_url timeout error handling');
  const timeoutId = mcpRequest(server, 'tools/call', {
    name: 'open_url',
    arguments: { url: 'https://timeout-test.invalid/' },
  });
  const timeoutResp = await waitForResponse(responses, timeoutId);
  const isErrorResponse = !!timeoutResp.error || timeoutResp.result?.isError;
  assert('timeout returns error response', isErrorResponse, 'Expected error but got result');
  const timeoutErrMsg = timeoutResp.error?.message || timeoutResp.result?.content?.[0]?.text || '';
  assert('timeout error contains URL', timeoutErrMsg.includes('timeout-test.invalid'),
    `error: ${timeoutErrMsg}`);

  // ── Step 23: Test open_url with tabId (navigate existing tab) ──────
  console.log('▶ Testing open_url with tabId (navigate existing tab)');
  const navTabId = mcpRequest(server, 'tools/call', {
    name: 'open_url',
    arguments: { url: 'https://new-destination.com/', tabId: openResult.tabId },
  });
  const navTabResp = await waitForResponse(responses, navTabId);
  assert('open_url tabId returns result', !!navTabResp.result, JSON.stringify(navTabResp.error));

  const navResult = JSON.parse(navTabResp.result?.content?.[0]?.text || '{}');
  assert('Navigated tab has same tabId', navResult.tabId === openResult.tabId);
  assert('Navigated tab has new URL', navResult.url === 'https://new-destination.com/');
  assert('Navigated tab reports navigated: true', navResult.navigated === true);
  assert('Navigated tab reports reused: false', navResult.reused === false);

  // ── Step 24: Test open_url with invalid tabId ─────────────────────
  console.log('▶ Testing open_url with invalid tabId');
  const badTabId = mcpRequest(server, 'tools/call', {
    name: 'open_url',
    arguments: { url: 'https://example.com/', tabId: 99999 },
  });
  const badTabResp = await waitForResponse(responses, badTabId);
  const isBadTabErr = !!badTabResp.error || badTabResp.result?.isError;
  assert('invalid tabId returns error response', isBadTabErr, 'Expected error but got result');
  const badTabErrMsg = badTabResp.error?.message || badTabResp.result?.content?.[0]?.text || '';
  assert('invalid tabId error mentions not found', badTabErrMsg.includes('not found') || badTabErrMsg.includes('does not exist'),
    `error: ${badTabErrMsg}`);

  // ── Step 25: Test execute_on_page happy path ────────────────────────
  console.log('▶ Testing execute_on_page happy path');
  const execPageId = mcpRequest(server, 'tools/call', {
    name: 'execute_on_page',
    arguments: { url: 'https://example.com', script: 'document.title' },
  });
  const execPageResp = await waitForResponse(responses, execPageId);
  assert('execute_on_page returns result', !!execPageResp.result, JSON.stringify(execPageResp.error));

  const execPageResult = JSON.parse(execPageResp.result?.content?.[0]?.text || '{}');
  assert('execute_on_page has result field', execPageResult.result !== undefined);
  assert('execute_on_page has url field', execPageResult.url === 'https://example.com');
  assert('execute_on_page has duration field', typeof execPageResult.duration === 'number');

  // Verify no tab leakage — list_tabs should still return same 2 mock tabs
  const tabCheckId1 = mcpRequest(server, 'tools/call', {
    name: 'list_tabs',
    arguments: {},
  });
  const tabCheckResp1 = await waitForResponse(responses, tabCheckId1);
  const tabCheck1 = JSON.parse(tabCheckResp1.result?.content?.[0]?.text || '[]');
  assert('No tab leakage after execute_on_page', Array.isArray(tabCheck1) && tabCheck1.length === 2);

  // ── Step 24: Test execute_on_page script error ──────────────────────
  console.log('▶ Testing execute_on_page script error');
  const execErrId = mcpRequest(server, 'tools/call', {
    name: 'execute_on_page',
    arguments: { url: 'https://example.com', script: 'throw new Error("test")' },
  });
  const execErrResp = await waitForResponse(responses, execErrId);
  const isScriptErr = !!execErrResp.error || execErrResp.result?.isError;
  assert('script error returns error response', isScriptErr, 'Expected error but got result');

  // Verify no tab leakage after script error
  const tabCheckId2 = mcpRequest(server, 'tools/call', {
    name: 'list_tabs',
    arguments: {},
  });
  const tabCheckResp2 = await waitForResponse(responses, tabCheckId2);
  const tabCheck2 = JSON.parse(tabCheckResp2.result?.content?.[0]?.text || '[]');
  assert('No tab leakage after script error', Array.isArray(tabCheck2) && tabCheck2.length === 2);

  // ── Step 25: Test execute_on_page timeout ───────────────────────────
  console.log('▶ Testing execute_on_page timeout');
  const execTimeoutId = mcpRequest(server, 'tools/call', {
    name: 'execute_on_page',
    arguments: { url: 'https://timeout-test.invalid/', script: 'document.title' },
  });
  const execTimeoutResp = await waitForResponse(responses, execTimeoutId);
  const isTimeoutErr = !!execTimeoutResp.error || execTimeoutResp.result?.isError;
  assert('execute_on_page timeout returns error', isTimeoutErr, 'Expected error but got result');
  const execTimeoutMsg = execTimeoutResp.error?.message || execTimeoutResp.result?.content?.[0]?.text || '';
  assert('execute_on_page timeout contains URL', execTimeoutMsg.includes('timeout-test.invalid'),
    `error: ${execTimeoutMsg}`);

  // Verify no tab leakage after timeout
  const tabCheckId3 = mcpRequest(server, 'tools/call', {
    name: 'list_tabs',
    arguments: {},
  });
  const tabCheckResp3 = await waitForResponse(responses, tabCheckId3);
  const tabCheck3 = JSON.parse(tabCheckResp3.result?.content?.[0]?.text || '[]');
  assert('No tab leakage after timeout', Array.isArray(tabCheck3) && tabCheck3.length === 2);

  // ── Step 26: Test extension disconnect / reconnect handling ───────────
  console.log('▶ Testing extension disconnect handling');
  ws.close(1000, 'Test disconnect');
  await sleep(500);

  const statusId3 = mcpRequest(server, 'tools/call', {
    name: 'status',
    arguments: {},
  });
  const statusResp3 = await waitForResponse(responses, statusId3);
  const statusData3 = JSON.parse(statusResp3.result?.content?.[0]?.text || '{}');
  assert('Extension reports disconnected after close', statusData3.extensionConnected === false);

  // ── Step 27: Reconnect extension ──────────────────────────────────────
  console.log('▶ Reconnecting extension');
  const ws2 = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    socket.on('open', () => resolve(socket));
    socket.on('error', (err) => reject(err));
    setTimeout(() => reject(new Error('WS reconnect timeout')), 5000);
  });

  // Handshake again — set up listener before sending
  const hs2Id = randomUUID();
  const hs2Promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Reconnect handshake timeout')), 5000);
    ws2.once('message', (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()));
    });
  });

  ws2.send(JSON.stringify({
    jsonrpc: '2.0',
    id: hs2Id,
    method: 'handshake',
    params: { version: '1.0.0' },
  }));

  const hs2Reply = await hs2Promise;

  assert('Reconnect handshake accepted', hs2Reply.result?.accepted === true);

  // Mock responder for reconnected socket
  ws2.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (!msg.method) return;
    if (msg.method === 'tabs.list') {
      ws2.send(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: [{ id: 10, url: 'https://reconnected.com/', title: 'Reconnected', active: true }],
      }));
    }
  });

  await sleep(200);

  // Verify reconnection works
  const statusId4 = mcpRequest(server, 'tools/call', {
    name: 'status',
    arguments: {},
  });
  const statusResp4 = await waitForResponse(responses, statusId4);
  const statusData4 = JSON.parse(statusResp4.result?.content?.[0]?.text || '{}');
  assert('Extension connected after reconnect', statusData4.extensionConnected === true);

  // Verify tools work after reconnect
  const listTabsId2 = mcpRequest(server, 'tools/call', {
    name: 'list_tabs',
    arguments: {},
  });
  const listTabsResp2 = await waitForResponse(responses, listTabsId2);
  const tabs2 = JSON.parse(listTabsResp2.result?.content?.[0]?.text || '[]');
  assert('list_tabs works after reconnect', tabs2[0]?.url === 'https://reconnected.com/');

  // ── Cleanup ───────────────────────────────────────────────────────────
  ws2.close();
  await sleep(200);
  server.kill('SIGTERM');
  await sleep(500);

  // ── Results ───────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════\n');
  for (const r of results) console.log(r);
  console.log(`\n  Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}\n`);

  if (failed > 0) {
    console.log('  ❌ SOME TESTS FAILED\n');
    process.exit(1);
  } else {
    console.log('  ✅ ALL TESTS PASSED\n');
    process.exit(0);
  }
}

// Run with global timeout
const globalTimeout = setTimeout(() => {
  console.error('\n⏱ Global timeout reached — aborting');
  process.exit(1);
}, TIMEOUT);

run()
  .catch((err) => {
    console.error('\n💥 Fatal error:', err);
    process.exit(1);
  })
  .finally(() => clearTimeout(globalTimeout));
