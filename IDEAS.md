# Ideas & Backlog

Improvements to track but not yet implemented.

## Upstream Tracking (GitHub Action)
Daily action that checks `tradesdontlie/tradingview-mcp` for new PRs/commits and opens an issue
in this fork with a summary. No auto-merge — manual cherry-pick decision stays with the owner.
File: `.github/workflows/upstream-tracker.yml`

## Potential Fixes / Enhancements
- `pine_smart_compile`: expose elapsed_ms in return value so callers know how long compilation took
- `data_get_strategy_results_dom`: improve regex patterns as TradingView UI text changes
- `tab_list`: include which Pine script is active in each tab's editor (requires pine-facade introspection)
- `tab_switch_by_name`: switch directly by Pine script name instead of index

## Sub-Agent Personas (Strategy Development)
- **Architect**: writes Pine Script strategy from spec
- **Backtester**: runs parameter sweeps, reads strategy tester results
- **Reviewer**: static analysis + pine_check before compile
- **Reporter**: formats backtest results into structured summary
