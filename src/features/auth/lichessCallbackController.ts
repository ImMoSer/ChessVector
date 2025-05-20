// src/features/auth/lichessCallbackController.ts
import { AuthService } from '../../core/auth.service';
import logger from '../../utils/logger';
import { t } from '../../core/i18n.service';
import type { AppController } from '../../AppController'; // Для редиректа

export interface LichessCallbackControllerState {
  isProcessing: boolean;
  message: string;
  errorMessage: string | null;
  isAuthenticated: boolean;
}

export class LichessCallbackController {
  public state: LichessCallbackControllerState;
  private authService: typeof AuthService;
  private appController: AppController;
  private unsubscribeFromAuthChanges: (() => void) | null = null;
  private requestGlobalRedraw: () => void;

  constructor(
    authService: typeof AuthService,
    appController: AppController,
    requestGlobalRedraw: () => void
  ) {
    this.authService = authService;
    this.appController = appController;
    this.requestGlobalRedraw = requestGlobalRedraw;

    const currentAuthState = this.authService.getState();
    this.state = {
      isProcessing: true,
      message: t('lichessCallback.processing'),
      errorMessage: currentAuthState.error,
      isAuthenticated: currentAuthState.isAuthenticated,
    };

    this.unsubscribeFromAuthChanges = this.authService.subscribe(() => this.onAuthStateChanged());
    logger.info('[LichessCallbackController] Initialized');
  }

  private onAuthStateChanged(): void {
    const currentAuthState = this.authService.getState();
    let needsRedraw = false;

    if (this.state.isProcessing !== currentAuthState.isProcessing) {
      this.state.isProcessing = currentAuthState.isProcessing;
      needsRedraw = true;
    }
    if (this.state.errorMessage !== currentAuthState.error) {
      this.state.errorMessage = currentAuthState.error;
      needsRedraw = true;
    }
    if (this.state.isAuthenticated !== currentAuthState.isAuthenticated) {
        this.state.isAuthenticated = currentAuthState.isAuthenticated;
        needsRedraw = true;
    }

    if (needsRedraw) {
      logger.debug('[LichessCallbackController] Auth state changed, requesting redraw.', this.state);
      this.requestGlobalRedraw();
    }
  }

  public async processCallback(): Promise<void> {
    logger.info('[LichessCallbackController] Starting to process Lichess callback...');
    this.setState({
      isProcessing: true,
      message: t('lichessCallback.processing'),
      errorMessage: null,
    });

    await this.authService.handleCallback();

    const finalAuthState = this.authService.getState();
    if (finalAuthState.isAuthenticated) {
      this.setState({
        isProcessing: false,
        message: t('lichessCallback.success'),
        errorMessage: null,
        isAuthenticated: true,
      });
      logger.info('[LichessCallbackController] Callback processed successfully. User authenticated.');
      
      // Очищаем URL от code и state перед редиректом
      const cleanUrl = window.location.pathname; // Оставляем только путь, без query params и hash
      window.history.replaceState({}, document.title, cleanUrl);
      logger.info(`[LichessCallbackController] URL cleaned to: ${cleanUrl}`);

      this.appController.navigateTo('finishHim'); // Теперь редирект на чистый URL + новый хэш
    } else {
      this.setState({
        isProcessing: false,
        message: t('lichessCallback.failure'),
        errorMessage: finalAuthState.error || t('lichessCallback.unknownError'),
        isAuthenticated: false,
      });
      logger.error(`[LichessCallbackController] Callback processing failed. Error: ${finalAuthState.error}`);
      // Очищаем URL от code и state даже в случае ошибки, чтобы они не оставались висеть
      const cleanUrlOnError = window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrlOnError);
      logger.info(`[LichessCallbackController] URL cleaned on error to: ${cleanUrlOnError}`);
      // Можно добавить редирект на 'welcome' или оставить пользователя здесь для просмотра ошибки
      // this.appController.navigateTo('welcome');
    }
  }

  private setState(newState: Partial<LichessCallbackControllerState>): void {
    this.state = { ...this.state, ...newState };
    this.requestGlobalRedraw();
  }

  public updateLocalizedTexts(): void {
    if (this.state.isProcessing) {
        this.state.message = t('lichessCallback.processing');
    } else if (this.state.isAuthenticated) {
        this.state.message = t('lichessCallback.success');
    } else {
        this.state.message = t('lichessCallback.failure');
        if (this.state.errorMessage && !Object.values(t('lichessCallback')).includes(this.state.errorMessage)) {
            // Не перезаписываем кастомные ошибки
        } else if (!this.state.errorMessage) {
             this.state.errorMessage = t('lichessCallback.unknownError');
        }
    }
  }

  public destroy(): void {
    if (this.unsubscribeFromAuthChanges) {
      this.unsubscribeFromAuthChanges();
      this.unsubscribeFromAuthChanges = null;
    }
    logger.info('[LichessCallbackController] Destroyed.');
  }
}
