// src/features/recordsPage/RecordsPageController.ts
import logger from '../../utils/logger';
import type { AppServices } from '../../AppController';
import type { RawLeaderboardUserData } from '../../core/webhook.service';
import { subscribeToLangChange, t } from '../../core/i18n.service';

// Тип для отображаемой записи в таблице рекордов
// Удалены tacticalWinRate и playoutWinRate, так как соответствующие таблицы убраны
export interface ProcessedLeaderboardEntry extends RawLeaderboardUserData {
  rank: number;
}

// Тип для конфигурации одной таблицы рекордов
export interface LeaderboardTableConfig {
  id: string;
  titleKey: string;
  defaultTitle: string;
  sortValueExtractor: (data: RawLeaderboardUserData) => number;
  sortOrder: 'asc' | 'desc';
  columns: Array<{
    headerKey: string;
    defaultHeader: string;
    cellValueExtractor: (entry: ProcessedLeaderboardEntry) => string | number;
    textAlign?: 'left' | 'center' | 'right';
  }>;
  maxEntries?: number;
  // minGamesThreshold и gameCountExtractorForThreshold больше не нужны глобально,
  // так как таблицы, их использующие, удалены.
}

// Состояние контроллера
export interface RecordsPageControllerState {
  isLoading: boolean;
  error: string | null;
  leaderboardTables: Array<{
    config: LeaderboardTableConfig;
    entries: ProcessedLeaderboardEntry[];
  }> | null;
  pageTitle: string;
}

// MIN_GAMES_FOR_RATE_TABLES больше не используется

// Предопределенные конфигурации для таблиц рекордов
const LEADERBOARD_CONFIGS: LeaderboardTableConfig[] = [
  {
    id: 'tacticalRating',
    titleKey: 'records.titles.tacticalRating',
    defaultTitle: 'Top Tactical Rating',
    sortValueExtractor: (data) => data.FinishHimStats.tacticalRating,
    sortOrder: 'desc',
    maxEntries: 20,
    columns: [
      { headerKey: 'records.table.rank', defaultHeader: '#', cellValueExtractor: (entry) => entry.rank, textAlign: 'center' },
      { headerKey: 'records.table.player', defaultHeader: 'Player', cellValueExtractor: (entry) => entry.username, textAlign: 'left' },
      { headerKey: 'records.table.tacticalRatingValue', defaultHeader: 'Tactical Rating', cellValueExtractor: (entry) => entry.FinishHimStats.tacticalRating, textAlign: 'right' },
      { headerKey: 'records.table.gamesPlayed', defaultHeader: 'Games', cellValueExtractor: (entry) => entry.FinishHimStats.gamesPlayed, textAlign: 'right' },
    ],
  },
  {
    id: 'finishHimRating',
    titleKey: 'records.titles.finishHimRating',
    defaultTitle: 'Top Playout Rating',
    sortValueExtractor: (data) => data.FinishHimStats.finishHimRating,
    sortOrder: 'desc',
    maxEntries: 20,
    columns: [
      { headerKey: 'records.table.rank', defaultHeader: '#', cellValueExtractor: (entry) => entry.rank, textAlign: 'center' },
      { headerKey: 'records.table.player', defaultHeader: 'Player', cellValueExtractor: (entry) => entry.username, textAlign: 'left' },
      { headerKey: 'records.table.finishHimRatingValue', defaultHeader: 'Playout Rating', cellValueExtractor: (entry) => entry.FinishHimStats.finishHimRating, textAlign: 'right' },
      { headerKey: 'records.table.playoutWins', defaultHeader: 'Playout Wins', cellValueExtractor: (entry) => entry.FinishHimStats.playoutWins, textAlign: 'right' },
    ],
  },
  {
    id: 'gamesPlayed',
    titleKey: 'records.titles.mostGamesPlayed',
    defaultTitle: 'Most Games Played',
    sortValueExtractor: (data) => data.FinishHimStats.gamesPlayed,
    sortOrder: 'desc',
    maxEntries: 20,
    columns: [
      { headerKey: 'records.table.rank', defaultHeader: '#', cellValueExtractor: (entry) => entry.rank, textAlign: 'center' },
      { headerKey: 'records.table.player', defaultHeader: 'Player', cellValueExtractor: (entry) => entry.username, textAlign: 'left' },
      { headerKey: 'records.table.gamesPlayed', defaultHeader: 'Games Played', cellValueExtractor: (entry) => entry.FinishHimStats.gamesPlayed, textAlign: 'right' },
      { headerKey: 'records.table.tacticalWins', defaultHeader: 'Tactical Wins', cellValueExtractor: (entry) => entry.FinishHimStats.tacticalWins, textAlign: 'right' },
    ],
  },
  // --- Добавлена таблица "Highest Level Achieved" ---
  {
    id: 'highestLevel',
    titleKey: 'records.titles.highestLevel',
    defaultTitle: 'Highest Level Achieved',
    sortValueExtractor: (data) => data.FinishHimStats.currentPieceCount,
    sortOrder: 'desc',
    maxEntries: 20,
    columns: [
      { headerKey: 'records.table.rank', defaultHeader: '#', cellValueExtractor: (entry) => entry.rank, textAlign: 'center' },
      { headerKey: 'records.table.player', defaultHeader: 'Player', cellValueExtractor: (entry) => entry.username, textAlign: 'left' },
      { headerKey: 'records.table.level', defaultHeader: 'Level (Pieces)', cellValueExtractor: (entry) => entry.FinishHimStats.currentPieceCount, textAlign: 'right' },
      { headerKey: 'records.table.tacticalRatingValue', defaultHeader: 'Tactical Rating', cellValueExtractor: (entry) => entry.FinishHimStats.tacticalRating, textAlign: 'right' },
    ],
  },
  // --- Конфигурации для "tacticalAccuracy" и "playoutPerformance" УДАЛЕНЫ ---
];

export class RecordsPageController {
  public state: RecordsPageControllerState;
  private services: AppServices;
  private requestGlobalRedraw: () => void;
  private unsubscribeFromLangChange: (() => void) | null = null;
  private rawUserStats: RawLeaderboardUserData[] | null = null;

  constructor(services: AppServices, requestGlobalRedraw: () => void) {
    this.services = services;
    this.requestGlobalRedraw = requestGlobalRedraw;

    this.state = {
      isLoading: true,
      error: null,
      leaderboardTables: null,
      pageTitle: t('records.pageTitle.loading', { defaultValue: 'Loading Leaderboards...' }),
    };

    this.unsubscribeFromLangChange = subscribeToLangChange(() => {
      this.updateLocalizedTexts();
      this.processAndSetLeaderboards();
      this.requestGlobalRedraw();
    });

    logger.info('[RecordsPageController] Initialized.');
  }

  public async initializePage(): Promise<void> {
    logger.info('[RecordsPageController] Initializing page data...');
    this.setState({ isLoading: true, error: null, leaderboardTables: null });
    this.updateLocalizedTexts();

    try {
      const allUserStats = await this.services.webhookService.fetchAllUserStatsForLeaderboards();

      if (allUserStats) {
        this.rawUserStats = allUserStats;
        this.processAndSetLeaderboards();
        this.setState({
          isLoading: false,
          error: null,
          pageTitle: t('records.pageTitle.loaded', { defaultValue: 'Leaderboards' }),
        });
        logger.info(`[RecordsPageController] Leaderboard data loaded and processed. Users: ${allUserStats.length}`);
      } else {
        throw new Error(t('records.errors.dataLoadFailed', { defaultValue: 'Failed to load leaderboard data.' }));
      }
    } catch (error: any) {
      logger.error('[RecordsPageController] Error fetching leaderboard data:', error);
      this.setState({
        isLoading: false,
        error: error.message || t('records.errors.unknown', { defaultValue: 'An unknown error occurred.' }),
        leaderboardTables: null,
        pageTitle: t('records.pageTitle.error', { defaultValue: 'Error Loading Leaderboards' }),
      });
    }
  }

  private processAndSetLeaderboards(): void {
    if (!this.rawUserStats) {
      this.setState({ leaderboardTables: null });
      return;
    }
    const currentRawUserStats: RawLeaderboardUserData[] = this.rawUserStats;

    const processedTables = LEADERBOARD_CONFIGS.map(config => {
      let filteredUsers = [...currentRawUserStats];

      // Фильтрация по порогу игр больше не нужна для оставшихся таблиц,
      // так как minGamesThreshold и gameCountExtractorForThreshold удалены из общего интерфейса
      // и из конфигураций оставшихся таблиц.

      filteredUsers.sort((a, b) => {
        const valA = config.sortValueExtractor(a);
        const valB = config.sortValueExtractor(b);
        return config.sortOrder === 'desc' ? valB - valA : valA - valB;
      });

      const rankedEntries: ProcessedLeaderboardEntry[] = filteredUsers
        .slice(0, config.maxEntries || filteredUsers.length)
        .map((user, index) => {
          // Расчет tacticalWinRate и playoutWinRate больше не нужен здесь,
          // так как соответствующие таблицы удалены.
          return {
            ...user,
            rank: index + 1,
          };
        });

      return {
        config: config,
        entries: rankedEntries,
      };
    });

    this.setState({ leaderboardTables: processedTables });
  }


  private updateLocalizedTexts(): void {
    if (this.state.isLoading) {
      this.state.pageTitle = t('records.pageTitle.loading', { defaultValue: 'Loading Leaderboards...' });
    } else if (this.state.error) {
      this.state.pageTitle = t('records.pageTitle.error', { defaultValue: 'Error Loading Leaderboards' });
    } else {
      this.state.pageTitle = t('records.pageTitle.loaded', { defaultValue: 'Leaderboards' });
    }
  }

  private setState(newState: Partial<RecordsPageControllerState>): void {
    this.state = { ...this.state, ...newState };
    this.requestGlobalRedraw();
  }

  public destroy(): void {
    if (this.unsubscribeFromLangChange) {
      this.unsubscribeFromLangChange();
      this.unsubscribeFromLangChange = null;
    }
    logger.info('[RecordsPageController] Destroyed.');
  }
}
