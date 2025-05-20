// src/AppController.ts
import logger from './utils/logger';
import type { ChessboardService } from './core/chessboard.service';
import type { StockfishService } from './core/stockfish.service';
import type { WebhookService } from './core/webhook.service';
import { BoardHandler } from './core/boardHandler';
import { PgnService } from './core/pgn.service';
import { AnalysisService } from './core/analysis.service';
import { AnalysisController } from './features/analysis/analysisController';
import { subscribeToLangChange, getCurrentLang } from './core/i18n.service';
import { FinishHimController } from './features/finishHim/finishHimController';
import { WelcomeController } from './features/welcome/welcomeController';
import { AuthService, type UserSessionProfile, type SubscriptionTier } from './core/auth.service';


export type AppPage = 'welcome' | 'finishHim';

export interface AppServices {
  authService: typeof AuthService;
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
  currentUser: UserSessionProfile | null;
  isLoadingAuth: boolean;
}

type ActivePageController = WelcomeController | FinishHimController | null;

const BOARD_MAX_VH = 94;
const BOARD_MIN_VH = 10;
const DEFAULT_BOARD_VH = 70;

export class AppController {
  public state: AppControllerState;
  public activePageController: ActivePageController | null = null;
  public services: AppServices;
  private requestGlobalRedraw: () => void;
  private userPreferredBoardSizeVh: number;

  private analysisControllerInstance: AnalysisController | null = null;
  private analysisServiceInstance: AnalysisService;
  private authServiceInstance: typeof AuthService;

  private unsubscribeFromLangChange: (() => void) | null = null;
  private unsubscribeFromAuthChange: (() => void) | null = null;

  constructor(
    globalServices: {
      chessboardService: ChessboardService;
      stockfishService: StockfishService;
      webhookService: WebhookService;
      logger: typeof logger;
    },
    requestGlobalRedraw: () => void
  ) {
    this.authServiceInstance = AuthService;
    this.analysisServiceInstance = new AnalysisService(globalServices.stockfishService);

    this.services = {
      ...globalServices,
      authService: this.authServiceInstance,
      analysisService: this.analysisServiceInstance,
    };
    this.requestGlobalRedraw = requestGlobalRedraw;

    const savedVhPreference = localStorage.getItem('userPreferredBoardSizeVh');
    this.userPreferredBoardSizeVh = savedVhPreference ? parseFloat(savedVhPreference) : DEFAULT_BOARD_VH;
    this.userPreferredBoardSizeVh = Math.max(BOARD_MIN_VH, Math.min(BOARD_MAX_VH, this.userPreferredBoardSizeVh));

    this.state = {
      currentPage: 'welcome', // Default, will be updated by initializeApp
      isNavExpanded: false,
      isPortraitMode: window.matchMedia('(orientation: portrait)').matches,
      currentUser: null,
      isLoadingAuth: true, // Start in loading state for auth
    };

    this.unsubscribeFromLangChange = subscribeToLangChange(() => {
      logger.info('[AppController] Language changed, requesting global redraw.');
      this.requestGlobalRedraw();
    });

    // Simplified Auth Subscriber
    this.unsubscribeFromAuthChange = this.authServiceInstance.subscribe(() => {
      logger.info('[AppController] Auth state changed via subscription (simplified).');
      const authState = this.authServiceInstance.getState();
      
      const prevUserProfileId = this.state.currentUser?.id;
      const prevIsLoadingAuth = this.state.isLoadingAuth;

      this.state.currentUser = authState.userProfile;
      this.state.isLoadingAuth = authState.isProcessing;

      // Redraw if user profile or loading state actually changed
      if (prevUserProfileId !== authState.userProfile?.id || prevIsLoadingAuth !== authState.isProcessing) {
          this.requestGlobalRedraw();
      }

      // Handle logout or session expiration *after* initial app load sequence
      // initializeApp is responsible for the first page load decision.
      // This handles subsequent events like user clicking "logout".
      if (!this._isInitializing && !authState.isProcessing && !authState.isAuthenticated && this.state.currentPage !== 'welcome') {
          logger.info('[AppController Subscriber] Post-init: User logged out or session expired, navigating to welcome.');
          // The outer condition already ensures this.state.currentPage is not 'welcome'.
          // So, the inner check was redundant.
          this.navigateTo('welcome'); 
      }
    });

    logger.info(`[AppController] Initialized. Current lang: ${getCurrentLang()}`);
  }

  private _isInitializing: boolean = true; // Flag to manage initial load phase

  public async initializeApp(): Promise<void> {
    this._isInitializing = true;
    logger.info(`[AppController] Initializing app & authentication...`);
    this.setState({ isLoadingAuth: true });

    const authCallbackProcessed = await this.authServiceInstance.handleAuthentication();
    // Auth subscriber will update this.state.currentUser and this.state.isLoadingAuth

    let finalInitialPageTarget: AppPage;
    const hash = window.location.hash.slice(1) as AppPage;
    const isAuthenticated = this.authServiceInstance.getIsAuthenticated(); // Use getter after handleAuthentication

    if (authCallbackProcessed) {
        finalInitialPageTarget = isAuthenticated ? 'finishHim' : 'welcome';
        logger.info(`[AppController] Auth callback processed. Determined initial target: ${finalInitialPageTarget}`);
    } else {
        if (isAuthenticated) {
            const validPagesAfterAuth: AppPage[] = ['finishHim'];
            if (validPagesAfterAuth.includes(hash)) {
                finalInitialPageTarget = hash;
            } else {
                finalInitialPageTarget = 'finishHim';
            }
        } else {
            finalInitialPageTarget = 'welcome';
        }
        logger.info(`[AppController] No auth callback. Determined initial target based on stored session/hash: ${finalInitialPageTarget}`);
    }
    
    // Navigate to the final determined page.
    // navigateTo will set this.state.currentPage and call loadPageController.
    this.navigateTo(finalInitialPageTarget, true);

    logger.info(`[AppController] App initialization sequence complete. Final page: ${this.state.currentPage}`);
    this._calculateAndSetBoardSize(); // Ensures board size is set after page structure might be decided.
    
    window.addEventListener('hashchange', this.handleHashChange.bind(this));
    this._isInitializing = false; // Mark initialization as complete
    // requestGlobalRedraw is handled by navigateTo
  }

  private handleHashChange(): void {
    const newPageFromHash = window.location.hash.slice(1) as AppPage;
    logger.info(`[AppController] Hash changed to: #${newPageFromHash}`);

    const validPages: AppPage[] = ['welcome', 'finishHim'];
    const isValidAppPage = validPages.includes(newPageFromHash);

    if (isValidAppPage && newPageFromHash !== this.state.currentPage) {
        this.navigateTo(newPageFromHash, false); 
    } else if (!isValidAppPage && newPageFromHash) {
        logger.warn(`[AppController] Invalid page in hash: #${newPageFromHash}. Redirecting to default.`);
        const defaultPage = this.authServiceInstance.getIsAuthenticated() ? 'finishHim' : 'welcome';
        this.navigateTo(defaultPage);
    } else if (!newPageFromHash) {
        const defaultPage = this.authServiceInstance.getIsAuthenticated() ? 'finishHim' : 'welcome';
        if (this.state.currentPage !== defaultPage) {
            this.navigateTo(defaultPage);
        }
    }
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

  public navigateTo(page: AppPage, updateHash: boolean = true): void {
    const isAuthenticated = this.authServiceInstance.getIsAuthenticated();
    const userTier = this.authServiceInstance.getUserSubscriptionTier();

    logger.info(`[AppController navigateTo] Attempting navigation to: ${page}. Current: ${this.state.currentPage}. Auth: ${isAuthenticated}, Tier: ${userTier}`);
    
    // Block navigation if auth is processing, except during the initial call from initializeApp.
    // The _isInitializing flag helps distinguish this.
    if (this.state.isLoadingAuth && !this._isInitializing && page !== this.state.currentPage) {
        logger.warn(`[AppController navigateTo] Navigation to ${page} blocked: authentication is processing, and not initial load.`);
        return;
    }

    let targetPage = page;
    if (page === 'finishHim') {
      if (!isAuthenticated) {
        logger.warn('[AppController navigateTo] Access to finishHim denied: not authenticated. Redirecting to welcome.');
        targetPage = 'welcome';
      } else {
        const allowedTiersForFinishHim: SubscriptionTier[] = ['bronze', 'silver', 'gold', 'platinum'];
        if (!allowedTiersForFinishHim.includes(userTier)) {
          logger.warn(`[AppController navigateTo] Access to finishHim denied: tier ${userTier} not allowed. Redirecting to welcome.`);
          targetPage = 'welcome';
        }
      }
    } else if (page === 'welcome' && isAuthenticated) {
        logger.info('[AppController navigateTo] Authenticated user attempting to navigate to welcome. Redirecting to finishHim.');
        targetPage = 'finishHim';
    }

    if (this.state.currentPage === targetPage && this.activePageController) {
      logger.info(`[AppController navigateTo] Already on page: ${targetPage}. Controller exists.`);
      if (this.state.isPortraitMode && this.state.isNavExpanded) {
        this.toggleNav();
      } else {
        this.requestGlobalRedraw(); // Ensure UI updates if only sub-state (like nav) changed
      }
      if (updateHash && window.location.hash.slice(1) !== targetPage) {
          window.location.hash = targetPage;
      }
      return;
    }

    if (this.activePageController && typeof this.activePageController.destroy === 'function') {
      this.activePageController.destroy();
      this.activePageController = null;
    }
    if (this.analysisControllerInstance && typeof this.analysisControllerInstance.destroy === 'function') {
        this.analysisControllerInstance.destroy();
        this.analysisControllerInstance = null;
    }

    this.state.currentPage = targetPage;
    if (updateHash && window.location.hash.slice(1) !== targetPage) {
        window.location.hash = targetPage;
    }
    this.loadPageController(targetPage);

    if (this.state.isPortraitMode && this.state.isNavExpanded) {
      this.state.isNavExpanded = false;
      // loadPageController will call requestGlobalRedraw
    }
  }

  private loadPageController(page: AppPage): void {
    if (this.activePageController && typeof this.activePageController.destroy === 'function') {
        this.activePageController.destroy();
    }
    this.activePageController = null;

    if (this.analysisControllerInstance && typeof this.analysisControllerInstance.destroy === 'function') {
        this.analysisControllerInstance.destroy();
        this.analysisControllerInstance = null;
    }
    
    this._calculateAndSetBoardSize();

    let boardHandlerForPage: BoardHandler | undefined;
    
    if (page === 'finishHim') {
        boardHandlerForPage = new BoardHandler(
            this.services.chessboardService,
            this.requestGlobalRedraw
        );
        this.analysisControllerInstance = new AnalysisController(
            this.services.analysisService,
            boardHandlerForPage,
            PgnService,
            this.requestGlobalRedraw
        );
    }

    switch (page) {
      case 'welcome':
        this.activePageController = new WelcomeController(this.authServiceInstance, this.requestGlobalRedraw);
        break;
      case 'finishHim':
        if (!boardHandlerForPage || !this.analysisControllerInstance) {
            logger.error("[AppController] Critical error: BoardHandler or AnalysisController not initialized for FinishHim page.");
            // Fallback navigation should be handled carefully to avoid loops.
            // If this happens, it indicates a flaw in the new _isInitializing logic or similar.
            if (this.state.currentPage !== 'welcome') this.navigateTo('welcome');
            else logger.error("[AppController] Already on welcome, cannot fallback further from FihishHim init error.");
            return;
        }
        this.activePageController = new FinishHimController(
          this.services.chessboardService,
          boardHandlerForPage,
          this.services.webhookService,
          this.services.stockfishService,
          this.analysisControllerInstance,
          this.requestGlobalRedraw
        );
        if (typeof this.activePageController.initializeGame === 'function') {
            this.activePageController.initializeGame();
        }
        break;
      default:
        const exhaustiveCheck: never = page;
        logger.error(`[AppController] Unknown page in loadPageController: ${exhaustiveCheck}. Defaulting to welcome.`);
        if (this.state.currentPage !== 'welcome') this.navigateTo('welcome');
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
  
  private setState(newState: Partial<AppControllerState>): void {
    // Determine if a redraw is actually needed by comparing new vs old state values for relevant properties
    let changed = false;
    for (const key in newState) {
        if (Object.prototype.hasOwnProperty.call(newState, key)) {
            if (this.state[key as keyof AppControllerState] !== newState[key as keyof AppControllerState]) {
                changed = true;
                break;
            }
        }
    }
    this.state = { ...this.state, ...newState };
    if (changed) {
        this.requestGlobalRedraw();
    }
  }

  public destroy(): void {
    if (this.unsubscribeFromLangChange) {
      this.unsubscribeFromLangChange();
      this.unsubscribeFromLangChange = null;
    }
    if (this.unsubscribeFromAuthChange) {
      this.unsubscribeFromAuthChange();
      this.unsubscribeFromAuthChange = null;
    }
    window.removeEventListener('hashchange', this.handleHashChange.bind(this));

    if (this.activePageController && typeof this.activePageController.destroy === 'function') {
      this.activePageController.destroy();
    }
    if (this.analysisControllerInstance && typeof this.analysisControllerInstance.destroy === 'function') {
        this.analysisControllerInstance.destroy();
    }
    logger.info('[AppController] Destroyed.');
  }
}
