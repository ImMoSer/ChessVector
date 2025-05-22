// src/features/recordsPage/RecordsPageController.ts
import logger from '../../utils/logger';
import type { AppServices } from '../../AppController';
import type { RawLeaderboardUserData } from '../../core/webhook.service'; // Удален импорт FinishHimStats отсюда
// FinishHimStats будет неявно использоваться через RawLeaderboardUserData
import { subscribeToLangChange, t } from '../../core/i18n.service';

// Тип для отображаемой записи в таблице рекордов
export interface ProcessedLeaderboardEntry extends RawLeaderboardUserData {
  rank: number;
  // Можно добавить сюда специфичные отформатированные значения, если потребуется
}

// Тип для конфигурации одной таблицы рекордов
export interface LeaderboardTableConfig {
  id: string; // Уникальный ID таблицы (например, 'tacticalRating', 'gamesPlayed')
  titleKey: string; // Ключ для локализации заголовка таблицы
  defaultTitle: string;
  // Функция для извлечения значения для сортировки из RawLeaderboardUserData
  sortValueExtractor: (data: RawLeaderboardUserData) => number;
  // Порядок сортировки: 'asc' или 'desc'
  sortOrder: 'asc' | 'desc';
  // Конфигурация столбцов для этой таблицы
  columns: Array<{
    headerKey: string; // Ключ для локализации заголовка столбца
    defaultHeader: string;
    // Функция для извлечения и форматирования значения ячейки из ProcessedLeaderboardEntry
    cellValueExtractor: (entry: ProcessedLeaderboardEntry) => string | number;
    textAlign?: 'left' | 'center' | 'right';
  }>;
  maxEntries?: number; // Максимальное количество записей для отображения
}

// Состояние контроллера
export interface RecordsPageControllerState {
  isLoading: boolean;
  error: string | null;
  // Массив обработанных данных для каждой таблицы рекордов
  leaderboardTables: Array<{
    config: LeaderboardTableConfig;
    entries: ProcessedLeaderboardEntry[];
  }> | null;
  pageTitle: string;
}

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
  // Можно добавить другие конфигурации здесь
];

export class RecordsPageController {
  public state: RecordsPageControllerState;
  private services: AppServices;
  private requestGlobalRedraw: () => void;
  private unsubscribeFromLangChange: (() => void) | null = null;
  private rawUserStats: RawLeaderboardUserData[] | null = null; // Храним сырые данные

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
      this.processAndSetLeaderboards(); // Пересчитываем таблицы с новыми заголовками
      this.requestGlobalRedraw();
    });

    logger.info('[RecordsPageController] Initialized.');
  }

  public async initializePage(): Promise<void> {
    logger.info('[RecordsPageController] Initializing page data...');
    this.setState({ isLoading: true, error: null, leaderboardTables: null });
    this.updateLocalizedTexts(); // Устанавливаем заголовок на время загрузки

    try {
      const allUserStats = await this.services.webhookService.fetchAllUserStatsForLeaderboards();

      if (allUserStats) {
        this.rawUserStats = allUserStats; // Сохраняем сырые данные
        this.processAndSetLeaderboards(); // Обрабатываем данные
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
    // Явно присваиваем this.rawUserStats новой переменной после проверки, чтобы помочь TypeScript
    const currentRawUserStats: RawLeaderboardUserData[] = this.rawUserStats;

    const processedTables = LEADERBOARD_CONFIGS.map(config => {
      // 1. Фильтруем пользователей, у которых есть необходимые данные (например, >0 игр для некоторых таблиц)
      //    Для примера, пока берем всех. Можно добавить фильтр, если нужно.
      let filteredUsers = [...currentRawUserStats]; // Используем новую переменную

      // 2. Сортируем
      filteredUsers.sort((a, b) => {
        const valA = config.sortValueExtractor(a);
        const valB = config.sortValueExtractor(b);
        return config.sortOrder === 'desc' ? valB - valA : valA - valB;
      });

      // 3. Присваиваем ранги и ограничиваем количество
      const rankedEntries: ProcessedLeaderboardEntry[] = filteredUsers
        .slice(0, config.maxEntries || filteredUsers.length) // Ограничиваем количество, если задано
        .map((user, index) => ({
          ...user,
          rank: index + 1,
        }));

      return {
        config: config, // Сохраняем конфигурацию для использования во View
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
    // Заголовки таблиц и столбцов будут локализоваться во View при рендеринге,
    // используя ключи из LeaderboardTableConfig
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
