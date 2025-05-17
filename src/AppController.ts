// src/AppController.ts
import logger from './utils/logger';
import type { ChessboardService } from './core/chessboard.service';
import type { StockfishService } from './core/stockfish.service';
import type { WebhookService } from './core/webhook.service';
import { BoardHandler } from './core/boardHandler';
import { PgnService } from './core/pgn.service'; 
import { AnalysisService } from './core/analysis.service'; 

import { PuzzleController } from './features/puzzle/PuzzleController';
import { AnalysisTestController } from './features/analysis/AnalysisTestController';

export type AppPage = 'puzzle' | 'analysisTest' | 'storm' | 'openings';

export interface AppServices {
  chessboardService: ChessboardService;
  stockfishService: StockfishService;
  webhookService: WebhookService;
  analysisService?: AnalysisService; 
  logger: typeof logger;
}

interface AppControllerState {
  currentPage: AppPage;
  isNavExpanded: boolean;
  isPortraitMode: boolean;
}

type ActivePageController = PuzzleController | AnalysisTestController | null;

const BOARD_MAX_VH = 94; 
const BOARD_MIN_VH = 10; 
const DEFAULT_BOARD_VH = 70; 

export class AppController {
  public state: AppControllerState;
  public activePageController: ActivePageController | null = null;
  private services: AppServices; 
  private requestGlobalRedraw: () => void;
  private userPreferredBoardSizeVh: number;
  private activeAnalysisService: AnalysisService | null = null; 

  constructor(
    globalServices: { 
      chessboardService: ChessboardService;
      stockfishService: StockfishService;
      webhookService: WebhookService;
      logger: typeof logger;
    },
    requestGlobalRedraw: () => void
  ) {
    this.services = globalServices; 
    this.requestGlobalRedraw = requestGlobalRedraw;

    const savedVhPreference = localStorage.getItem('userPreferredBoardSizeVh');
    this.userPreferredBoardSizeVh = savedVhPreference ? parseFloat(savedVhPreference) : DEFAULT_BOARD_VH;
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
      let numberOfGaps = 2;
      if (actualLeftPanelWidth > 0 && actualRightPanelWidth > 0) numberOfGaps = 4;
      else if (actualLeftPanelWidth > 0 || actualRightPanelWidth > 0) numberOfGaps = 3;
      const totalHorizontalSpacingPx = actualLeftPanelWidth + actualRightPanelWidth + (numberOfGaps * panelGapPx);
      availableWidthForCenterPx = viewportWidthPx - totalHorizontalSpacingPx;
    }
    
    const minPracticalWidthPx = 50; 
    availableWidthForCenterPx = Math.max(availableWidthForCenterPx, minPracticalWidthPx);
    let finalBoardSizePx = Math.min(currentBoardTargetSizePx, availableWidthForCenterPx);
    finalBoardSizePx = Math.max(finalBoardSizePx, minBoardSizeBasedOnMinVhPx);
    const finalBoardSizeVh = (finalBoardSizePx / viewportHeightPx) * 100;

    logger.debug(`[AppController _calc] Final Board Size: ${finalBoardSizePx.toFixed(2)}px -> ${finalBoardSizeVh.toFixed(2)}vh`);
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
      (this.activePageController as any).destroy(); 
      logger.info('[AppController] Previous page controller destroyed.');
    }
    if (this.activeAnalysisService) {
        this.activeAnalysisService.destroy();
        this.activeAnalysisService = null;
        logger.info('[AppController] Previous AnalysisService destroyed.');
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

    const analysisServiceForPage = new AnalysisService(
        this.services.stockfishService,
        boardHandlerForPage, 
        PgnService 
    );
    this.activeAnalysisService = analysisServiceForPage; 

    switch (page) {
      case 'puzzle':
        this.activePageController = new PuzzleController(
          this.services.chessboardService,
          boardHandlerForPage, 
          this.services.webhookService,
          this.services.stockfishService,
          analysisServiceForPage, 
          this.requestGlobalRedraw
        );
        if (typeof (this.activePageController as PuzzleController).initializeGame === 'function') {
            (this.activePageController as PuzzleController).initializeGame(); 
        } else {
            this.requestGlobalRedraw(); 
        }
        break;
      case 'analysisTest':
        // Если AnalysisTestController будет использоваться, ему также нужно передать boardHandlerForPage и analysisServiceForPage
        this.activePageController = new AnalysisTestController(
          this.services.chessboardService,
          this.services.stockfishService,
          // boardHandlerForPage, // Раскомментировать и добавить в конструктор AnalysisTestController
          // analysisServiceForPage, // Раскомментировать и добавить в конструктор AnalysisTestController
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
        if (this.activeAnalysisService) { 
            this.activeAnalysisService.destroy();
            this.activeAnalysisService = null;
        }
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
