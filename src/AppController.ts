// src/AppController.ts
import logger from './utils/logger';
import type { ChessboardService } from './core/chessboard.service';
import type { StockfishService } from './core/stockfish.service';
import { WebhookService } from './core/webhook.service';
import { BoardHandler } from './core/boardHandler';
import { PgnService } from './core/pgn.service';
import { AnalysisService } from './core/analysis.service';
import { AnalysisController } from './features/analysis/analysisController';
import { subscribeToLangChange, getCurrentLang } from './core/i18n.service'; // Удален импорт 't'
import { FinishHimController } from './features/finishHim/finishHimController';
import { WelcomeController } from './features/welcome/welcomeController';
import { AuthService, type UserSessionProfile, type SubscriptionTier } from './core/auth.service';
import { ClubPageController } from './features/clubPage/ClubPageController';

export type AppPage = 'welcome' | 'finishHim' | 'clubPage';

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
  currentClubId: string | null;
  isNavExpanded: boolean;
  isPortraitMode: boolean;
  currentUser: UserSessionProfile | null;
  isLoadingAuth: boolean;
}

type ActivePageController = WelcomeController | FinishHimController | ClubPageController | null;

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
  private webhookServiceInstance: WebhookService;

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
    this.webhookServiceInstance = globalServices.webhookService;
    this.analysisServiceInstance = new AnalysisService(globalServices.stockfishService);

    this.services = {
      chessboardService: globalServices.chessboardService,
      stockfishService: globalServices.stockfishService,
      webhookService: this.webhookServiceInstance,
      logger: globalServices.logger,
      authService: this.authServiceInstance,
      analysisService: this.analysisServiceInstance,
    };
    this.requestGlobalRedraw = requestGlobalRedraw;

    const savedVhPreference = localStorage.getItem('userPreferredBoardSizeVh');
    this.userPreferredBoardSizeVh = savedVhPreference ? parseFloat(savedVhPreference) : DEFAULT_BOARD_VH;
    this.userPreferredBoardSizeVh = Math.max(BOARD_MIN_VH, Math.min(BOARD_MAX_VH, this.userPreferredBoardSizeVh));

    this.state = {
      currentPage: 'welcome', // Изначально 'welcome'
      currentClubId: null,
      isNavExpanded: false,
      isPortraitMode: window.matchMedia('(orientation: portrait)').matches,
      currentUser: null,
      isLoadingAuth: true,
    };

    this.unsubscribeFromLangChange = subscribeToLangChange(() => {
      logger.info('[AppController] Language changed, requesting global redraw.');
      this.requestGlobalRedraw();
    });

    this.unsubscribeFromAuthChange = this.authServiceInstance.subscribe(() => {
      logger.info('[AppController] Auth state changed via subscription (simplified).');
      const authState = this.authServiceInstance.getState();
      
      const prevUserProfileId = this.state.currentUser?.id;
      const prevIsLoadingAuth = this.state.isLoadingAuth;

      this.state.currentUser = authState.userProfile;
      this.state.isLoadingAuth = authState.isProcessing;

      if (prevUserProfileId !== authState.userProfile?.id || prevIsLoadingAuth !== authState.isProcessing) {
          this.requestGlobalRedraw();
      }

      // Если пользователь разлогинился (не в процессе инициализации) и он не на странице welcome, перенаправляем
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
    this.setState({ isLoadingAuth: true }); // Устанавливаем isLoadingAuth в true и вызываем redraw

    window.addEventListener('hashchange', this.handleHashChange.bind(this));

    // Сначала обрабатываем аутентификацию
    const authCallbackProcessed = await this.authServiceInstance.handleAuthentication();
    this.setState({ isLoadingAuth: false }); // После обработки аутентификации, isLoadingAuth = false

    if (authCallbackProcessed) {
        // Если был коллбэк (например, после логина), определяем, куда перенаправить
        const isAuthenticated = this.authServiceInstance.getIsAuthenticated();
        const targetPage = isAuthenticated ? 'finishHim' : 'welcome';
        logger.info(`[AppController] Auth callback processed. Navigating to default after auth: ${targetPage}`);
        this.navigateTo(targetPage, true, null); // navigateTo вызовет loadPageController
    } else {
        // Если не было коллбэка, обрабатываем текущий хэш для определения начальной страницы
        logger.info(`[AppController] No auth callback. Processing current hash for initial navigation.`);
        this.handleHashChange(); // Этот вызов установит this.state.currentPage

        // ---- ИЗМЕНЕНИЕ ЗДЕСЬ ----
        // Если после handleHashChange контроллер все еще не загружен (например, при первой загрузке на #welcome),
        // принудительно загружаем контроллер для текущей страницы.
        if (!this.activePageController) {
            logger.info(`[AppController initializeApp] No active controller after hash change. Loading controller for current page: ${this.state.currentPage}`);
            this.loadPageController(this.state.currentPage, this.state.currentClubId);
        }
        // ---- КОНЕЦ ИЗМЕНЕНИЯ ----
    }

    logger.info(`[AppController] App initialization sequence complete.`);
    this._calculateAndSetBoardSize(); // Рассчитываем размер доски
    this._isInitializing = false; // Завершаем инициализацию
  }


  private handleHashChange(): void {
    const rawHash = window.location.hash.slice(1); // Gets content after #
    logger.info(`[AppController] Hash changed. Raw hash: "${rawHash}"`);

    // Remove leading slash if present (e.g. from "#/clubs/id" to "clubs/id")
    const cleanHash = rawHash.startsWith('/') ? rawHash.slice(1) : rawHash;
    logger.info(`[AppController] Cleaned hash for parsing: "${cleanHash}"`);

    let newPageFromHash: AppPage = 'welcome'; // По умолчанию 'welcome'
    let clubIdFromHash: string | null = null;

    if (cleanHash.startsWith('clubs/')) {
        const parts = cleanHash.split('/'); // e.g., "clubs/club123" -> ["clubs", "club123"]
        if (parts.length === 2 && parts[1]) {
            clubIdFromHash = parts[1];
            newPageFromHash = 'clubPage';
            logger.info(`[AppController] Parsed club page from hash. Club ID: ${clubIdFromHash}`);
        } else {
            logger.warn(`[AppController] Invalid club page hash format: "${cleanHash}". Defaulting.`);
            // Если формат неверный, решаем, куда направить в зависимости от аутентификации
            newPageFromHash = this.authServiceInstance.getIsAuthenticated() ? 'finishHim' : 'welcome';
        }
    } else if (validAppPages.includes(cleanHash as AppPage)) {
        newPageFromHash = cleanHash as AppPage;
        logger.info(`[AppController] Parsed standard page from hash: ${newPageFromHash}`);
    } else if (cleanHash === '') {
        // Пустой хэш (например, просто example.com/# или example.com/)
        // Направляем на 'finishHim' если аутентифицирован, иначе на 'welcome'
        newPageFromHash = this.authServiceInstance.getIsAuthenticated() ? 'finishHim' : 'welcome';
        logger.info(`[AppController] Empty hash. Defaulting to: ${newPageFromHash}`);
    } else {
        // Нераспознанный хэш
        logger.warn(`[AppController] Unrecognized hash: "${cleanHash}". Defaulting.`);
        newPageFromHash = this.authServiceInstance.getIsAuthenticated() ? 'finishHim' : 'welcome';
    }

    // Переходим на новую страницу, только если она отличается от текущей ИЛИ если это clubPage и ID клуба изменился
    if (newPageFromHash !== this.state.currentPage || (newPageFromHash === 'clubPage' && clubIdFromHash !== this.state.currentClubId)) {
        logger.info(`[AppController handleHashChange] Navigating due to hash change or clubId mismatch. New page: ${newPageFromHash}, Club ID: ${clubIdFromHash}`);
        this.navigateTo(newPageFromHash, false, clubIdFromHash); // false, т.к. хэш уже изменен браузером
    } else {
        logger.info(`[AppController handleHashChange] Hash matches current state or no navigation needed. Page: ${this.state.currentPage}, Club ID: ${this.state.currentClubId}`);
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
      this.requestGlobalRedraw(); // Запрос на перерисовку, так как размер доски мог измениться
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

    // Получаем ширину панелей и отступы из CSS переменных
    const leftPanelWidthPx = this._getCssVariableInPixels('--panel-width');
    const rightPanelWidthPx = this._getCssVariableInPixels('--panel-width'); // Предполагаем, что они одинаковы
    const panelGapPx = this._getCssVariableInPixels('--panel-gap');

    let availableWidthForCenterPx: number;

    if (this.state.isPortraitMode) {
      // В портретном режиме панели могут быть скрыты или расположены иначе,
      // центральная панель может занимать почти всю ширину
      availableWidthForCenterPx = viewportWidthPx - (2 * panelGapPx); // Учитываем только внешние отступы
    } else {
      // В альбомном режиме учитываем боковые панели, если они видимы
      // Проверяем, видимы ли панели (это упрощенная проверка, реальная видимость может зависеть от CSS display)
      const actualLeftPanelWidth = document.getElementById('left-panel')?.offsetParent !== null ? leftPanelWidthPx : 0;
      const actualRightPanelWidth = document.getElementById('right-panel')?.offsetParent !== null ? rightPanelWidthPx : 0;
      
      let numberOfGaps = 0;
      if (actualLeftPanelWidth > 0) numberOfGaps++;
      if (actualRightPanelWidth > 0) numberOfGaps++;
      
      const totalSidePanelsWidth = actualLeftPanelWidth + actualRightPanelWidth;
      const totalGapsWidth = numberOfGaps * panelGapPx;
      const outerPagePadding = 2 * panelGapPx; // Внешние отступы от краев страницы

      availableWidthForCenterPx = viewportWidthPx - totalSidePanelsWidth - totalGapsWidth - outerPagePadding;
    }

    // Минимальная практическая ширина для доски, чтобы избежать слишком маленьких размеров
    const minPracticalWidthPx = 50; 
    availableWidthForCenterPx = Math.max(availableWidthForCenterPx, minPracticalWidthPx);

    // Размер доски не может быть больше доступной ширины и не меньше минимально допустимого размера по Vh
    let finalBoardSizePx = Math.min(currentBoardTargetSizePx, availableWidthForCenterPx);
    finalBoardSizePx = Math.max(finalBoardSizePx, minBoardSizeBasedOnMinVhPx);

    // Конвертируем обратно в Vh для установки CSS переменной
    const finalBoardSizeVh = (finalBoardSizePx / viewportHeightPx) * 100;

    logger.debug(`[AppController _calc] Final Board Size: ${finalBoardSizePx.toFixed(2)}px -> ${finalBoardSizeVh.toFixed(2)}vh. AvailableWidth: ${availableWidthForCenterPx.toFixed(2)}px`);
    document.documentElement.style.setProperty('--calculated-board-size-vh', `${finalBoardSizeVh.toFixed(3)}vh`);

    // Диспетчиризация события, если доска или другие компоненты должны на это реагировать
    const resizeEvent = new CustomEvent('centerPanelResized', {
        detail: {
            widthPx: finalBoardSizePx,
            heightPx: finalBoardSizePx, // Предполагаем квадратную доску
            widthVh: finalBoardSizeVh,
            heightVh: finalBoardSizeVh
        }
    });
    window.dispatchEvent(resizeEvent);
  }


  public navigateTo(page: AppPage, updateHash: boolean = true, clubId: string | null = null): void {
    const isAuthenticated = this.authServiceInstance.getIsAuthenticated();
    const userTier = this.authServiceInstance.getUserSubscriptionTier();

    logger.info(`[AppController navigateTo] Attempting navigation. Requested: ${page}${clubId ? ` (Club ID: ${clubId})` : ''}. Current: ${this.state.currentPage} (Club ID: ${this.state.currentClubId}). Auth: ${isAuthenticated}, Tier: ${userTier}`);
    
    // Блокируем навигацию, если аутентификация еще в процессе (и это не начальная загрузка)
    // и если мы пытаемся перейти на другую страницу.
    if (this.state.isLoadingAuth && !this._isInitializing && page !== this.state.currentPage) {
        logger.warn(`[AppController navigateTo] Navigation to ${page} blocked: authentication is processing, and not initial load.`);
        return;
    }

    let targetPage = page;
    let targetClubId = clubId;

    // Логика редиректов в зависимости от состояния аутентификации и страницы
    if (page === 'clubPage') {
        if (!clubId) {
            logger.warn('[AppController navigateTo] Club page navigation attempted without clubId. Redirecting to welcome.');
            targetPage = 'welcome';
            targetClubId = null;
        }
        // Дополнительных проверок аутентификации для clubPage здесь нет, т.к. она может быть публичной
    } else if (page === 'finishHim') {
      if (!isAuthenticated) {
        logger.warn('[AppController navigateTo] Access to finishHim denied: not authenticated. Redirecting to welcome.');
        targetPage = 'welcome';
        targetClubId = null;
      } else {
        // Проверка уровня подписки для доступа к finishHim
        const allowedTiersForFinishHim: SubscriptionTier[] = ['bronze', 'silver', 'gold', 'platinum']; // Пример
        if (!allowedTiersForFinishHim.includes(userTier)) {
          logger.warn(`[AppController navigateTo] Access to finishHim denied: tier ${userTier} not allowed. Redirecting to welcome.`);
          targetPage = 'welcome';
          targetClubId = null;
        }
      }
    } else if (page === 'welcome' && isAuthenticated && !this._isInitializing) { // Если аутентифицирован и пытается зайти на welcome (не при инициализации)
        logger.info('[AppController navigateTo] Authenticated user attempting to navigate to welcome post-init. Redirecting to finishHim.');
        targetPage = 'finishHim';
        targetClubId = null;
    }

    // Если мы уже на нужной странице с нужным clubId (если он есть) и контроллер активен
    if (this.state.currentPage === targetPage && this.state.currentClubId === targetClubId && this.activePageController) {
      logger.info(`[AppController navigateTo] Already on page: ${targetPage}${targetClubId ? ` (Club ID: ${targetClubId})` : ''}. Controller exists.`);
      // Если в портретном режиме открыто меню, закрываем его
      if (this.state.isPortraitMode && this.state.isNavExpanded) {
        this.toggleNav(); // toggleNav вызовет requestGlobalRedraw
      } else {
        this.requestGlobalRedraw(); // Просто перерисовываем, если нужно (например, обновить активную ссылку)
      }
      // Обновляем хэш, если это требуется и он отличается
      if (updateHash) {
          const newHashTarget = targetPage === 'clubPage' && targetClubId ? `clubs/${targetClubId}` : targetPage;
          if (window.location.hash.slice(1) !== newHashTarget) {
              window.location.hash = newHashTarget;
          }
      }
      return;
    }

    // Уничтожаем старый контроллер страницы, если он есть
    if (this.activePageController && typeof this.activePageController.destroy === 'function') {
      this.activePageController.destroy();
      this.activePageController = null;
    }
    // Также уничтожаем контроллер анализа, если он был связан со старой страницей
    if (this.analysisControllerInstance && typeof this.analysisControllerInstance.destroy === 'function') {
        this.analysisControllerInstance.destroy();
        this.analysisControllerInstance = null;
    }

    this.state.currentPage = targetPage;
    this.state.currentClubId = targetClubId;

    // Обновляем хэш в URL, если это требуется и он отличается
    if (updateHash) {
        const newHashTarget = targetPage === 'clubPage' && targetClubId ? `clubs/${targetClubId}` : targetPage;
        // Убираем ведущий слэш из текущего хэша для корректного сравнения, если он есть
        const currentCleanHash = window.location.hash.slice(1).startsWith('/') ? window.location.hash.slice(2) : window.location.hash.slice(1);
        if (currentCleanHash !== newHashTarget) {
            window.location.hash = newHashTarget;
        }
    }
    this.loadPageController(targetPage, targetClubId);

    // Если в портретном режиме открыто меню, закрываем его после навигации
    if (this.state.isPortraitMode && this.state.isNavExpanded) {
      this.state.isNavExpanded = false; // Закрываем меню, redraw будет вызван из loadPageController
    }
  }

  private loadPageController(page: AppPage, clubId: string | null = null): void {
    // Уничтожаем предыдущий активный контроллер страницы, если он существует
    if (this.activePageController && typeof this.activePageController.destroy === 'function') {
        this.activePageController.destroy();
    }
    this.activePageController = null; // Сбрасываем ссылку

    // Уничтожаем предыдущий контроллер анализа, если он существует
    if (this.analysisControllerInstance && typeof this.analysisControllerInstance.destroy === 'function') {
        this.analysisControllerInstance.destroy();
        this.analysisControllerInstance = null; // Сбрасываем ссылку
    }
    
    this._calculateAndSetBoardSize(); // Пересчитываем размер доски перед загрузкой новой страницы

    let boardHandlerForPage: BoardHandler | undefined;
    
    // BoardHandler и AnalysisController создаются только для страницы 'finishHim'
    if (page === 'finishHim') {
        boardHandlerForPage = new BoardHandler(
            this.services.chessboardService,
            this.requestGlobalRedraw // Передаем функцию для запроса перерисовки
        );
        this.analysisControllerInstance = new AnalysisController(
            this.services.analysisService,
            boardHandlerForPage, // Передаем новый BoardHandler
            PgnService,          // Передаем PgnService (синглтон)
            this.requestGlobalRedraw
        );
    }

    switch (page) {
      case 'welcome':
        this.activePageController = new WelcomeController(this.authServiceInstance, this.requestGlobalRedraw);
        break;
      case 'finishHim':
        if (!boardHandlerForPage || !this.analysisControllerInstance) {
            // Эта ситуация не должна произойти, если логика выше корректна
            logger.error("[AppController] Critical error: BoardHandler or AnalysisController not initialized for FinishHim page.");
            // Пытаемся безопасно вернуться на 'welcome'
            if (this.state.currentPage !== 'welcome') this.navigateTo('welcome');
            else logger.error("[AppController] Already on welcome, cannot fallback further from FinishHim init error.");
            return; // Прерываем выполнение, чтобы избежать дальнейших ошибок
        }
        this.activePageController = new FinishHimController(
          this.services.chessboardService,
          boardHandlerForPage, // Передаем созданный BoardHandler
          this.authServiceInstance,
          this.webhookServiceInstance,
          this.services.stockfishService,
          this.analysisControllerInstance, // Передаем созданный AnalysisController
          this.requestGlobalRedraw
        );
        // Инициализируем игру в контроллере FinishHim
        if (typeof (this.activePageController as FinishHimController).initializeGame === 'function') {
            (this.activePageController as FinishHimController).initializeGame();
        }
        break;
      case 'clubPage':
        if (clubId) {
           this.activePageController = new ClubPageController(clubId, this.services, this.requestGlobalRedraw);
           // Инициализируем данные для страницы клуба
           (this.activePageController as ClubPageController).initializePage();
        } else {
            logger.error("[AppController] ClubId missing for clubPage. Redirecting to welcome.");
            if (this.state.currentPage !== 'welcome') this.navigateTo('welcome');
        }
        break;
      default:
        // Обработка случая, когда страница неизвестна (для полноты TypeScript)
        const exhaustiveCheck: never = page; 
        logger.error(`[AppController] Unknown page in loadPageController: ${exhaustiveCheck}. Defaulting to welcome.`);
        if (this.state.currentPage !== 'welcome') this.navigateTo('welcome');
        return; // Прерываем, так как страница неизвестна
    }
    logger.info(`[AppController] Loaded controller for page: ${page}`, this.activePageController);
    this.requestGlobalRedraw(); // Запрашиваем перерисовку после загрузки контроллера
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
      // Если изменилась ориентация и меню было открыто, закрываем его
      if (this.state.isNavExpanded) {
        this.state.isNavExpanded = false;
      }
      needsRedraw = true;
    }

    // Пересчитываем размер доски при любом ресайзе
    this._calculateAndSetBoardSize();

    // Запрашиваем перерисовку, если она необходима (например, из-за смены ориентации)
    if (needsRedraw) {
        this.requestGlobalRedraw();
    }
  }
  
  private setState(newState: Partial<AppControllerState>): void {
    // Проверяем, изменилось ли что-то в состоянии
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

    // Обновляем состояние
    this.state = { ...this.state, ...newState };

    // Если были изменения, запрашиваем перерисовку
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

    // Уничтожаем активный контроллер страницы
    if (this.activePageController && typeof this.activePageController.destroy === 'function') {
      this.activePageController.destroy();
    }
    // Уничтожаем контроллер анализа
    if (this.analysisControllerInstance && typeof this.analysisControllerInstance.destroy === 'function') {
        this.analysisControllerInstance.destroy();
    }
    logger.info('[AppController] Destroyed.');
  }
}

// Вспомогательная константа для валидации страниц
const validAppPages: AppPage[] = ['welcome', 'finishHim', 'clubPage'];
