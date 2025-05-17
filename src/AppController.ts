// src/AppController.ts
import logger from './utils/logger';
import type { ChessboardService } from './core/chessboard.service';
import type { StockfishService } from './core/stockfish.service';
import type { WebhookService } from './core/webhook.service';
import { BoardHandler } from './core/boardHandler';

import { PuzzleController } from './features/puzzle/PuzzleController';
import { AnalysisTestController } from './features/analysis/AnalysisTestController';

export type AppPage = 'puzzle' | 'analysisTest' | 'storm' | 'openings';

export interface AppServices {
  chessboardService: ChessboardService;
  stockfishService: StockfishService;
  webhookService: WebhookService;
  logger: typeof logger;
}

interface AppControllerState {
  currentPage: AppPage;
  isNavExpanded: boolean;
  isPortraitMode: boolean;
  // userPreferredBoardSizeVh больше не в state, а как приватное свойство контроллера
}

type ActivePageController = PuzzleController | AnalysisTestController | null;

// Константы для расчета размера доски
const BOARD_MAX_VH = 94; // a_max = 95vh
const BOARD_MIN_VH = 10; // a_min = 10vh
const DEFAULT_BOARD_VH = 70; // Начальный/дефолтный размер доски в vh

export class AppController {
  public state: AppControllerState;
  public activePageController: ActivePageController | null = null;
  private services: AppServices;
  private requestGlobalRedraw: () => void;

  private userPreferredBoardSizeVh: number; // Предпочтительный размер доски в VH, управляемый пользователем

  constructor(services: AppServices, requestGlobalRedraw: () => void) {
    this.services = services;
    this.requestGlobalRedraw = requestGlobalRedraw;

    // Загрузка сохраненного предпочтения или установка дефолтного
    const savedVhPreference = localStorage.getItem('userPreferredBoardSizeVh');
    this.userPreferredBoardSizeVh = savedVhPreference ? parseFloat(savedVhPreference) : DEFAULT_BOARD_VH;
    // Убедимся, что загруженное значение находится в допустимых пределах
    this.userPreferredBoardSizeVh = Math.max(BOARD_MIN_VH, Math.min(BOARD_MAX_VH, this.userPreferredBoardSizeVh));


    this.state = {
      currentPage: 'puzzle',
      isNavExpanded: false,
      isPortraitMode: window.matchMedia('(orientation: portrait)').matches,
    };

    logger.info(`[AppController] Initialized. Initial userPreferredBoardSizeVh: ${this.userPreferredBoardSizeVh}vh`);
  }

  public initializeApp(): void {
    logger.info(`[AppController] Initializing app, current page: ${this.state.currentPage}`);
    this._calculateAndSetBoardSize();
    this.loadPageController(this.state.currentPage);
  }

  // --- Управление предпочтительным размером доски ---
  public getUserPreferredBoardSizeVh(): number {
    return this.userPreferredBoardSizeVh;
  }

  public setUserPreferredBoardSizeVh(newVh: number): void {
    const clampedVh = Math.max(BOARD_MIN_VH, Math.min(BOARD_MAX_VH, newVh));
    if (this.userPreferredBoardSizeVh !== clampedVh) {
      this.userPreferredBoardSizeVh = clampedVh;
      logger.debug(`[AppController] User preferred board size Vh set to: ${this.userPreferredBoardSizeVh.toFixed(2)}vh`);
      localStorage.setItem('userPreferredBoardSizeVh', this.userPreferredBoardSizeVh.toString()); // Сохраняем предпочтение
      this._calculateAndSetBoardSize(); // Пересчитать и применить новый размер
      this.requestGlobalRedraw();     // Запросить перерисовку UI
    }
  }
  // --- Конец управления предпочтительным размером ---


  private _getCssVariableInPixels(variableName: string): number {
    const value = getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
    if (value.endsWith('px')) {
      return parseFloat(value);
    }
    logger.warn(`[AppController] Could not parse CSS variable ${variableName} as px. Value: ${value}. Defaulting to 0.`);
    return 0;
  }

  private _calculateAndSetBoardSize(): void {
    const viewportHeightPx = window.innerHeight;
    const viewportWidthPx = window.innerWidth;

    // 1. Используем userPreferredBoardSizeVh для определения целевой высоты доски
    let currentBoardTargetSizePx = (this.userPreferredBoardSizeVh / 100) * viewportHeightPx;

    // Минимальный размер доски в пикселях, соответствующий BOARD_MIN_VH
    const minBoardSizeBasedOnMinVhPx = (BOARD_MIN_VH / 100) * viewportHeightPx;


    // 2. Горизонтальные ограничения
    const leftPanelWidthPx = this._getCssVariableInPixels('--panel-width');
    const rightPanelWidthPx = this._getCssVariableInPixels('--panel-width');
    const panelGapPx = this._getCssVariableInPixels('--panel-gap');

    let availableWidthForCenterPx: number;

    if (this.state.isPortraitMode) {
      availableWidthForCenterPx = viewportWidthPx - (2 * panelGapPx);
    } else {
      const actualLeftPanelWidth = document.getElementById('left-panel')?.offsetParent !== null ? leftPanelWidthPx : 0;
      const actualRightPanelWidth = document.getElementById('right-panel')?.offsetParent !== null ? rightPanelWidthPx : 0;
      
      let numberOfGaps = 2;
      if (actualLeftPanelWidth > 0 && actualRightPanelWidth > 0) {
        numberOfGaps = 4; // gaps: page-left, left-center, center-right, right-page
      } else if (actualLeftPanelWidth > 0 || actualRightPanelWidth > 0) {
        numberOfGaps = 3; // gaps: page-left, left-center, center-page (or mirrored)
      }
      // numberOfGaps = 2; // Минимум два отступа по краям страницы
      // if (actualLeftPanelWidth > 0) numberOfGaps++;
      // if (actualRightPanelWidth > 0) numberOfGaps++;
      // if (actualLeftPanelWidth > 0 && actualRightPanelWidth > 0) numberOfGaps--; // Неверная логика была

      const totalHorizontalSpacingPx = actualLeftPanelWidth + actualRightPanelWidth + (numberOfGaps * panelGapPx);
      availableWidthForCenterPx = viewportWidthPx - totalHorizontalSpacingPx;
    }
    
    const minPracticalWidthPx = 50; // Абсолютный минимум для ширины
    availableWidthForCenterPx = Math.max(availableWidthForCenterPx, minPracticalWidthPx);

    // 3. Итоговый размер доски в пикселях (квадрат)
    // Доска должна поместиться и по высоте (currentBoardTargetSizePx), и по ширине (availableWidthForCenterPx)
    let finalBoardSizePx = Math.min(currentBoardTargetSizePx, availableWidthForCenterPx);

    // 4. Применяем минимальный размер (исходя из BOARD_MIN_VH)
    finalBoardSizePx = Math.max(finalBoardSizePx, minBoardSizeBasedOnMinVhPx);
    
    // Важно: если finalBoardSizePx стал меньше, чем currentBoardTargetSizePx из-за ширины,
    // то userPreferredBoardSizeVh как бы "не достигается". Это нормально.

    // 5. Конвертируем итоговый размер обратно в VH для установки CSS переменной
    const finalBoardSizeVh = (finalBoardSizePx / viewportHeightPx) * 100;

    logger.debug(`[AppController _calc] VH H: ${viewportHeightPx}px, W: ${viewportWidthPx}px`);
    logger.debug(`[AppController _calc] UserPref: ${this.userPreferredBoardSizeVh.toFixed(2)}vh -> Target Board H: ${currentBoardTargetSizePx.toFixed(2)}px`);
    logger.debug(`[AppController _calc] MinBoard H (from MinVH): ${minBoardSizeBasedOnMinVhPx.toFixed(2)}px`);
    logger.debug(`[AppController _calc] Panels L: ${leftPanelWidthPx}px, R: ${rightPanelWidthPx}px, Gap: ${panelGapPx}px, Portrait: ${this.state.isPortraitMode}`);
    logger.debug(`[AppController _calc] Available Center W: ${availableWidthForCenterPx.toFixed(2)}px`);
    logger.debug(`[AppController _calc] Final Board Size: ${finalBoardSizePx.toFixed(2)}px -> ${finalBoardSizeVh.toFixed(2)}vh (to be set)`);

    document.documentElement.style.setProperty('--calculated-board-size-vh', `${finalBoardSizeVh.toFixed(3)}vh`);
  }


  public navigateTo(page: AppPage): void {
    if (this.state.currentPage === page && this.activePageController) {
      logger.info(`[AppController] Already on page: ${page}`);
      if (this.state.isPortraitMode && this.state.isNavExpanded) {
        this.toggleNav(); 
      }
      return;
    }
    logger.info(`[AppController] Navigating to page: ${page}`);
    
    if (this.activePageController && typeof (this.activePageController as any).destroy === 'function') {
      // (this.activePageController as any).destroy(); 
    }
    
    this.state.currentPage = page;
    this.loadPageController(page); 

    if (this.state.isPortraitMode && this.state.isNavExpanded) {
      this.state.isNavExpanded = false; 
    }
  }

  private loadPageController(page: AppPage): void {
    this.activePageController = null; 

    this._calculateAndSetBoardSize(); // Убедимся, что размер актуален перед загрузкой контроллера

    switch (page) {
      case 'puzzle':
        const puzzleBoardHandler = new BoardHandler(this.services.chessboardService, this.requestGlobalRedraw);
        this.activePageController = new PuzzleController(
          this.services.chessboardService,
          puzzleBoardHandler,
          this.services.webhookService,
          this.services.stockfishService,
          this.requestGlobalRedraw
        );
        if (typeof (this.activePageController as PuzzleController).initializeGame === 'function') {
            (this.activePageController as PuzzleController).initializeGame(); 
        } else {
            this.requestGlobalRedraw(); 
        }
        break;
      case 'analysisTest':
        this.activePageController = new AnalysisTestController(
          this.services.chessboardService,
          this.services.stockfishService,
          this.requestGlobalRedraw
        );
        if (typeof (this.activePageController as AnalysisTestController).initializeView === 'function') {
            (this.activePageController as AnalysisTestController).initializeView(); 
        } else {
            this.requestGlobalRedraw();
        }
        break;
      default:
        logger.error(`[AppController] Unknown page: ${page}. Cannot load controller.`);
        this.activePageController = null;
        this.requestGlobalRedraw(); 
    }
    logger.info(`[AppController] Loaded controller for page: ${page}`, this.activePageController);
  }

  public toggleNav(): void {
    this.state.isNavExpanded = !this.state.isNavExpanded;
    logger.info(`[AppController] Nav toggled. Expanded: ${this.state.isNavExpanded}`);
    this.requestGlobalRedraw();
  }

  public handleResize(): void {
    const newIsPortrait = window.matchMedia('(orientation: portrait)').matches;

    if (newIsPortrait !== this.state.isPortraitMode) {
      this.state.isPortraitMode = newIsPortrait;
      logger.info(`[AppController] Orientation changed. Portrait: ${this.state.isPortraitMode}`);
    }

    this._calculateAndSetBoardSize(); 
    this.requestGlobalRedraw();
  }
}
