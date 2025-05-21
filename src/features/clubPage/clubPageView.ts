// src/features/clubPage/clubPageView.ts
import { h } from 'snabbdom';
import type { VNode } from 'snabbdom';
import type { ClubPageController, ClubPageControllerState } from './ClubPageController';
import type { ClubData, ClubBattle, ClubPlayer, ClubLeader } from '../../core/webhook.service';
import { t } from '../../core/i18n.service';
import logger from '../../utils/logger';

const DEFAULT_TOP_MAX = 10; // Значение по умолчанию, если topMax не придет от бэкенда

// --- Helper Functions for Data Processing ---

interface AggregatedPlayerData {
  id: string;
  name: string;
  title?: string;
  totalScore: number;
  tournamentsPlayed: number;
  maxScoreInOneTournament: number;
  maxScoreTournamentName?: string;
  maxScoreTournamentArenaUrl?: string;
}

function aggregatePlayerData(clubData: ClubData | null): AggregatedPlayerData[] {
  if (!clubData) return [];

  const playerDataMap = new Map<string, AggregatedPlayerData>();

  clubData.jsonb_array_battle.forEach(battle => {
    battle.players.forEach(player => {
      const userId = player.user.id;
      if (!playerDataMap.has(userId)) {
        playerDataMap.set(userId, {
          id: userId,
          name: player.user.name,
          title: player.user.title,
          totalScore: 0,
          tournamentsPlayed: 0,
          maxScoreInOneTournament: 0,
          maxScoreTournamentName: undefined,
          maxScoreTournamentArenaUrl: undefined,
        });
      }
      const currentPlayerData = playerDataMap.get(userId)!;
      currentPlayerData.totalScore += player.score;
      currentPlayerData.tournamentsPlayed += 1;
      if (player.score > currentPlayerData.maxScoreInOneTournament) {
        currentPlayerData.maxScoreInOneTournament = player.score;
        currentPlayerData.maxScoreTournamentName = battle.fullName;
        currentPlayerData.maxScoreTournamentArenaUrl = battle.arena_url;
      }
    });
  });
  return Array.from(playerDataMap.values());
}

// --- Helper Functions for Rendering Tables ---

function renderLeaderTable(leaders: ClubLeader[]): VNode {
  if (!leaders || leaders.length === 0) {
    return h('p', t('clubPage.noLeaders', { defaultValue: 'No leaders listed.' }));
  }
  return h('div.club-leaders-section', [
    h('h3.table-title', t('clubPage.leadersTitle', { defaultValue: 'Club Leaders' })),
    h('ul.leaders-list', leaders.map(leader =>
      h('li', `${leader.title ? leader.title + ' ' : ''}${leader.name}`)
    ))
  ]);
}

function renderMostValuablePlayersTable(aggregatedPlayers: AggregatedPlayerData[], topMax: number): VNode {
  const sortedPlayers = [...aggregatedPlayers].sort((a, b) => b.totalScore - a.totalScore).slice(0, topMax);

  return h('div.player-stats-table-container', [
    h('h3.table-title', t('clubPage.mostValuablePlayersTitle', { defaultValue: 'Most Valuable Players (Total Score)' })),
    h('table.styled-table.player-mvp-table', [
      h('thead', [
        h('tr', [
          h('th.text-center', t('clubPage.table.rank', { defaultValue: '#' })),
          h('th.text-left', t('clubPage.table.player', { defaultValue: 'Player' })),
          h('th.text-right', t('clubPage.table.totalScore', { defaultValue: 'Total Score' })),
        ]),
      ]),
      h('tbody', sortedPlayers.map((player, index) =>
        h('tr', [
          h('td.text-center', (index + 1).toString()),
          h('td.text-left', `${player.title ? player.title + ' ' : ''}${player.name}`),
          h('td.text-right', player.totalScore.toString()),
        ])
      )),
    ]),
  ]);
}

function renderMostActivePlayersTable(aggregatedPlayers: AggregatedPlayerData[], topMax: number): VNode {
  const sortedPlayers = [...aggregatedPlayers].sort((a, b) => b.tournamentsPlayed - a.tournamentsPlayed).slice(0, topMax);

  return h('div.player-stats-table-container', [
    h('h3.table-title', t('clubPage.mostActivePlayersTitle', { defaultValue: 'Most Active Players (Tournaments Played)' })),
    h('table.styled-table.player-active-table', [
      h('thead', [
        h('tr', [
          h('th.text-center', t('clubPage.table.rank', { defaultValue: '#' })),
          h('th.text-left', t('clubPage.table.player', { defaultValue: 'Player' })),
          h('th.text-right', t('clubPage.table.tournaments', { defaultValue: 'Tournaments' })),
        ]),
      ]),
      h('tbody', sortedPlayers.map((player, index) =>
        h('tr', [
          h('td.text-center', (index + 1).toString()),
          h('td.text-left', `${player.title ? player.title + ' ' : ''}${player.name}`),
          h('td.text-right', player.tournamentsPlayed.toString()),
        ])
      )),
    ]),
  ]);
}

function renderTopPerformancesInTournamentTable(aggregatedPlayers: AggregatedPlayerData[], topMax: number): VNode {
    const sortedPlayers = [...aggregatedPlayers]
        .filter(p => p.maxScoreInOneTournament > 0) 
        .sort((a, b) => b.maxScoreInOneTournament - a.maxScoreInOneTournament)
        .slice(0, topMax);

    return h('div.player-stats-table-container', [
        h('h3.table-title', t('clubPage.topSinglePerformanceTitle', { defaultValue: 'Top Single Tournament Performances' })),
        h('table.styled-table.player-top-perf-table', [
            h('thead', [
                h('tr', [
                    h('th.text-center', t('clubPage.table.rank', { defaultValue: '#' })),
                    h('th.text-left', t('clubPage.table.player', { defaultValue: 'Player' })),
                    h('th.text-right', t('clubPage.table.score', { defaultValue: 'Score' })),
                    h('th.text-left', t('clubPage.table.tournamentName', { defaultValue: 'Tournament' })),
                ]),
            ]),
            h('tbody', sortedPlayers.map((player, index) =>
                h('tr', [
                    h('td.text-center', (index + 1).toString()),
                    h('td.text-left', `${player.title ? player.title + ' ' : ''}${player.name}`),
                    h('td.text-right', player.maxScoreInOneTournament.toString()),
                    h('td.text-left', 
                      player.maxScoreTournamentName ? 
                        (player.maxScoreTournamentArenaUrl ? 
                          h('a', { props: { href: player.maxScoreTournamentArenaUrl, target: '_blank', rel: 'noopener noreferrer' } }, player.maxScoreTournamentName) : 
                          player.maxScoreTournamentName
                        ) : '-'
                    ),
                ])
            )),
        ]),
    ]);
}


function renderTournamentHistoryTable(
    battles: ClubBattle[],
    expandedBattleId: string | null,
    onToggleBattle: (arenaId: string) => void 
): VNode {
  // Сортировка: сначала по club_rank (возрастание), затем по club_score (убывание)
  const sortedBattles = [...battles].sort((a, b) => {
    if (a.club_rank !== b.club_rank) {
      return a.club_rank - b.club_rank; // Меньший ранг лучше
    }
    return b.club_score - a.club_score; // Больший счет лучше
  }); 

  return h('div.tournament-history-table-container', [
    h('h3.table-title', t('clubPage.tournamentHistoryTitle', { defaultValue: 'Tournament History' })),
    h('table.styled-table.tournament-table', [
      h('thead', [
        h('tr', [
          h('th.text-left', t('clubPage.table.date', { defaultValue: 'Date' })),
          h('th.text-left', t('clubPage.table.tournamentName', { defaultValue: 'Tournament' })),
          h('th.text-center', t('clubPage.table.timeControl', { defaultValue: 'TC' })),
          h('th.text-right', t('clubPage.table.duration', { defaultValue: 'Duration' })),
          h('th.text-right', t('clubPage.table.clubRank', { defaultValue: 'Rank' })),
          h('th.text-right', t('clubPage.table.clubScore', { defaultValue: 'Score' })),
        ]),
      ]),
      h('tbody', sortedBattles.map(battle =>
        [ 
          h('tr.tournament-row', {
            key: battle.arena_id,
            class: { 'expandable': true, 'expanded': expandedBattleId === battle.arena_id },
            on: { click: () => onToggleBattle(battle.arena_id) } 
          }, [
            h('td.text-left', battle.startsAt_Date),
            h('td.text-left', h('a', { props: { href: battle.arena_url, target: '_blank', rel: 'noopener noreferrer' } }, battle.fullName)),
            h('td.text-center', `${battle.clock_control.limit / 60} + ${battle.clock_control.increment}`),
            h('td.text-right', `${battle.duration} min`),
            h('td.text-right', battle.club_rank.toString()),
            h('td.text-right', battle.club_score.toString()),
          ]),
          expandedBattleId === battle.arena_id ?
            h('tr.tournament-players-details', { key: `details-${battle.arena_id}` }, [
              h('td', { props: { colSpan: 6 } }, [ 
                renderTournamentPlayersList(battle.players)
              ])
            ]) : null
        ]
      ).flat().filter(Boolean) as VNode[]), 
    ]),
  ]);
}

function renderTournamentPlayersList(players: ClubPlayer[]): VNode {
  if (!players || players.length === 0) {
    return h('p.no-players-message', t('clubPage.noPlayersInTournament', { defaultValue: 'No players participated or data unavailable.' }));
  }
  const sortedPlayers = [...players].sort((a,b) => b.score - a.score);

  return h('div.tournament-players-list', [
    h('h4.players-list-title', t('clubPage.tournamentPlayersTitle', { defaultValue: 'Players in this Tournament' })),
    h('table.styled-table.mini-player-table', [
        h('thead', [
            h('tr', [
                h('th.text-center', t('clubPage.table.rank', { defaultValue: '#' })),
                h('th.text-left', t('clubPage.table.player', { defaultValue: 'Player' })),
                h('th.text-right', t('clubPage.table.score', { defaultValue: 'Score' })),
            ]),
        ]),
        h('tbody', sortedPlayers.map((player, index) =>
            h('tr', [
                h('td.text-center', (index + 1).toString()),
                h('td.text-left', [
                    player.user.title ? h('span.player-title', player.user.title + ' ') : '',
                    h('a.player-name', {
                        props: { href: `https://lichess.org/@/${player.user.id}`, target: '_blank', rel: 'noopener noreferrer' }
                    }, player.user.name),
                ]),
                h('td.text-right', player.score.toString()),
            ])
        ))
    ])
  ]);
}


// --- Main Rendering Function ---
export function renderClubPage(controller: ClubPageController): VNode {
  const state: ClubPageControllerState = controller.state;
  logger.debug('[ClubPageView] Rendering Club Page with state:', state);

  if (state.isLoading) {
    return h('div.club-page.loading', [
      h('h1', state.pageTitle),
      h('p', t('common.loading', { defaultValue: 'Loading data...' }))
    ]);
  }

  if (state.error) {
    return h('div.club-page.error', [
      h('h1', state.pageTitle),
      h('p.error-message', `${t('common.error', { defaultValue: 'Error' })}: ${state.error}`)
    ]);
  }

  if (!state.clubData) {
    return h('div.club-page.no-data', [
      h('h1', state.pageTitle), 
      h('p', t('clubPage.error.noDataFound', { clubId: state.clubId, defaultValue: `No data found for club ID: ${state.clubId}` }))
    ]);
  }

  const clubData = state.clubData;
  const aggregatedPlayers = aggregatePlayerData(clubData);
  const topMaxToDisplay = clubData.topMax !== undefined && clubData.topMax > 0 ? clubData.topMax : DEFAULT_TOP_MAX;


  const expandedBattleId = state.expandedBattleId; 
  const toggleBattleDetails = (arenaId: string) => {
    controller.toggleTournamentDetails(arenaId);
  };


  return h('div.club-page-container', { key: `club-page-${clubData.club_id}` }, [
    h('header.club-header', [
      clubData.club_bild ? h('img.club-banner', { props: { src: clubData.club_bild, alt: t('clubPage.clubBannerAlt', { clubName: clubData.club_name }) } }) : null,
      h('div.club-info', [
        h('a.club-name-link', { props: { href: `https://lichess.org/team/${clubData.club_id}`, target: '_blank', rel: 'noopener noreferrer' } }, [
            h('h1.club-name', clubData.club_name)
        ]),
        h('p.club-meta', `${t('clubPage.founder', { defaultValue: 'Founder' })}: ${clubData.grunder} | ${t('clubPage.members', { defaultValue: 'Members' })}: ${clubData.nb_members}`),
      ]),
    ]),
    renderLeaderTable(clubData.jsonb_array_leader),
    h('div.club-stats-grid', [ 
        renderMostValuablePlayersTable(aggregatedPlayers, topMaxToDisplay),
        renderMostActivePlayersTable(aggregatedPlayers, topMaxToDisplay),
    ]),
    renderTopPerformancesInTournamentTable(aggregatedPlayers, topMaxToDisplay), 
    renderTournamentHistoryTable(clubData.jsonb_array_battle, expandedBattleId, toggleBattleDetails),
  ]);
}
