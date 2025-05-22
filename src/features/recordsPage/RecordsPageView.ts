// src/features/recordsPage/RecordsPageView.ts
import { h } from 'snabbdom';
import type { VNode } from 'snabbdom';
import type { RecordsPageController, RecordsPageControllerState, ProcessedLeaderboardEntry, LeaderboardTableConfig } from './RecordsPageController';
import { t } from '../../core/i18n.service';
import logger from '../../utils/logger';

function renderSingleLeaderboardTable(
  tableData: { config: LeaderboardTableConfig; entries: ProcessedLeaderboardEntry[] }
): VNode {
  const { config, entries } = tableData;

  if (!entries || entries.length === 0) {
    return h('div.leaderboard-table-container', [
      h('h3.table-title', t(config.titleKey, { defaultValue: config.defaultTitle })),
      h('p.no-data-message', t('records.table.noEntries', { defaultValue: 'No entries for this leaderboard yet.' }))
    ]);
  }

  return h('div.leaderboard-table-container', { key: config.id }, [
    h('h3.table-title', t(config.titleKey, { defaultValue: config.defaultTitle })),
    h('table.styled-table.records-table', [
      h('thead', [
        h('tr', config.columns.map(col =>
          h('th', { style: { textAlign: col.textAlign || 'left' } }, t(col.headerKey, { defaultValue: col.defaultHeader }))
        ))
      ]),
      h('tbody', entries.map((entry) =>
        h('tr', { key: `${config.id}-${entry.lichess_id}-${entry.rank}` }, config.columns.map(col => {
          const cellValue = col.cellValueExtractor(entry);
          if (col.headerKey === 'records.table.player' || col.defaultHeader.toLowerCase() === 'player') {
            return h('td', { style: { textAlign: col.textAlign || 'left' } }, [
              h('a', {
                props: {
                  href: `https://lichess.org/@/${entry.lichess_id}`,
                  target: '_blank',
                  rel: 'noopener noreferrer'
                }
              }, String(cellValue))
            ]);
          }
          return h('td', { style: { textAlign: col.textAlign || 'left' } }, String(cellValue));
        }))
      ))
    ])
  ]);
}

export function renderRecordsPage(controller: RecordsPageController): VNode {
  const state: RecordsPageControllerState = controller.state;
  logger.debug('[RecordsPageView] Rendering Records Page with state:', state);

  const pageTitle = h('h1.records-page-main-title', state.pageTitle);

  if (state.isLoading) {
    return h('div.records-page-container.loading', [
      pageTitle,
      h('p', t('common.loading', { defaultValue: 'Loading data...' }))
    ]);
  }

  if (state.error) {
    return h('div.records-page-container.error', [
      pageTitle,
      h('p.error-message', `${t('common.error', { defaultValue: 'Error' })}: ${state.error}`)
    ]);
  }

  if (!state.leaderboardTables || state.leaderboardTables.length === 0) {
    return h('div.records-page-container.no-data', [
      pageTitle,
      h('p', t('records.errors.noLeaderboards', { defaultValue: 'No leaderboards available at the moment.' }))
    ]);
  }

  return h('div.records-page-container', [
    pageTitle,
    h('div.leaderboards-grid', state.leaderboardTables.map(tableData =>
      renderSingleLeaderboardTable(tableData)
    ))
  ]);
}
