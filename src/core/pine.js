/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

// ── Monaco finder (injected into TV page) ──
const FIND_MONACO = `
  (function findMonacoEditor() {
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!container) return null;
    var el = container;
    var fiberKey;
    for (var i = 0; i < 20; i++) {
      if (!el) break;
      fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') {
          var editors = env.editor.getEditors();
          if (editors.length > 0) return { editor: editors[0], env: env };
        }
      }
      current = current.return;
    }
    return null;
  })()
`;

/**
 * Opens the Pine Editor panel and waits for Monaco to become available.
 * Returns true if editor is accessible, false on timeout.
 */
export async function ensurePineEditorOpen() {
  const already = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      return m !== null;
    })()
  `);
  if (already) return true;

  await evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return;
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
    })()
  `);

  await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Pine"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (btn) btn.click();
    })()
  `);

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    const ready = await evaluate(`(function() { return ${FIND_MONACO} !== null; })()`);
    if (ready) return true;
  }
  return false;
}

// ── Pure / offline functions ──

export function analyze({ source }) {
  const lines = source.split('\n');
  const diagnostics = [];

  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array (declared with size 0)`,
          severity: 'warning',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'strategy.entry/close used but no strategy() declaration found — did you mean to use indicator()?',
          severity: 'error',
        });
        break;
      }
    }
  }

  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 5) {
      diagnostics.push({
        line: 1, column: 1,
        message: `Script uses Pine v${vMatch[1]} — consider upgrading to v6 for latest features`,
        severity: 'info',
      });
    }
  }

  return {
    success: true,
    issue_count: diagnostics.length,
    diagnostics,
    note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
  };
}

export async function check({ source }) {
  const formData = new URLSearchParams();
  formData.append('source', source);

  const response = await fetch(
    'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tradingview.com/',
      },
      body: formData,
    }
  );

  if (!response.ok) {
    throw new Error(`TradingView API returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  const errors = [];
  const warnings = [];
  const inner = result?.result;

  if (inner) {
    if (inner.errors2 && inner.errors2.length > 0) {
      for (const e of inner.errors2) {
        errors.push({
          line: e.start?.line, column: e.start?.column,
          end_line: e.end?.line, end_column: e.end?.column,
          message: e.message,
        });
      }
    }
    if (inner.warnings2 && inner.warnings2.length > 0) {
      for (const w of inner.warnings2) {
        warnings.push({ line: w.start?.line, column: w.start?.column, message: w.message });
      }
    }
  }

  if (result.error && typeof result.error === 'string') {
    errors.push({ message: result.error });
  }

  const compiled = errors.length === 0;
  return {
    success: true,
    compiled,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    note: compiled ? 'Pine Script compiled successfully.' : undefined,
  };
}

// ── Functions requiring TradingView connection ──

export async function getSource() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor or Monaco not found in React fiber tree.');

  const source = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return null;
      return m.editor.getValue();
    })()
  `);

  if (source === null || source === undefined) {
    throw new Error('Monaco editor found but getValue() returned null.');
  }

  return { success: true, source, line_count: source.split('\n').length, char_count: source.length };
}

export async function setSource({ source }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const escaped = JSON.stringify(source);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new Error('Monaco found but setValue() failed.');
  return { success: true, lines_set: source.split('\n').length };
}

export async function compile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const clicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var fallback = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!fallback && /^(Add to chart|Update on chart)/i.test(text)) {
          fallback = btns[i];
        }
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) {
          saveBtn = btns[i];
        }
      }
      if (fallback) { fallback.click(); return fallback.textContent.trim(); }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!clicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2000));
  return { success: true, button_clicked: clicked || 'keyboard_shortcut', source: 'dom_fallback' };
}

export async function getErrors() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  return {
    success: true,
    has_errors: errors?.length > 0,
    error_count: errors?.length || 0,
    errors: errors || [],
  };
}

export async function save() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const c = await getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
  await new Promise(r => setTimeout(r, 800));

  // Handle "Save Script" name dialog that appears for new/unsaved scripts
  const dialogHandled = await evaluate(`
    (function() {
      var saveBtn = null;
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (text === 'Save' && btns[i].offsetParent !== null) {
          // Check if it's in a dialog (not the Pine Editor save button)
          var parent = btns[i].closest('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"]');
          if (parent) { saveBtn = btns[i]; break; }
        }
      }
      if (saveBtn) { saveBtn.click(); return true; }
      return false;
    })()
  `);

  if (dialogHandled) await new Promise(r => setTimeout(r, 500));

  return { success: true, action: dialogHandled ? 'saved_with_dialog' : 'Ctrl+S_dispatched' };
}

export async function getConsole() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const entries = await evaluate(`
    (function() {
      var results = [];
      var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
      if (rows.length === 0) {
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]')
          || document.querySelector('[class*="bottom-widgetbar-content"]');
        if (bottomArea) {
          rows = bottomArea.querySelectorAll('[class*="message"], [class*="log"], [class*="console"]');
        }
      }
      if (rows.length === 0) {
        var pinePanel = document.querySelector('.pine-editor-container')
          || document.querySelector('[class*="pine-editor"]')
          || document.querySelector('[class*="layout__area--bottom"]');
        if (pinePanel) {
          var allSpans = pinePanel.querySelectorAll('span, div');
          for (var s = 0; s < allSpans.length; s++) {
            var txt = allSpans[s].textContent.trim();
            if (/^\\d{2}:\\d{2}:\\d{2}/.test(txt) || /error|warning|info/i.test(allSpans[s].className)) {
              rows = Array.from(rows || []);
              rows.push(allSpans[s]);
            }
          }
        }
      }
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent.trim();
        if (!text) continue;
        var ts = null;
        var tsMatch = text.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}/);
        if (tsMatch) ts = tsMatch[0];
        var type = 'info';
        var cls = rows[i].className || '';
        if (/error/i.test(cls) || /error/i.test(text.substring(0, 30))) type = 'error';
        else if (/compil/i.test(text.substring(0, 40))) type = 'compile';
        else if (/warn/i.test(cls)) type = 'warning';
        results.push({ timestamp: ts, type: type, message: text });
      }
      return results;
    })()
  `);

  return { success: true, entries: entries || [], entry_count: entries?.length || 0 };
}

export async function smartCompile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const buttonClicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var addBtn = null;
      var updateBtn = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!addBtn && /^add to chart$/i.test(text)) addBtn = btns[i];
        if (!updateBtn && /^update on chart$/i.test(text)) updateBtn = btns[i];
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) saveBtn = btns[i];
      }
      if (addBtn) { addBtn.click(); return 'Add to chart'; }
      if (updateBtn) { updateBtn.click(); return 'Update on chart'; }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!buttonClicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  // Wait for compilation to finish: poll Monaco markers + study count stability
  // instead of a fixed delay. Polls every 300ms, up to 10s total.
  let errors = [];
  let studiesAfterPoll = null;
  const POLL_INTERVAL = 300;
  const MAX_WAIT = 10000;
  const started = Date.now();
  let stableCount = 0;
  let prevMarkerHash = null;

  while (Date.now() - started < MAX_WAIT) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    const snapshot = await evaluate(`
      (function() {
        var m = ${FIND_MONACO};
        if (!m) return null;
        var model = m.editor.getModel();
        if (!model) return null;
        var markers = m.env.editor.getModelMarkers({ resource: model.uri });
        var errs = markers.map(function(mk) {
          return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
        });
        var studyCount = null;
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          if (chart && typeof chart.getAllStudies === 'function') studyCount = chart.getAllStudies().length;
        } catch(e) {}
        return { errors: errs, studyCount: studyCount };
      })()
    `);

    if (!snapshot) continue;

    const hash = JSON.stringify(snapshot.errors) + ':' + snapshot.studyCount;
    studiesAfterPoll = snapshot.studyCount;

    if (hash === prevMarkerHash) {
      stableCount++;
      if (stableCount >= 2) { errors = snapshot.errors; break; }
    } else {
      stableCount = 0;
      prevMarkerHash = hash;
    }
    errors = snapshot.errors;
  }

  const studyAdded = (studiesBefore !== null && studiesAfterPoll !== null) ? studiesAfterPoll > studiesBefore : null;

  return {
    success: true,
    button_clicked: buttonClicked || 'keyboard_shortcut',
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
  };
}

// Click an item in the pine-script-title dropdown by its aria-label.
// Uses evaluateAsync + polling so React has time to render menu items after btn.click().
async function _pineMenuAction(label, subLabel) {
  const result = await evaluateAsync(`
    (function() {
      function mc(el) {
        ['mousedown','mouseup','click'].forEach(function(t) {
          el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
        });
      }
      function poll(fn, interval, timeout) {
        return new Promise(function(resolve, reject) {
          var elapsed = 0;
          var t = setInterval(function() {
            var r = fn();
            if (r !== null) { clearInterval(t); resolve(r); return; }
            elapsed += interval;
            if (elapsed >= timeout) { clearInterval(t); reject(new Error('poll timeout')); }
          }, interval);
        });
      }

      var btn = document.querySelector('[data-qa-id="pine-script-title-button"]');
      if (!btn) return Promise.resolve({ error: 'title button not found' });
      btn.click();

      var menuId = btn.getAttribute('aria-controls');
      return poll(function() {
        var menu = menuId && document.getElementById(menuId);
        if (!menu || menu.querySelectorAll('[role="menuitem"]').length === 0) return null;
        return menu;
      }, 50, 2000).then(function(menu) {
        var items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
        var label = ${JSON.stringify(label)};
        var target = items.find(function(el) {
          return el.getAttribute('aria-label') === label ||
                 (label === 'Create new' && el.getAttribute('aria-haspopup') === 'menu' && !el.getAttribute('aria-label'));
        });
        if (!target) return { error: 'menu item not found: ' + label, available: items.map(function(el) { return el.getAttribute('aria-label'); }) };

        if (!${JSON.stringify(subLabel || null)}) {
          mc(target);
          return { ok: true };
        }

        // Has submenu: hover to open it, then poll for sub-items
        target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        var subId = target.getAttribute('aria-controls');

        return poll(function() {
          var submenu = subId && document.getElementById(subId);
          if (!submenu || submenu.querySelectorAll('[role="menuitem"]').length === 0) return null;
          return submenu;
        }, 50, 1000).then(function(submenu) {
          var sub = ${JSON.stringify((subLabel || '').toLowerCase())};
          var subTarget = Array.from(submenu.querySelectorAll('[role="menuitem"]')).find(function(el) {
            return (el.getAttribute('aria-label') || '').toLowerCase() === sub;
          });
          if (!subTarget) return { error: 'submenu item not found: ' + sub };
          mc(subTarget);
          return { ok: true };
        });
      }).catch(function(e) { return { error: e.message }; });
    })()
  `);
  if (result?.error) throw new Error(result.error);
}

export async function newScript({ type }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const validTypes = { indicator: 'Indicator', strategy: 'Strategy', library: 'Library' };
  const subLabel = validTypes[type] || 'Indicator';

  await _pineMenuAction('Create new', subLabel);
  await new Promise(r => setTimeout(r, 800));

  return { success: true, type: type || 'indicator', action: 'new_script_created' };
}

// Get the currently open script's ID and source from pine-facade.
// Returns { id, source } or throws.
async function _currentScriptInfo() {
  const result = await evaluateAsync(`
    (function() {
      var titleBtn = document.querySelector('[data-qa-id="pine-script-title-button"]');
      var currentName = titleBtn ? (titleBtn.querySelector('h2') || titleBtn).textContent.trim() : null;
      return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(scripts) {
          if (!Array.isArray(scripts)) return { error: 'unexpected pine-facade response' };
          var match = null;
          var nameLower = (currentName || '').toLowerCase();
          for (var i = 0; i < scripts.length; i++) {
            var sn = (scripts[i].scriptName || '').toLowerCase();
            var st = (scripts[i].scriptTitle || '').toLowerCase();
            if (sn === nameLower || st === nameLower) { match = scripts[i]; break; }
          }
          if (!match) {
            // fuzzy: current editor name may be truncated
            for (var j = 0; j < scripts.length; j++) {
              var sn2 = (scripts[j].scriptName || '').toLowerCase();
              if (sn2.indexOf(nameLower) !== -1 || nameLower.indexOf(sn2) !== -1) { match = scripts[j]; break; }
            }
          }
          if (!match) return { error: 'Could not find current script in pine-facade. Name: ' + currentName };
          return { id: match.scriptIdPart, name: match.scriptName || match.scriptTitle, version: match.version };
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return result;
}

export async function saveAs({ name }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  // Get current source from Monaco
  const source = await evaluate(`
    (function() { var m = ${FIND_MONACO}; return m ? m.editor.getValue() : null; })()
  `);
  if (!source) throw new Error('Could not read source from Monaco editor.');

  const copyName = name || 'Copy';
  const result = await evaluateAsync(`
    (function() {
      var fd = new FormData();
      fd.append('source', ${JSON.stringify(source)});
      return fetch('https://pine-facade.tradingview.com/pine-facade/save/new?name=' + encodeURIComponent(${JSON.stringify(copyName)}) + '&allow_overwrite=true', {
        method: 'POST', credentials: 'include', body: fd,
      })
        .then(function(r) { return r.json().then(function(d) { return { status: r.status, data: d }; }); })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);
  if (result?.error) throw new Error(result.error);
  if (result?.status >= 400) throw new Error('pine-facade save/new failed: ' + JSON.stringify(result.data));

  const d = result?.data || {};
  return { success: true, action: 'save_as', name: copyName, script_id: d.scriptIdPart || d.id || d.script_id || null };
}

export async function renameScript({ name }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const { id, name: oldName } = await _currentScriptInfo();
  const encoded = encodeURIComponent(id);

  const result = await evaluateAsync(`
    (function() {
      return fetch('https://pine-facade.tradingview.com/pine-facade/rename/' + ${JSON.stringify(encoded)} + '?name=' + encodeURIComponent(${JSON.stringify(name)}) + '&force=true', {
        method: 'POST', credentials: 'include',
      })
        .then(function(r) { return { status: r.status, ok: r.ok }; })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);
  if (result?.error) throw new Error(result.error);
  if (!result?.ok) throw new Error('pine-facade rename failed with status ' + result?.status);

  return { success: true, action: 'renamed', old_name: oldName, name, script_id: id };
}

export async function versionHistory() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  await _pineMenuAction('Version history…');
  await new Promise(r => setTimeout(r, 500));

  return { success: true, action: 'version_history_opened' };
}

export async function openScript({ name }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const escapedName = JSON.stringify(name.toLowerCase());

  const result = await evaluateAsync(`
    (function() {
      var target = ${escapedName};
      return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(scripts) {
          if (!Array.isArray(scripts)) return {error: 'pine-facade returned unexpected data'};
          var match = null;
          for (var i = 0; i < scripts.length; i++) {
            var sn = (scripts[i].scriptName || '').toLowerCase();
            var st = (scripts[i].scriptTitle || '').toLowerCase();
            if (sn === target || st === target) { match = scripts[i]; break; }
          }
          if (!match) {
            for (var j = 0; j < scripts.length; j++) {
              var sn2 = (scripts[j].scriptName || '').toLowerCase();
              var st2 = (scripts[j].scriptTitle || '').toLowerCase();
              if (sn2.indexOf(target) !== -1 || st2.indexOf(target) !== -1) { match = scripts[j]; break; }
            }
          }
          if (!match) return {error: 'Script "' + target + '" not found. Use pine_list_scripts to see available scripts.'};

          var id = match.scriptIdPart;
          var ver = match.version || 1;
          return fetch('https://pine-facade.tradingview.com/pine-facade/get/' + id + '/' + ver, { credentials: 'include' })
            .then(function(r2) { return r2.json(); })
            .then(function(data) {
              var source = data.source || '';
              if (!source) return {error: 'Script source is empty', name: match.scriptName || match.scriptTitle};
              var m = ${FIND_MONACO};
              if (m) {
                m.editor.setValue(source);
                return {success: true, name: match.scriptName || match.scriptTitle, id: id, lines: source.split('\\n').length};
              }
              return {error: 'Monaco editor not found to inject source', name: match.scriptName || match.scriptTitle};
            });
        })
        .catch(function(e) { return {error: e.message}; });
    })()
  `);

  if (result?.error) {
    throw new Error(result.error);
  }

  return { success: true, name: result.name, script_id: result.id, lines: result.lines, source: 'internal_api', opened: true };
}

export async function deleteScript({ name }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  // Open the "Open script…" dialog
  await _pineMenuAction('Open script…');
  await new Promise(r => setTimeout(r, 500));

  // Inject CSS so remove buttons are always visible (they're hover-only by default)
  await evaluate(`
    (function() {
      if (document.getElementById('__pine_remove_css')) return;
      var s = document.createElement('style');
      s.id = '__pine_remove_css';
      s.textContent = '.removeButton-gisYB8vu { opacity: 1 !important; visibility: visible !important; pointer-events: all !important; }';
      document.head.appendChild(s);
    })()
  `);

  // Find the row matching the name and click its remove button
  const result = await evaluate(`
    (function() {
      function mc(el) {
        ['mousedown','mouseup','click'].forEach(function(t) {
          el.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window }));
        });
      }
      var dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return { error: 'Open script dialog not found' };

      var target = ${JSON.stringify(name.toLowerCase())};
      var rows = Array.from(dialog.querySelectorAll('[class*="itemRow"]'));
      var matchedRow = null;
      for (var i = 0; i < rows.length; i++) {
        var txt = rows[i].textContent.toLowerCase();
        if (txt.indexOf(target) !== -1) { matchedRow = rows[i]; break; }
      }
      if (!matchedRow) return { error: 'Script not found in list: ' + ${JSON.stringify(name)}, available: rows.map(function(r) { return r.textContent.trim().slice(0,40); }) };

      var removeBtn = matchedRow.querySelector('.removeButton-gisYB8vu, [aria-label="Remove"]');
      if (!removeBtn) return { error: 'Remove button not found on row' };

      mc(removeBtn);
      return { clicked: true, scriptName: matchedRow.textContent.trim().slice(0,60) };
    })()
  `);

  if (result?.error) {
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    throw new Error(result.error);
  }

  await new Promise(r => setTimeout(r, 400));

  // Handle possible confirmation dialog
  const confirmed = await evaluate(`
    (function() {
      function mc(el) {
        ['mousedown','mouseup','click'].forEach(function(t) {
          el.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window }));
        });
      }
      var btns = Array.from(document.querySelectorAll('button'));
      var confirmBtn = btns.find(function(b) {
        var t = b.textContent.trim();
        var p = b.closest('[role="dialog"], [class*="dialog"], [class*="modal"]');
        return p && (t === 'Delete' || t === 'Remove' || t === 'OK' || t === 'Yes') && b.offsetParent !== null;
      });
      if (confirmBtn) { mc(confirmBtn); return true; }
      return false;
    })()
  `);

  if (confirmed) await new Promise(r => setTimeout(r, 400));

  // Close dialog
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await new Promise(r => setTimeout(r, 300));

  // Clean up injected CSS
  await evaluate(`var s = document.getElementById('__pine_remove_css'); if (s) s.remove();`);

  return { success: true, action: 'deleted', name, confirmed };
}

export async function listScripts() {
  const scripts = await evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return {scripts: [], error: 'Unexpected response from pine-facade'};
        return {
          scripts: data.map(function(s) {
            return {
              id: s.scriptIdPart || null,
              name: s.scriptName || s.scriptTitle || 'Untitled',
              title: s.scriptTitle || null,
              version: s.version || null,
              modified: s.modified || null,
            };
          })
        };
      })
      .catch(function(e) { return {scripts: [], error: e.message}; })
  `);

  return {
    success: true,
    scripts: scripts?.scripts || [],
    count: scripts?.scripts?.length || 0,
    source: 'internal_api',
    error: scripts?.error,
  };
}
