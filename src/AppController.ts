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
}

type ActivePageController = PuzzleController | AnalysisTestController | null;

export class AppController {
  public state: AppControllerState;
  public activePageController: ActivePageController | null = null;
  private services: AppServices;
  private requestGlobalRedraw: () => void;

  constructor(services: AppServices, requestGlobalRedraw: () => void) {
    this.services = services;
    this.requestGlobalRedraw = requestGlobalRedraw;

    this.state = {
      currentPage: 'puzzle', 
      isNavExpanded: false,
      isPortraitMode: window.matchMedia('(orientation: portrait)').matches,
    };

    logger.info('[AppController] Initialized.');
  }

  public initializeApp(): void {
    logger.info(`[AppController] Initializing app, setting current page to: ${this.state.currentPage}`);
    this.handleResize();
    this.loadPageController(this.state.currentPage);
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
    
    this.state.currentPage = page;
    this.loadPageController(page); 

    if (this.state.isPortraitMode && this.state.isNavExpanded) {
      this.state.isNavExpanded = false; 
    }
  }

  private loadPageController(page: AppPage): void {
    this.activePageController = null; 

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
        // ИСПРАВЛЕНО: Удален аргумент analysisBoardHandler.
        // AnalysisTestController пока не использует BoardHandler и ожидает 3 аргумента.
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
      this.requestGlobalRedraw();
    }
  }
}
