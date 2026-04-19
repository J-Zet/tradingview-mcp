# Merged Upstream PRs

PRs from tradesdontlie/tradingview-mcp that have been reviewed and applied to this fork.
The upstream-tracker workflow skips these when reporting new items.

| PR | Title | Applied | Notes |
|----|-------|---------|-------|
| #49 | fix(drawing): restore DI in drawing management functions | 2026-04-18 | Fixed via local commit, same root cause |
| #62 | fix(drawing): restore DI in listDrawings, getProperties, removeOne, clearAll | 2026-04-18 | Fixed via local commit 083edd4 |
| #72 | Fix symbolInfo() throwing 'evaluate is not defined' | 2026-04-19 | Also fixed getVisibleRange + scrollToDate, same regression, commit 78f60c6 |
| #51 | feat: improve strategy detection and add DOM metrics fallback | 2026-04-19 | Ported manually (cherry-pick conflict); 3-phase detection logic, commit fe62f03 |
