// src/AppController.ts
import logger from './utils/logger';
import type { ChessboardService } from './core/chessboard.service';
import type { StockfishService } from './core/stockfish.service';
import type { WebhookService } from './core/webhook.service';
import { BoardHandler } from './core/boardHandler';
import { PgnService } from './core/pgn.service';
import { AnalysisService } from './core/analysis.service';
import { AnalysisController } from './features/analysis/analysisController';
import { subscribeToLangChange, getCurrentLang } from './core/i18n.service'; // Added t
import { FinishHimController } from './features/finishHim/finishHimController';
import { WelcomeController } from './features/welcome/welcomeController';
// LichessCallbackController will be removed
import { AuthService, type UserSessionProfile, type SubscriptionTier } from './core/auth.service';


// AppPage type updated - lichessCallback is no longer a distinct page for routing
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
  isLoadingAuth: boolean; // To show a global loader during initial auth processing
}

// ActivePageController updated
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

    // Initial state, currentPage will be determined after auth handling
    this.state = {
      currentPage: 'welcome', // Default, will be updated
      isNavExpanded: false,
      isPortraitMode: window.matchMedia('(orientation: portrait)').matches,
      currentUser: null, // Will be set after auth handling
      isLoadingAuth: true, // Start in loading state for auth
    };

    this.unsubscribeFromLangChange = subscribeToLangChange(() => {
      logger.info('[AppController] Language changed, requesting global redraw.');
      this.requestGlobalRedraw();
    });

    this.unsubscribeFromAuthChange = this.authServiceInstance.subscribe(() => {
        logger.info('[AppController] Auth state changed via subscription.');
        const authState = this.authServiceInstance.getState();
        this.state.currentUser = authState.userProfile;
        this.state.isLoadingAuth = authState.isProcessing; // Reflect auth processing state

        // If auth is no longer processing, decide navigation
        if (!authState.isProcessing) {
            if (!authState.isAuthenticated && this.state.currentPage !== 'welcome') {
                logger.info('[AppController] User logged out or session expired, redirecting to welcome page.');
                this.navigateTo('welcome');
            } else if (authState.isAuthenticated && this.state.currentPage === 'welcome') {
                logger.info('[AppController] User authenticated, redirecting from welcome to finishHim.');
                this.navigateTo('finishHim');
            }
        }
        this.requestGlobalRedraw();
    });

    logger.info(`[AppController] Initialized. Current lang: ${getCurrentLang()}`);
  }

  public async initializeApp(): Promise<void> {
    logger.info(`[AppController] Initializing app & authentication...`);
    this.setState({ isLoadingAuth: true }); // Ensure loading state is active

    // AuthService.handleAuthentication() now processes callbacks and stored sessions
    const authCallbackProcessed = await this.authServiceInstance.handleAuthentication();
    const currentAuthState = this.authServiceInstance.getState();
    this.state.currentUser = currentAuthState.userProfile;
    this.setState({ isLoadingAuth: currentAuthState.isProcessing }); // Update loading state from AuthService

    let initialPageTarget: AppPage;
    const hash = window.location.hash.slice(1) as AppPage;

    if (authCallbackProcessed) {
        // If a callback was just processed, AuthService would have set isAuthenticated.
        // Navigate based on the new auth state.
        initialPageTarget = currentAuthState.isAuthenticated ? 'finishHim' : 'welcome';
        logger.info(`[AppController] Auth callback processed. New target: ${initialPageTarget}`);
    } else {
        // No callback, determine page based on current auth state and hash
        if (currentAuthState.isAuthenticated) {
            const validPagesAfterAuth: AppPage[] = ['finishHim']; // Only 'finishHim' if authenticated
            if (validPagesAfterAuth.includes(hash)) {
                initialPageTarget = hash;
            } else {
                initialPageTarget = 'finishHim';
            }
        } else {
            initialPageTarget = 'welcome'; // If not authenticated and no callback, always welcome
        }
        logger.info(`[AppController] No auth callback. Initial target based on stored session/hash: ${initialPageTarget}`);
    }
    
    this.state.currentPage = initialPageTarget;
    if (window.location.hash.slice(1) !== initialPageTarget) {
        window.location.hash = initialPageTarget; // Set hash if different
    }

    logger.info(`[AppController] App initialized. Current page target: ${this.state.currentPage}`);
    this._calculateAndSetBoardSize();
    this.loadPageController(this.state.currentPage); // Load controller for the determined page

    window.addEventListener('hashchange', this.handleHashChange.bind(this));
    // Initial redraw will be triggered by loadPageController or auth state changes
  }

  private handleHashChange(): void {
    const newPageFromHash = window.location.hash.slice(1) as AppPage;
    logger.info(`[AppController] Hash changed to: #${newPageFromHash}`);

    // No longer need to check for /login/callback path
    const validPages: AppPage[] = ['welcome', 'finishHim'];
    const isValidAppPage = validPages.includes(newPageFromHash);

    if (isValidAppPage && newPageFromHash !== this.state.currentPage) {
        this.navigateTo(newPageFromHash, false); 
    } else if (!isValidAppPage && newPageFromHash) {
        logger.warn(`[AppController] Invalid page in hash: #${newPageFromHash}. Redirecting to default.`);
        const defaultPage = this.authServiceInstance.getIsAuthenticated() ? 'finishHim' : 'welcome';
        this.navigateTo(defaultPage);
    } else if (!newPageFromHash) { // If hash is empty
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

    logger.info(`[AppController] Attempting navigation to: ${page}. Auth: ${isAuthenticated}, Tier: ${userTier}`);

    // Prevent navigation if auth is currently processing, unless it's an internal redirect post-auth
    if (this.state.isLoadingAuth && page !== this.state.currentPage) {
        logger.warn(`[AppController] Navigation to ${page} blocked: authentication is processing.`);
        // It might be better to queue this navigation or handle it once auth is done.
        // For now, we simply block to avoid race conditions.
        return;
    }

    if (page === 'finishHim') {
      if (!isAuthenticated) {
        logger.warn('[AppController] Access to finishHim denied: not authenticated. Redirecting to welcome.');
        this.state.currentPage = 'welcome'; // Set state before hash to avoid loop
        if (updateHash && window.location.hash.slice(1) !== 'welcome') window.location.hash = 'welcome';
        this.loadPageController('welcome');
        return;
      }
      // Tier check can remain if needed
      const allowedTiersForFinishHim: SubscriptionTier[] = ['bronze', 'silver', 'gold', 'platinum'];
      if (!allowedTiersForFinishHim.includes(userTier)) {
        logger.warn(`[AppController] Access to finishHim denied: tier ${userTier} not allowed. Redirecting to welcome.`);
        this.state.currentPage = 'welcome';
        if (updateHash && window.location.hash.slice(1) !== 'welcome') window.location.hash = 'welcome';
        this.loadPageController('welcome');
        return;
      }
    } else if (page === 'welcome' && isAuthenticated) {
        logger.info('[AppController] Authenticated user attempting to navigate to welcome. Redirecting to finishHim.');
        this.state.currentPage = 'finishHim';
        if (updateHash && window.location.hash.slice(1) !== 'finishHim') window.location.hash = 'finishHim';
        this.loadPageController('finishHim');
        return;
    }


    if (this.state.currentPage === page && this.activePageController) {
      logger.info(`[AppController] Already on page: ${page}`);
      if (this.state.isPortraitMode && this.state.isNavExpanded) {
        this.toggleNav();
      }
      this.requestGlobalRedraw(); // Ensure UI updates if only state like isNavExpanded changed
      return;
    }

    if (this.activePageController && typeof this.activePageController.destroy === 'function') {
      this.activePageController.destroy();
      this.activePageController = null; // Clear previous controller
    }
    if (this.analysisControllerInstance && typeof this.analysisControllerInstance.destroy === 'function') {
        this.analysisControllerInstance.destroy();
        this.analysisControllerInstance = null;
    }

    this.state.currentPage = page;
    if (updateHash && window.location.hash.slice(1) !== page) {
        window.location.hash = page;
    }
    this.loadPageController(page); // This will also trigger a redraw

    if (this.state.isPortraitMode && this.state.isNavExpanded) {
      this.state.isNavExpanded = false; // Close nav on navigation
      // loadPageController will call requestGlobalRedraw
    }
  }

  private loadPageController(page: AppPage): void {
    // Ensure previous controller is destroyed if any
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
      // 'lichessCallback' case removed
      case 'finishHim':
        if (!boardHandlerForPage || !this.analysisControllerInstance) {
            logger.error("[AppController] Critical error: BoardHandler or AnalysisController not initialized for FinishHim page.");
            this.navigateTo('welcome'); // Fallback to welcome on critical error
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
        // This should ideally not be reached if AppPage is correctly typed and handled
        const exhaustiveCheck: never = page;
        logger.error(`[AppController] Unknown page in loadPageController: ${exhaustiveCheck}. Defaulting to welcome.`);
        this.state.currentPage = 'welcome';
        if(window.location.hash.slice(1) !== 'welcome') window.location.hash = 'welcome';
        this.loadPageController('welcome'); // Recursive call, ensure it has a safe exit
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

    this._calculateAndSetBoardSize(); // This will dispatch 'centerPanelResized'
    if (needsRedraw) { // Redraw if orientation changed
        this.requestGlobalRedraw();
    }
  }
  
  private setState(newState: Partial<AppControllerState>): void {
    this.state = { ...this.state, ...newState };
    this.requestGlobalRedraw();
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
    // analysisServiceInstance is typically not destroyed here unless AppController itself is destroyed permanently
    logger.info('[AppController] Destroyed.');
  }
}
