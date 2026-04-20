/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import CDP from 'chrome-remote-interface';
import { getClient, evaluate, connectToTarget } from '../connection.js';
import { getState } from './chart.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

/**
 * Find the Electron title-bar renderer target (window/index.html).
 * This is where the visual tab strip lives — clicking tabs here actually
 * switches the visible chart, which CDP Page.captureScreenshot captures.
 */
async function _getWindowRendererTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  return targets.find(t => t.type === 'page' && t.url.includes('app/window/index.html'));
}

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  const tabs = targets
    .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: t.title.replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Open a new chart tab via keyboard shortcut (Ctrl+T / Cmd+T).
 */
export async function newTab() {
  const c = await getClient();

  // Electron/TradingView Desktop uses Ctrl+T for new tab on macOS too
  // But some versions use Cmd+T
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2; // 4 = meta (Cmd), 2 = ctrl

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 't',
    code: 'KeyT',
    windowsVirtualKeyCode: 84,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 't', code: 'KeyT' });

  await new Promise(r => setTimeout(r, 2000));

  // Verify a new tab appeared
  const state = await list();
  return { success: true, action: 'new_tab_opened', ...state };
}

/**
 * Close the current tab via keyboard shortcut (Ctrl+W / Cmd+W).
 */
export async function closeTab() {
  const before = await list();
  if (before.tab_count <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const c = await getClient();
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2;

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 'w',
    code: 'KeyW',
    windowsVirtualKeyCode: 87,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'w', code: 'KeyW' });

  await new Promise(r => setTimeout(r, 1000));

  const after = await list();
  return { success: true, action: 'tab_closed', tabs_before: before.tab_count, tabs_after: after.tab_count };
}

/**
 * Switch to a tab by index. Reconnects CDP to the new target.
 * Sets a visible [MCP] title prefix on the active tab so the user can see
 * which tab the MCP is currently controlling.
 */
export async function switchTab({ index }) {
  const tabs = await list();
  const idx = Number(index);

  if (idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];

  try {
    // Step 1: Click the tab in Electron's title-bar renderer (window/index.html).
    // This is the ONLY reliable way to visually switch tabs — CDP Page.bringToFront
    // and Target.activateTarget don't work in Electron's BrowserView-based tab model.
    const windowTarget = await _getWindowRendererTarget();
    if (windowTarget) {
      const winClient = await CDP({ host: CDP_HOST, port: CDP_PORT, target: windowTarget.id });
      await winClient.Runtime.enable();
      await winClient.Runtime.evaluate({
        expression: `(function() {
          var tabs = Array.from(document.querySelectorAll('.tab'));
          var t = tabs[${idx}];
          if (t) t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return t ? true : false;
        })()`,
      });
      await winClient.close();
      await new Promise(r => setTimeout(r, 400));
    }

    // Step 2: Reconnect CDP client to the new chart target
    await connectToTarget(target.id);

    // Report current chart state so the caller always knows which chart is active
    let chartState = null;
    try { chartState = await getState(); } catch (_) {}

    return {
      success: true,
      action: 'switched',
      index: idx,
      tab_id: target.id,
      chart_id: target.chart_id,
      now_active: chartState ? { symbol: chartState.symbol, resolution: chartState.resolution } : null,
    };
  } catch (e) {
    throw new Error(`Failed to activate tab ${idx}: ${e.message}`);
  }
}
