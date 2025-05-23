// src/features/userCabinet/userCabinetView.ts
import { h } from 'snabbdom';
import type { VNode } from 'snabbdom';
import type { UserCabinetController, UserCabinetControllerState, UserCabinetData } from './UserCabinetController';
import type { FinishHimStats, FollowClubs, ClubIdNamePair } from '../../core/auth.service';
import { t } from '../../core/i18n.service';
import logger from '../../utils/logger';

// Вспомогательная функция для отображения одного элемента статистики
function renderStatItem(labelKey: string, defaultValue: string, value: string | number | undefined): VNode {
  return h('div.stat-item', [
    h('span.stat-label', t(labelKey, { defaultValue }) + ': '),
    h('span.stat-value', String(value !== undefined ? value : t('common.notAvailable', {defaultValue: 'N/A'}))),
  ]);
}

// Функция для отображения блока статистики FinishHimStats
function renderFinishHimStats(stats: FinishHimStats | undefined): VNode {
  if (!stats) {
    return h('p', t('userCabinet.stats.noStats', {defaultValue: 'Finish Him statistics are not available.'}));
  }
  return h('div.stats-section#finish-him-stats', [
    h('h3.section-title', t('userCabinet.stats.finishHimTitle', {defaultValue: 'Finish Him Statistics'})),
    renderStatItem('userCabinet.stats.gamesPlayed', 'Games Played', stats.gamesPlayed),
    renderStatItem('userCabinet.stats.tacticalRating', 'Tactical Rating', stats.tacticalRating),
    renderStatItem('userCabinet.stats.tacticalWins', 'Tactical Wins', stats.tacticalWins),
    renderStatItem('userCabinet.stats.tacticalLosses', 'Tactical Losses', stats.tacticalLosses),
    renderStatItem('userCabinet.stats.finishHimRating', 'Playout Rating', stats.finishHimRating),
    renderStatItem('userCabinet.stats.playoutWins', 'Playout Wins', stats.playoutWins),
    renderStatItem('userCabinet.stats.playoutDraws', 'Playout Draws', stats.playoutDraws),
    renderStatItem('userCabinet.stats.playoutLosses', 'Playout Losses', stats.playoutLosses),
    renderStatItem('userCabinet.stats.currentPieceCount', 'Current Level (Pieces)', stats.currentPieceCount),
  ]);
}

// Вспомогательная функция для отображения списка клубов
function renderClubList(
  titleKey: string,
  defaultTitle: string,
  clubRoleData: FollowClubs | undefined,
  controller: UserCabinetController // Добавляем контроллер для навигации
): VNode | null {
  if (!clubRoleData || !clubRoleData.clubs || clubRoleData.clubs.length === 0) {
    return h('div.club-list-section', [
        h('h4.club-list-title', t(titleKey, { defaultValue: defaultTitle })),
        h('p.no-clubs-message', t('userCabinet.clubs.noClubsInThisRole', {defaultValue: 'No clubs in this category.'}))
    ]);
  }

  return h('div.club-list-section', [
    h('h4.club-list-title', t(titleKey, { defaultValue: defaultTitle })),
    h('ul.club-list', clubRoleData.clubs.map((club: ClubIdNamePair) =>
      h('li.club-list-item', [
        h('a', {
          props: { href: `/#/clubs/${club.club_id}` }, // Используем club_id для href
          on: {
            click: (e: Event) => {
              e.preventDefault();
              // Используем AppController для навигации, чтобы сохранить SPA поведение
              controller.services.appController.navigateTo('clubPage', true, club.club_id);
            }
          }
        }, club.club_name) // Отображаем club_name
      ])
    ))
  ]);
}

// Функция для отображения секции клубной активности
function renderClubActivity(cabinetData: UserCabinetData | null, controller: UserCabinetController): VNode | null {
  if (!cabinetData) return null;

  const followedClubsNode = renderClubList('userCabinet.clubs.followedClubs', 'Followed Clubs', cabinetData.follow_clubs, controller);
  const leaderClubsNode = renderClubList('userCabinet.clubs.leaderInClubs', 'Leader In', cabinetData.club_leader, controller);
  const founderClubsNode = renderClubList('userCabinet.clubs.founderOfClubs', 'Founder Of', cabinetData.club_founder, controller);

  // Отображаем секцию только если есть хотя бы один не-null список клубов
  if (!followedClubsNode && !leaderClubsNode && !founderClubsNode) {
    // Можно вернуть сообщение, что клубной активности нет, или просто null
     return h('div.club-activity-section', [
        h('h3.section-title', t('userCabinet.clubs.activityTitle', {defaultValue: 'Club Activity'})),
        h('p', t('userCabinet.clubs.noActivity', {defaultValue: 'No club activity to display.'}))
    ]);
  }

  return h('div.club-activity-section', [
    h('h3.section-title', t('userCabinet.clubs.activityTitle', {defaultValue: 'Club Activity'})),
    followedClubsNode,
    leaderClubsNode,
    founderClubsNode,
  ].filter(Boolean) as VNode[]); // filter(Boolean) удалит null значения из массива
}


export function renderUserCabinetPage(controller: UserCabinetController): VNode {
  const state: UserCabinetControllerState = controller.state;
  logger.debug('[UserCabinetView] Rendering User Cabinet Page with state:', state);

  if (state.isLoading) {
    return h('div.user-cabinet-page.loading', [
      h('h1', state.pageTitle),
      h('p', t('common.loading', { defaultValue: 'Loading data...' }))
    ]);
  }

  if (state.error) {
    return h('div.user-cabinet-page.error', [
      h('h1', state.pageTitle),
      h('p.error-message', `${t('common.error', { defaultValue: 'Error' })}: ${state.error}`)
    ]);
  }

  if (!state.cabinetData) {
    return h('div.user-cabinet-page.no-data', [
      h('h1', state.pageTitle),
      h('p', t('userCabinet.error.noDataFound', {defaultValue: 'No data found for user cabinet.'}))
    ]);
  }

  const { cabinetData } = state;

  return h('div.user-cabinet-container', [
    h('header.cabinet-header', [
      h('h1.page-main-title', state.pageTitle),
      h('div.user-info-basic', [
        renderStatItem('userCabinet.info.lichessId', 'Lichess ID', cabinetData.lichess_id),
        renderStatItem('userCabinet.info.subscriptionTier', 'Subscription', cabinetData.subscriptionTier),
      ])
    ]),
    renderFinishHimStats(cabinetData.FinishHimStats),
    renderClubActivity(cabinetData, controller),
    // Можно добавить другие секции здесь
  ]);
}
