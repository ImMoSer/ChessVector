// src/features/welcome/welcomeController.ts
import { AuthService } from '../../core/auth.service'; // Удален импорт "type AuthState"
import logger from '../../utils/logger';
import { t } from '../../core/i18n.service'; // Для локализации текста кнопки/сообщений

export interface WelcomeControllerState {
  isAuthProcessing: boolean;
  authError: string | null;
  welcomeMessage: string;
  loginButtonText: string;
}

export class WelcomeController {
  public state: WelcomeControllerState;
  private authService: typeof AuthService;
  private unsubscribeFromAuthChanges: (() => void) | null = null;
  private requestGlobalRedraw: () => void;

  constructor(authService: typeof AuthService, requestGlobalRedraw: () => void) {
    this.authService = authService;
    this.requestGlobalRedraw = requestGlobalRedraw;

    const currentAuthState = this.authService.getState(); // Тип будет выведен как Readonly<AuthState>
    this.state = {
      isAuthProcessing: currentAuthState.isProcessing,
      authError: currentAuthState.error,
      welcomeMessage: t('welcome.message'),
      loginButtonText: t('welcome.loginButton'),
    };

    this.unsubscribeFromAuthChanges = this.authService.subscribe(() => this.onAuthStateChanged());
    logger.info('[WelcomeController] Initialized');
  }

  private onAuthStateChanged(): void {
    const currentAuthState = this.authService.getState(); // Тип будет выведен как Readonly<AuthState>
    let needsRedraw = false;

    if (this.state.isAuthProcessing !== currentAuthState.isProcessing) {
      this.state.isAuthProcessing = currentAuthState.isProcessing;
      needsRedraw = true;
    }
    if (this.state.authError !== currentAuthState.error) {
      this.state.authError = currentAuthState.error;
      needsRedraw = true;
    }
    // Сообщения могут измениться при смене языка, но это обрабатывается глобальным ререндером
    // this.state.welcomeMessage = t('welcome.message');
    // this.state.loginButtonText = t('welcome.loginButton');


    if (needsRedraw) {
      logger.debug('[WelcomeController] Auth state changed, requesting redraw.', this.state);
      this.requestGlobalRedraw();
    }
  }

  public async handleLogin(): Promise<void> {
    if (this.state.isAuthProcessing) {
      logger.warn('[WelcomeController] Login attempt while already processing.');
      return;
    }
    logger.info('[WelcomeController] Login button clicked, initiating Lichess login.');
    // AuthService сам обновит isProcessing и вызовет редирект
    await this.authService.login();
    // После вызова login, если не было ошибки на старте, произойдет редирект.
    // Если была ошибка на старте, isAuthProcessing станет false и кнопка снова будет активна.
    // Ре-рендер будет вызван через onAuthStateChanged, если isProcessing изменится.
  }

  public updateLocalizedTexts(): void {
    // Этот метод вызывается из view для обновления текстов при рендеринге,
    // на случай если язык изменился между вызовами onAuthStateChanged и рендером.
    this.state.welcomeMessage = t('welcome.message');
    this.state.loginButtonText = t('welcome.loginButton');
  }

  public destroy(): void {
    if (this.unsubscribeFromAuthChanges) {
      this.unsubscribeFromAuthChanges();
      this.unsubscribeFromAuthChanges = null;
    }
    logger.info('[WelcomeController] Destroyed, unsubscribed from auth changes.');
  }
}
