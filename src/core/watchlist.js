/**
 * Core watchlist logic.
 * Uses TradingView's internal widget API with DOM fallback.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';

export async function get() {
  // Try internal API first — reads from the active watchlist widget
  const symbols = await evaluate(`
    (function() {
      // Method 1: Try the watchlist widget's internal data
      try {
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        if (!rightArea || rightArea.offsetWidth < 50) return { symbols: [], source: 'panel_closed' };
      } catch(e) {}

      // Method 2: Read data-symbol-full attributes from watchlist rows
      var results = [];
      var seen = {};
      var container = document.querySelector('[class*="layout__area--right"]');
      if (!container) return { symbols: [], source: 'no_container' };

      // Find all elements with symbol data attributes
      var symbolEls = container.querySelectorAll('[data-symbol-full]');
      for (var i = 0; i < symbolEls.length; i++) {
        var sym = symbolEls[i].getAttribute('data-symbol-full');
        if (!sym || seen[sym]) continue;
        seen[sym] = true;

        // Find the row and extract price data
        var row = symbolEls[i].closest('[class*="row"]') || symbolEls[i].parentElement;
        var cells = row ? row.querySelectorAll('[class*="cell"], [class*="column"]') : [];
        var nums = [];
        for (var j = 0; j < cells.length; j++) {
          var t = cells[j].textContent.trim();
          if (t && /^[\\-+]?[\\d,]+\\.?\\d*%?$/.test(t.replace(/[\\s,]/g, ''))) nums.push(t);
        }
        results.push({ symbol: sym, last: nums[0] || null, change: nums[1] || null, change_percent: nums[2] || null });
      }

      if (results.length > 0) return { symbols: results, source: 'data_attributes' };

      // Method 3: Scan for ticker-like text in the right panel
      var items = container.querySelectorAll('[class*="symbolName"], [class*="tickerName"], [class*="symbol-"]');
      for (var k = 0; k < items.length; k++) {
        var text = items[k].textContent.trim();
        if (text && /^[A-Z][A-Z0-9.:!]{0,20}$/.test(text) && !seen[text]) {
          seen[text] = true;
          results.push({ symbol: text, last: null, change: null, change_percent: null });
        }
      }

      return { symbols: results, source: results.length > 0 ? 'text_scan' : 'empty' };
    })()
  `);

  return {
    success: true,
    count: symbols?.symbols?.length || 0,
    source: symbols?.source || 'unknown',
    symbols: symbols?.symbols || [],
  };
}

// Dispatch real mouse events (mousedown → mouseup → click) with coordinates.
// TradingView Desktop (Electron 38+) ignores synthetic .click() — React event
// handlers require real MouseEvents with clientX/clientY.
function _realClick(el) {
  return `
    (function(btn) {
      if (!btn || btn.offsetParent === null) return false;
      var r = btn.getBoundingClientRect();
      var x = r.x + r.width/2, y = r.y + r.height/2;
      ['mousedown','mouseup','click'].forEach(function(t) {
        btn.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window, clientX:x, clientY:y }));
      });
      return true;
    })(${el})
  `;
}

async function _ensureWatchlistOpen() {
  const panelState = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return { error: 'Watchlist button not found' };
      var isActive = btn.getAttribute('aria-pressed') === 'true'
        || btn.classList.toString().indexOf('Active') !== -1
        || btn.classList.toString().indexOf('active') !== -1;
      if (!isActive) {
        var r = btn.getBoundingClientRect();
        var x = r.x + r.width/2, y = r.y + r.height/2;
        ['mousedown','mouseup','click'].forEach(function(t) {
          btn.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window, clientX:x, clientY:y }));
        });
        return { opened: true };
      }
      return { opened: false };
    })()
  `);
  if (panelState?.error) throw new Error(panelState.error);
  if (panelState?.opened) await new Promise(r => setTimeout(r, 500));
}

export async function add({ symbol }) {
  const c = await getClient();

  await _ensureWatchlistOpen();

  // Click "Add symbol" button with real mouse events
  const addClicked = await evaluate(`
    (function() {
      var selectors = [
        '[data-name="add-symbol-button"]',
        '[aria-label="Add symbol"]',
        '[aria-label*="Add symbol"]',
        'button[class*="addSymbol"]',
      ];
      for (var s = 0; s < selectors.length; s++) {
        var btn = document.querySelector(selectors[s]);
        if (btn && btn.offsetParent !== null) {
          var r = btn.getBoundingClientRect();
          var x = r.x + r.width/2, y = r.y + r.height/2;
          ['mousedown','mouseup','click'].forEach(function(t) {
            btn.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window, clientX:x, clientY:y }));
          });
          return { found: true, selector: selectors[s] };
        }
      }
      return { found: false };
    })()
  `);

  if (!addClicked?.found) throw new Error('Add symbol button not found in watchlist panel');
  await new Promise(r => setTimeout(r, 500));

  await c.Input.insertText({ text: symbol });
  await new Promise(r => setTimeout(r, 800));

  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await new Promise(r => setTimeout(r, 500));

  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });

  return { success: true, symbol, action: 'added' };
}

export async function addBulk({ symbols }) {
  const c = await getClient();

  await _ensureWatchlistOpen();

  // Open the Add symbol dialog once
  const addClicked = await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Add symbol"]')
        || document.querySelector('[data-name="add-symbol-button"]');
      if (!btn || btn.offsetParent === null) return { found: false };
      var r = btn.getBoundingClientRect();
      ['mousedown','mouseup','click'].forEach(function(t) {
        btn.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window, clientX:r.x+r.width/2, clientY:r.y+r.height/2 }));
      });
      return { found: true };
    })()
  `);

  if (!addClicked?.found) throw new Error('Add symbol button not found');
  await new Promise(r => setTimeout(r, 500));

  const results = [];
  for (const sym of symbols) {
    // Select all + replace with new symbol
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
    await new Promise(r => setTimeout(r, 100));

    await c.Input.insertText({ text: sym });
    await new Promise(r => setTimeout(r, 800));

    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
    await new Promise(r => setTimeout(r, 500));

    results.push({ symbol: sym, added: true });
  }

  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });

  return { success: true, count: results.length, symbols: results };
}

export async function remove({ symbols }) {
  const c = await getClient();

  // Get active watchlist metadata from React fiber
  const listInfo = await evaluate(`
    (function() {
      var panel = document.querySelector('[class*="layout__area--right"]');
      if (!panel) return null;
      var rows = panel.querySelectorAll('[data-symbol-full]');
      if (!rows.length) return null;
      var fiber = rows[0][Object.keys(rows[0]).find(function(k) { return k.indexOf('__reactFiber') === 0; })];
      var count = 0;
      while (fiber && count < 45) {
        if (fiber.memoizedProps && fiber.memoizedProps.current && fiber.memoizedProps.current.id) {
          var cur = fiber.memoizedProps.current;
          return { id: cur.id, name: cur.name, symbols: cur.symbols };
        }
        fiber = fiber.return;
        count++;
      }
      return null;
    })()
  `);

  if (!listInfo) throw new Error('Cannot read active watchlist — is the watchlist panel open?');

  // Normalise input to EXCHANGE:SYMBOL format using the live watchlist
  const toRemove = [];
  const skipped = [];
  for (const sym of symbols) {
    if (sym.includes(':')) {
      if (listInfo.symbols.includes(sym)) toRemove.push(sym);
      else skipped.push(sym);
    } else {
      const match = listInfo.symbols.find(s => s.split(':')[1] === sym.toUpperCase());
      if (match) toRemove.push(match);
      else skipped.push(sym);
    }
  }

  if (toRemove.length === 0) {
    return { success: true, removed: [], skipped, message: 'No matching symbols found in watchlist' };
  }

  // Strategy 1: REST API with CDP-extracted cookies (no UI, instant)
  try {
    await c.Network.enable();
    const { cookies } = await c.Network.getCookies({ urls: ['https://www.tradingview.com'] });
    const cookieHeader = cookies.map(ck => `${ck.name}=${ck.value}`).join('; ');

    const resp = await fetch(`https://www.tradingview.com/api/v1/symbols_list/custom/${listInfo.id}/remove/?source=web-tvd`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Language': 'en',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': 'https://www.tradingview.com',
        'Referer': 'https://www.tradingview.com/',
        'Cookie': cookieHeader,
      },
      body: JSON.stringify(toRemove),
    });

    if (resp.ok) {
      await evaluate(`window.dispatchEvent(new Event('resize'))`);
      return { success: true, removed: toRemove, skipped, api: 'rest', listId: listInfo.id, listName: listInfo.name };
    }
  } catch (err) {
    // fall through to UI method
  }

  // Strategy 2: UI-based delete (click row + Delete key)
  const results = [];
  for (const sym of toRemove) {
    const rowInfo = await evaluate(`
      (function() {
        var panel = document.querySelector('[class*="layout__area--right"]');
        if (!panel) return null;
        var rows = panel.querySelectorAll('[data-symbol-full]');
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].getAttribute('data-symbol-full') === ${safeString(sym)}) {
            var el = rows[i].closest('[class*="row"]') || rows[i];
            var r = el.getBoundingClientRect();
            return { x: r.x + r.width/2, y: r.y + r.height/2, found: true };
          }
        }
        return { found: false };
      })()
    `);

    if (!rowInfo?.found) { results.push({ symbol: sym, removed: false, reason: 'not_visible' }); continue; }

    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: rowInfo.x, y: rowInfo.y, button: 'left', clickCount: 1 });
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: rowInfo.x, y: rowInfo.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 200));
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Delete', code: 'Delete' });
    await new Promise(r => setTimeout(r, 300));
    results.push({ symbol: sym, removed: true });
  }

  return {
    success: true,
    removed: results.filter(r => r.removed).map(r => r.symbol),
    skipped,
    results,
    api: 'ui',
  };
}
