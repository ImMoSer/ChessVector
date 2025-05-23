// src/AppController.ts
import logger from './utils/logger';
import type { ChessboardService } from './core/chessboard.service';
import type { StockfishService } from './core/stockfish.service';
import { type WebhookServiceController } from './core/webhook.service';
import { BoardHandler } from './core/boardHandler';
import { PgnService } from './core/pgn.service';
import { AnalysisService } from './core/analysis.service';
import { AnalysisController } from './features/analysis/analysisController';
import { subscribeToLangChange, getCurrentLang } from './core/i18n.service';
import { FinishHimController } from './features/finishHim/finishHimController';
import { WelcomeController } from './features/welcome/welcomeController';
import { AuthService, type UserSessionProfile, type SubscriptionTier } from './core/auth.service';
import { ClubPageController } from './features/clubPage/ClubPageController';
import { RecordsPageController } from './features/recordsPage/RecordsPageController';
import { UserCabinetController } from './features/userCabinet/UserCabinetController';
import { PlayFromFenController } from './features/playFromFen/PlayFromFenController';

export type AppPage = 'welcome' | 'finishHim' | 'clubPage' | 'recordsPage' | 'userCabinet' | 'playFromFen';

export interface AppServices {
  authService: typeof AuthService;
  chessboardService: ChessboardService;
  stockfishService: StockfishService;
  webhookService: WebhookServiceController;
  analysisService: AnalysisService;
  logger: typeof logger;
  appController: AppController;
}

interface AppControllerState {
  currentPage: AppPage;
  currentClubId: string | null;
  // currentFenForPlay: string | null; // Удалено, так как PlayFromFenController управляет своим FEN
  isNavExpanded: boolean;
  isPortraitMode: boolean;
  currentUser: UserSessionProfile | null;
  isLoadingAuth: boolean;
  isModalVisible: boolean;
  modalMessage: string | null;
}

type ActivePageController = WelcomeController | FinishHimController | ClubPageController | RecordsPageController | UserCabinetController | PlayFromFenController | null;

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
  private webhookServiceInstance: WebhookServiceController;
  private pgnServiceInstance: typeof PgnService;


  private unsubscribeFromLangChange: (() => void) | null = null;
  private unsubscribeFromAuthChange: (() => void) | null = null;

  constructor(
    globalServices: {
      chessboardService: ChessboardService;
      stockfishService: StockfishService;
      webhookService: WebhookServiceController;
      logger: typeof logger;
    },
    requestGlobalRedraw: () => void
  ) {
    this.authServiceInstance = AuthService;
    this.webhookServiceInstance = globalServices.webhookService;
    this.analysisServiceInstance = new AnalysisService(globalServices.stockfishService);
    this.pgnServiceInstance = PgnService;


    this.services = {
      chessboardService: globalServices.chessboardService,
      stockfishService: globalServices.stockfishService,
      webhookService: this.webhookServiceInstance,
      logger: globalServices.logger,
      authService: this.authServiceInstance,
      analysisService: this.analysisServiceInstance,
      appController: this,
    };
    this.requestGlobalRedraw = requestGlobalRedraw;

    const savedVhPreference = localStorage.getItem('userPreferredBoardSizeVh');
    this.userPreferredBoardSizeVh = savedVhPreference ? parseFloat(savedVhPreference) : DEFAULT_BOARD_VH;
    this.userPreferredBoardSizeVh = Math.max(BOARD_MIN_VH, Math.min(BOARD_MAX_VH, this.userPreferredBoardSizeVh));

    this.state = {
      currentPage: 'welcome',
      currentClubId: null,
      // currentFenForPlay: null, // Удалено
      isNavExpanded: false,
      isPortraitMode: window.matchMedia('(orientation: portrait)').matches,
      currentUser: null,
      isLoadingAuth: true,
      isModalVisible: false,
      modalMessage: null,
    };

    this.unsubscribeFromLangChange = subscribeToLangChange(() => {
      logger.info('[AppController] Language changed, requesting global redraw.');
      this.requestGlobalRedraw();
    });

    this.unsubscribeFromAuthChange = this.authServiceInstance.subscribe(() => {
      logger.info('[AppController] Auth state changed via subscription.');
      const authState = this.authServiceInstance.getState();
      
      const prevUserProfileId = this.state.currentUser?.id;
      const prevIsLoadingAuth = this.state.isLoadingAuth;
      const prevFollowClubs = JSON.stringify(this.state.currentUser?.follow_clubs);

      this.state.currentUser = authState.userProfile;
      this.state.isLoadingAuth = authState.isProcessing;

      if (
          prevUserProfileId !== authState.userProfile?.id ||
          prevIsLoadingAuth !== authState.isProcessing ||
          JSON.stringify(authState.userProfile?.follow_clubs) !== prevFollowClubs
      ) {
          this.requestGlobalRedraw();
      }

      if (!this._isInitializing && !authState.isProcessing && !authState.isAuthenticated && this.state.currentPage !== 'welcome') {
          logger.info('[AppController Subscriber] Post-init: User logged out or session expired, navigating to welcome.');
          this.navigateTo('welcome'); 
      }
    });

    logger.info(`[AppController] Initialized. Current lang: ${getCurrentLang()}`);
  }

  private _isInitializing: boolean = true;

  public async initializeApp(): Promise<void> {
    this._isInitializing = true;
    logger.info(`[AppController] Initializing app & authentication...`);
    this.setState({ isLoadingAuth: true });

    window.addEventListener('hashchange', this.handleHashChange.bind(this));

    const authCallbackProcessed = await this.authServiceInstance.handleAuthentication();
    if (!this.authServiceInstance.getIsProcessing() && this.state.isLoadingAuth){
        this.setState({ isLoadingAuth: false });
    }

    if (authCallbackProcessed) {
        const isAuthenticated = this.authServiceInstance.getIsAuthenticated();
        const targetPage = isAuthenticated ? 'finishHim' : 'welcome';
        logger.info(`[AppController] Auth callback processed. Navigating to default after auth: ${targetPage}`);
        this.navigateTo(targetPage, true, null);
    } else {
        logger.info(`[AppController] No auth callback. Processing current hash for initial navigation.`);
        this.handleHashChange();

        if (!this.activePageController) {
            logger.info(`[AppController initializeApp] No active controller after hash change. Loading controller for current page: ${this.state.currentPage}`);
            this.loadPageController(this.state.currentPage, this.state.currentClubId);
        }
    }

    logger.info(`[AppController] App initialization sequence complete.`);
    this._calculateAndSetBoardSize();
    this._isInitializing = false;
  }

  private handleHashChange(): void {
    const rawHash = window.location.hash.slice(1);
    logger.info(`[AppController] Hash changed. Raw hash: "${rawHash}"`);

    const cleanHash = rawHash.startsWith('/') ? rawHash.slice(1) : rawHash;
    logger.info(`[AppController] Cleaned hash for parsing: "${cleanHash}"`);

    let newPageFromHash: AppPage = 'welcome';
    let clubIdFromHash: string | null = null;
    // let fenFromHash: string | null = null; // Удалено, FEN из URL больше не обрабатывается здесь

    if (cleanHash.startsWith('clubs/')) {
        const parts = cleanHash.split('/');
        if (parts.length === 2 && parts[1]) { 
            clubIdFromHash = parts[1];
            newPageFromHash = 'clubPage';
            logger.info(`[AppController] Parsed club page from hash. Club ID: ${clubIdFromHash}`);
        } else {
            logger.warn(`[AppController] Invalid club page hash format: "${cleanHash}". Defaulting.`);
            newPageFromHash = this.authServiceInstance.getIsAuthenticated() ? 'finishHim' : 'welcome';
        }
    } else if (cleanHash === 'playFromFen') { // Просто проверяем маршрут, без FEN
        newPageFromHash = 'playFromFen';
        logger.info(`[AppController] Parsed playFromFen page from hash.`);
    } else if (cleanHash === 'records') {
        newPageFromHash = 'recordsPage';
        logger.info(`[AppController] Parsed records page from hash: ${newPageFromHash}`);
    } else if (validAppPages.includes(cleanHash as AppPage) && cleanHash !== 'userCabinet') { 
        newPageFromHash = cleanHash as AppPage;
        logger.info(`[AppController] Parsed standard page from hash: ${newPageFromHash}`);
    } else if (cleanHash === '') {
        newPageFromHash = this.authServiceInstance.getIsAuthenticated() ? 'finishHim' : 'welcome';
        logger.info(`[AppController] Empty hash. Defaulting to: ${newPageFromHash}`);
    } else {
        logger.warn(`[AppController] Unrecognized hash: "${cleanHash}". Defaulting.`);
        newPageFromHash = this.authServiceInstance.getIsAuthenticated() ? 'finishHim' : 'welcome';
    }

    if (newPageFromHash !== this.state.currentPage || 
        (newPageFromHash === 'clubPage' && clubIdFromHash !== this.state.currentClubId)) {
        // FEN больше не сравнивается здесь
        logger.info(`[AppController handleHashChange] Navigating due to hash/state mismatch. New page: ${newPageFromHash}, Club ID: ${clubIdFromHash}`);
        this.navigateTo(newPageFromHash, false, clubIdFromHash); 
    } else {
        logger.info(`[AppController handleHashChange] Hash matches current state or no navigation needed. Page: ${this.state.currentPage}, Club ID: ${this.state.currentClubId}`);
        if (!this.activePageController) {
            this.loadPageController(this.state.currentPage, this.state.currentClubId);
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

    if (this.state.isPortraitMode || !['finishHim', 'playFromFen'].includes(this.state.currentPage)) {
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

    logger.debug(`[AppController _calc] Final Board Size: ${finalBoardSizePx.toFixed(2)}px -> ${finalBoardSizeVh.toFixed(2)}vh. AvailableWidth: ${availableWidthForCenterPx.toFixed(2)}px. Page: ${this.state.currentPage}`);
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

  // fenArg удален из параметров navigateTo и _updateBrowserHash
  public navigateTo(page: AppPage, updateHash: boolean = true, clubIdArg: string | null = null): void {
    const isAuthenticated = this.authServiceInstance.getIsAuthenticated();
    const userTier = this.authServiceInstance.getUserSubscriptionTier();

    logger.info(`[AppController navigateTo] Attempting navigation. Requested: ${page}${clubIdArg ? ` (Club ID: ${clubIdArg})` : ''}. Current: ${this.state.currentPage} (Club ID: ${this.state.currentClubId}). Auth: ${isAuthenticated}, Tier: ${userTier}`);
    
    if (this.state.isLoadingAuth && !this._isInitializing && page !== this.state.currentPage) {
        logger.warn(`[AppController navigateTo] Navigation to ${page} blocked: authentication is processing, and not initial load.`);
        return;
    }

    let targetPage = page;
    let targetClubId = clubIdArg;

    if (page === 'clubPage') {
        if (!clubIdArg) { 
            logger.warn('[AppController navigateTo] Club page navigation attempted without clubId. Redirecting to welcome.');
            targetPage = 'welcome';
            targetClubId = null; 
        }
    } else if (page === 'playFromFen') {
        // FEN больше не передается здесь
        targetClubId = null;
    } else if (page === 'userCabinet') {
        if (!isAuthenticated) {
            logger.warn('[AppController navigateTo] Access to userCabinet denied: not authenticated. Redirecting to welcome.');
            targetPage = 'welcome';
        }
        targetClubId = null; 
    } else if (page === 'finishHim') {
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
      targetClubId = null; 
    } else if (page === 'welcome' && isAuthenticated && !this._isInitializing) {
        logger.info('[AppController navigateTo] Authenticated user attempting to navigate to welcome post-init. Redirecting to finishHim.');
        targetPage = 'finishHim';
        targetClubId = null;
    } else {
        targetClubId = null;
    }

    if (this.state.currentPage === targetPage && 
        this.state.currentClubId === targetClubId &&
        this.activePageController) {
      logger.info(`[AppController navigateTo] Already on target page/state: ${targetPage}. No navigation needed.`);
      if (this.state.isPortraitMode && this.state.isNavExpanded) {
        this.toggleNav(); 
      } else {
        this.requestGlobalRedraw(); 
      }
      if (updateHash) this._updateBrowserHash(targetPage, targetClubId);
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
    this.state.currentClubId = targetClubId;
    // this.state.currentFenForPlay = null; // FEN больше не хранится здесь

    if (updateHash) this._updateBrowserHash(targetPage, targetClubId);

    this.loadPageController(targetPage, targetClubId);

    if (this.state.isPortraitMode && this.state.isNavExpanded) {
      this.state.isNavExpanded = false; 
    }
  }

  // fen: string | null удален из параметров _updateBrowserHash
  private _updateBrowserHash(page: AppPage, clubId: string | null): void {
    let newHashTarget = '';
    if (page === 'clubPage' && clubId) {
        newHashTarget = `clubs/${clubId}`;
    } else if (page === 'playFromFen') { // FEN больше не добавляется в хеш
        newHashTarget = `playFromFen`;
    } else if (page === 'recordsPage') {
        newHashTarget = 'records';
    } else if (page !== 'userCabinet' && page !== 'welcome') {
        newHashTarget = page;
    }

    const currentCleanHash = window.location.hash.slice(1).startsWith('/') ? window.location.hash.slice(2) : window.location.hash.slice(1);
    if (currentCleanHash !== newHashTarget) {
        window.location.hash = newHashTarget;
        logger.info(`[AppController _updateBrowserHash] Hash updated to: #${newHashTarget}`);
    }
  }

  // fenForPlay: string | null удален из параметров loadPageController
  private loadPageController(page: AppPage, clubId: string | null = null): void {
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
    
    if (page === 'finishHim' || page === 'playFromFen') {
        boardHandlerForPage = new BoardHandler(
            this.services.chessboardService,
            this.requestGlobalRedraw
        );
        this.analysisControllerInstance = new AnalysisController(
            this.services.analysisService,
            boardHandlerForPage,
            this.pgnServiceInstance, 
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
            if (this.state.currentPage !== 'welcome') this.navigateTo('welcome'); 
            else logger.error("[AppController] Already on welcome, cannot fallback further from FinishHim init error.");
            return; 
        }
        this.activePageController = new FinishHimController(
          this.services.chessboardService,
          boardHandlerForPage, 
          this.authServiceInstance,
          this.webhookServiceInstance,
          this.services.stockfishService,
          this.analysisControllerInstance, 
          this.requestGlobalRedraw
        );
        if (typeof (this.activePageController as FinishHimController).initializeGame === 'function') {
            (this.activePageController as FinishHimController).initializeGame();
        }
        break;
      case 'playFromFen':
        if (!boardHandlerForPage || !this.analysisControllerInstance) {
            logger.error("[AppController] Critical error: BoardHandler or AnalysisController not initialized for PlayFromFen page.");
            if (this.state.currentPage !== 'welcome') this.navigateTo('welcome');
            else logger.error("[AppController] Already on welcome, cannot fallback further from PlayFromFen init error.");
            return;
        }
        this.activePageController = new PlayFromFenController(
            this.services.chessboardService,
            boardHandlerForPage,
            this.authServiceInstance,
            this.webhookServiceInstance,
            this.services.stockfishService,
            this.analysisControllerInstance,
            this.pgnServiceInstance,
            this.requestGlobalRedraw
            // initialFenFromUrl удален
        );
        // initializeGameWithFen вызовется из конструктора PlayFromFenController через handleRequestNewFenFromServer
        break;
      case 'clubPage':
        if (clubId) {
           this.activePageController = new ClubPageController(clubId, this.services, this.requestGlobalRedraw);
           (this.activePageController as ClubPageController).initializePage();
        } else {
            logger.error("[AppController] ClubId missing for clubPage. Redirecting to welcome.");
            if (this.state.currentPage !== 'welcome') this.navigateTo('welcome');
        }
        break;
      case 'recordsPage':
        this.activePageController = new RecordsPageController(this.services, this.requestGlobalRedraw);
        (this.activePageController as RecordsPageController).initializePage();
        break;
      case 'userCabinet': 
        this.activePageController = new UserCabinetController(this.services, this.requestGlobalRedraw);
        (this.activePageController as UserCabinetController).initializePage();
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
      if (this.state.isNavExpanded) {
        this.state.isNavExpanded = false;
      }
      needsRedraw = true;
    }

    this._calculateAndSetBoardSize();

    if (needsRedraw) {
        this.requestGlobalRedraw();
    }
  }
  
  public showModal(message: string): void {
    this.setState({ isModalVisible: true, modalMessage: message });
    logger.info(`[AppController] Showing modal with message: "${message}"`);
  }

  public hideModal(): void {
    this.setState({ isModalVisible: false, modalMessage: null });
    logger.info(`[AppController] Hiding modal.`);
  }

  private setState(newState: Partial<AppControllerState>): void {
    let changed = false;
    for (const key in newState) {
        if (Object.prototype.hasOwnProperty.call(newState, key)) {
            const typedKey = key as keyof AppControllerState;
            if (this.state[typedKey] !== newState[typedKey]) {
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

const validAppPages: AppPage[] = ['welcome', 'finishHim', 'clubPage', 'recordsPage', 'userCabinet', 'playFromFen'];
