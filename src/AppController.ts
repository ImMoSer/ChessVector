// src/AppController.ts
import logger from './utils/logger';
import type { ChessboardService } from './core/chessboard.service';
import type { StockfishService } from './core/stockfish.service';
import type { WebhookService } from './core/webhook.service';
import { BoardHandler } from './core/boardHandler';
import { PgnService } from './core/pgn.service';
import { AnalysisService } from './core/analysis.service';
import { AnalysisController } from './features/analysis/analysisController';
import { t, subscribeToLangChange, getCurrentLang } from './core/i18n.service';

import { FinishHimController } from './features/finishHim/finishHimController';

export type AppPage = 'finishHim';

export interface AppServices {
  chessboardService: ChessboardService;
  stockfishService: StockfishService;
  webhookService: WebhookService;
  analysisService: AnalysisService;
  logger: typeof logger;
}

interface AppControllerState {
  currentPage: AppPage;
  isNavExpanded: boolean;
  isPortraitMode: boolean;
}

type ActivePageController = FinishHimController | null;

const BOARD_MAX_VH = 94;
const BOARD_MIN_VH = 10;
const DEFAULT_BOARD_VH = 70;

export class AppController {
  public state: AppControllerState;
  public activePageController: ActivePageController | null = null;
  private services: AppServices;
  private requestGlobalRedraw: () => void;
  private userPreferredBoardSizeVh: number;
  
  // AnalysisController будет создаваться в loadPageController
  private analysisControllerInstance: AnalysisController | null = null; 
  private analysisServiceInstance: AnalysisService; 

  private unsubscribeFromLangChange: (() => void) | null = null;

  constructor(
    globalServices: { 
      chessboardService: ChessboardService;
      stockfishService: StockfishService;
      webhookService: WebhookService;
      logger: typeof logger;
    },
    requestGlobalRedraw: () => void
  ) {
    this.analysisServiceInstance = new AnalysisService(globalServices.stockfishService);

    this.services = {
        ...globalServices,
        analysisService: this.analysisServiceInstance, 
    };
    this.requestGlobalRedraw = requestGlobalRedraw;

    const savedVhPreference = localStorage.getItem('userPreferredBoardSizeVh');
    this.userPreferredBoardSizeVh = savedVhPreference ? parseFloat(savedVhPreference) : DEFAULT_BOARD_VH;
    this.userPreferredBoardSizeVh = Math.max(BOARD_MIN_VH, Math.min(BOARD_MAX_VH, this.userPreferredBoardSizeVh));

    this.state = {
      currentPage: 'finishHim',
      isNavExpanded: false,
      isPortraitMode: window.matchMedia('(orientation: portrait)').matches,
    };

    // AnalysisController больше не создается здесь.
    // Он будет создан в loadPageController.
    // this.analysisControllerInstance = new AnalysisController(...) 

    this.unsubscribeFromLangChange = subscribeToLangChange(() => {
      logger.info('[AppController] Language changed, requesting global redraw.');
      this.requestGlobalRedraw();
    });

    logger.info(`[AppController] Initialized. Default page: ${this.state.currentPage}. Current lang: ${getCurrentLang()}`);
  }

  public initializeApp(): void {
    logger.info(`[AppController] Initializing app, current page: ${this.state.currentPage}`);
    this._calculateAndSetBoardSize();
    this.loadPageController(this.state.currentPage);
  }

  public getUserPreferredBoardSizeVh(): number {
    return this.userPreferredBoardSizeVh;
  }

  public setUserPreferredBoardSizeVh(newVh: number): void {
    const clampedVh = Math.max(BOARD_MIN_VH, Math.min(BOARD_MAX_VH, newVh));
    if (this.userPreferredBoardSizeVh !== clampedVh) {
      this.userPreferredBoardSizeVh = clampedVh;
      logger.debug(`[AppController] User preferred board size Vh set to: ${this.userPreferredBoardSizeVh.toFixed(2)}vh`);
      localStorage.setItem('userPreferredBoardSizeVh', this.userPreferredBoardSizeVh.toString());
      this._calculateAndSetBoardSize();
      this.requestGlobalRedraw();
    }
  }

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
    let currentBoardTargetSizePx = (this.userPreferredBoardSizeVh / 100) * viewportHeightPx;
    const minBoardSizeBasedOnMinVhPx = (BOARD_MIN_VH / 100) * viewportHeightPx;
    const leftPanelWidthPx = this._getCssVariableInPixels('--panel-width');
    const rightPanelWidthPx = this._getCssVariableInPixels('--panel-width');
    const panelGapPx = this._getCssVariableInPixels('--panel-gap');
    let availableWidthForCenterPx: number;

    if (this.state.isPortraitMode) {
      availableWidthForCenterPx = viewportWidthPx - (2 * panelGapPx);
    } else {
      const actualLeftPanelWidth = document.getElementById('left-panel')?.offsetParent !== null ? leftPanelWidthPx : 0;
      const actualRightPanelWidth = document.getElementById('right-panel')?.offsetParent !== null ? rightPanelWidthPx : 0;
      let numberOfGaps = 0;
      if (actualLeftPanelWidth > 0) numberOfGaps++;
      if (actualRightPanelWidth > 0) numberOfGaps++;
      
      const totalSidePanelsWidth = actualLeftPanelWidth + actualRightPanelWidth;
      const totalGapsWidth = numberOfGaps * panelGapPx;
      const outerPagePadding = 2 * panelGapPx;

      availableWidthForCenterPx = viewportWidthPx - totalSidePanelsWidth - totalGapsWidth - outerPagePadding;
    }

    const minPracticalWidthPx = 50;
    availableWidthForCenterPx = Math.max(availableWidthForCenterPx, minPracticalWidthPx);
    let finalBoardSizePx = Math.min(currentBoardTargetSizePx, availableWidthForCenterPx);
    finalBoardSizePx = Math.max(finalBoardSizePx, minBoardSizeBasedOnMinVhPx);
    const finalBoardSizeVh = (finalBoardSizePx / viewportHeightPx) * 100;

    logger.debug(`[AppController _calc] Final Board Size: ${finalBoardSizePx.toFixed(2)}px -> ${finalBoardSizeVh.toFixed(2)}vh. AvailableWidth: ${availableWidthForCenterPx.toFixed(2)}px`);
    document.documentElement.style.setProperty('--calculated-board-size-vh', `${finalBoardSizeVh.toFixed(3)}vh`);

    const resizeEvent = new CustomEvent('centerPanelResized', {
        detail: {
            widthPx: finalBoardSizePx,
            heightPx: finalBoardSizePx,
            widthVh: finalBoardSizeVh,
            heightVh: finalBoardSizeVh
        }
    });
    window.dispatchEvent(resizeEvent);
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

    if (this.activePageController && typeof this.activePageController.destroy === 'function') {
      this.activePageController.destroy();
      logger.info('[AppController] Previous page controller destroyed.');
    }
    
    if (this.analysisControllerInstance && typeof this.analysisControllerInstance.destroy === 'function') {
        this.analysisControllerInstance.destroy();
        this.analysisControllerInstance = null; // Сбрасываем экземпляр
        logger.info('[AppController] Previous AnalysisController instance destroyed.');
    }

    this.state.currentPage = page;
    this.loadPageController(page);

    if (this.state.isPortraitMode && this.state.isNavExpanded) {
      this.state.isNavExpanded = false;
    }
  }

  private loadPageController(page: AppPage): void {
    this.activePageController = null;
    this._calculateAndSetBoardSize();

    const boardHandlerForPage = new BoardHandler(
        this.services.chessboardService,
        this.requestGlobalRedraw
    );
    
    // Создаем AnalysisController здесь, после создания boardHandlerForPage
    this.analysisControllerInstance = new AnalysisController(
        this.services.analysisService,
        boardHandlerForPage, 
        PgnService,
        this.requestGlobalRedraw
    );

    switch (page) {
      case 'finishHim':
        // Убедимся, что analysisControllerInstance не null перед передачей
        if (!this.analysisControllerInstance) {
            logger.error("[AppController] Critical: analysisControllerInstance is null before creating FinishHimController.");
            // Можно добавить обработку ошибки, например, не создавать FinishHimController
            return;
        }
        this.activePageController = new FinishHimController(
          this.services.chessboardService,
          boardHandlerForPage, 
          this.services.webhookService,
          this.services.stockfishService,
          this.analysisControllerInstance, // Передаем созданный экземпляр
          this.requestGlobalRedraw
        );
        if (typeof this.activePageController.initializeGame === 'function') {
            this.activePageController.initializeGame();
        } else {
            this.requestGlobalRedraw();
        }
        break;
      default:
        logger.error(`[AppController] Unknown page: ${page}. Cannot load controller. Defaulting to 'finishHim'.`);
        this.state.currentPage = 'finishHim';
        this.loadPageController('finishHim');
        return; 
    }
    logger.info(`[AppController] Loaded controller for page: ${page}`, this.activePageController);
    this.requestGlobalRedraw();
  }

  public toggleNav(): void {
    this.state.isNavExpanded = !this.state.isNavExpanded;
    logger.info(`[AppController] Nav toggled. Expanded: ${this.state.isNavExpanded}`);
    this.requestGlobalRedraw();
  }

  public handleResize(): void {
    const newIsPortrait = window.matchMedia('(orientation: portrait)').matches;
    let needsRedraw = false;

    if (newIsPortrait !== this.state.isPortraitMode) {
      this.state.isPortraitMode = newIsPortrait;
      logger.info(`[AppController] Orientation changed. Portrait: ${this.state.isPortraitMode}`);
      needsRedraw = true;
    }

    this._calculateAndSetBoardSize();
    if (needsRedraw) {
        this.requestGlobalRedraw();
    }
  }

  public destroy(): void {
    if (this.unsubscribeFromLangChange) {
      this.unsubscribeFromLangChange();
      this.unsubscribeFromLangChange = null;
      logger.info('[AppController] Unsubscribed from language changes.');
    }
    if (this.activePageController && typeof this.activePageController.destroy === 'function') {
        this.activePageController.destroy();
        logger.info('[AppController] Active page controller destroyed during AppController destroy.');
    }
    if (this.analysisControllerInstance && typeof this.analysisControllerInstance.destroy === 'function') {
        this.analysisControllerInstance.destroy();
        logger.info('[AppController] AnalysisController instance destroyed during AppController destroy.');
    }
     if (this.analysisServiceInstance && typeof this.analysisServiceInstance.destroy === 'function') {
        this.analysisServiceInstance.destroy();
        logger.info('[AppController] AnalysisService instance destroyed during AppController destroy.');
    }
  }
}
