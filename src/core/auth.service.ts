// src/core/auth.service.ts
import { OAuth2AuthCodePKCE, type AccessContext, type AccessToken } from '@bity/oauth2-auth-code-pkce'; // Убран импорт OAuth2Error
import logger from '../utils/logger';

// --- Типы и Интерфейсы ---
export type SubscriptionTier = 'none' | 'bronze' | 'silver' | 'gold' | 'platinum';

export interface LichessUserProfile {
  id: string;
  username: string;
  email?: string;
  perfs?: Record<string, { rating: number; prog: number; games: number }>;
  createdAt?: number; // Unix timestamp in seconds from Lichess
  profile?: {
    firstName?: string;
    lastName?: string;
    bio?: string;
    country?: string;
    location?: string;
  };
}

export interface UserSessionProfile extends LichessUserProfile {
  subscriptionTier: SubscriptionTier;
}

export interface AuthState {
  isAuthenticated: boolean;
  userProfile: UserSessionProfile | null;
  accessToken: string | null;
  isProcessing: boolean; // True if currently processing login, callback, or profile fetch
  error: string | null;
}

// --- Константы ---
const LICHESS_HOST = 'https://lichess.org';
const CLIENT_ID = import.meta.env.VITE_LICHESS_CLIENT_ID || 'chesstomate.app.default';
// Используем VITE_LICHESS_REDIRECT_URI, по умолчанию это корень текущего хоста
const REDIRECT_URI = import.meta.env.VITE_LICHESS_REDIRECT_URI || `${window.location.origin}/`;

const USER_INFO_WEBHOOK_URL = import.meta.env.VITE_WEBHOOK_USERINFO as string;
const TOKEN_URL = `${LICHESS_HOST}/api/token`; // Lichess token URL

const SCOPES = ['email:read', 'preference:read', 'board:play'];

class AuthServiceController {
  private oauthClient: OAuth2AuthCodePKCE;
  private readonly serviceTokenUrl: string; // URL для отзыва токена на сервере Lichess
  private state: AuthState = {
    isAuthenticated: false,
    userProfile: null,
    accessToken: null,
    isProcessing: false, // Изначально false, устанавливается в true во время активных операций
    error: null,
  };

  private subscribers = new Set<() => void>();

  constructor() {
    logger.info(`[AuthService] Initializing with CLIENT_ID: ${CLIENT_ID}, REDIRECT_URI: ${REDIRECT_URI}`);
    this.serviceTokenUrl = TOKEN_URL;

    if (!REDIRECT_URI.startsWith('http://localhost') && !REDIRECT_URI.startsWith('https://')) {
        logger.error(`[AuthService] Critical Configuration Error: VITE_LICHESS_REDIRECT_URI must be an absolute URL. Current value: "${REDIRECT_URI}"`);
        // Можно выбросить ошибку, чтобы остановить инициализацию
        // throw new Error('VITE_LICHESS_REDIRECT_URI must be an absolute URL.');
    }


    this.oauthClient = new OAuth2AuthCodePKCE({
      authorizationUrl: `${LICHESS_HOST}/oauth`,
      tokenUrl: this.serviceTokenUrl,
      clientId: CLIENT_ID,
      scopes: SCOPES,
      redirectUrl: REDIRECT_URI, // Используем новую константу
      onAccessTokenExpiry: async (refreshAccessToken): Promise<AccessContext> => {
        logger.info('[AuthService] Lichess token expired, attempting refresh...');
        this.setState({ isProcessing: true });
        try {
          const newAccessContext = await refreshAccessToken();
          const token = newAccessContext.token;
          if (token?.value) {
            this.setState({ accessToken: token.value, error: null });
            localStorage.setItem('lichess_token', token.value);
            logger.info('[AuthService] Token refreshed successfully.');
          }
          return newAccessContext;
        } catch (err: any) { // Используем any для err
          logger.error('[AuthService] Failed to refresh Lichess token during onAccessTokenExpiry. Logging out.', err);
          await this.logout(false); // Не вызываем revoke, так как токен уже невалиден
          throw err; // Передаем ошибку дальше, чтобы @bity/oauth2-auth-code-pkce мог её обработать
        } finally {
            this.setState({ isProcessing: false });
        }
      },
      onInvalidGrant: async (_retry) => {
        logger.error('[AuthService] Lichess refresh token invalid (onInvalidGrant). Logging out.');
        await this.logout(false); // Не вызываем revoke
      },
    });

    if (!USER_INFO_WEBHOOK_URL) {
        logger.error('[AuthService] Critical: VITE_WEBHOOK_USERINFO is not defined in .env file.');
    }
  }

  public getState(): Readonly<AuthState> {
    return this.state;
  }

  private setState(newState: Partial<AuthState>) {
    const previousIsAuthenticated = this.state.isAuthenticated;
    const previousIsProcessing = this.state.isProcessing;
    const previousError = this.state.error;

    this.state = { ...this.state, ...newState };

    // Уведомляем подписчиков только если изменились значимые поля
    if (
        (newState.isAuthenticated !== undefined && newState.isAuthenticated !== previousIsAuthenticated) ||
        (newState.isProcessing !== undefined && newState.isProcessing !== previousIsProcessing) ||
        (newState.error !== undefined && newState.error !== previousError) ||
        newState.userProfile !== undefined // Также уведомляем при изменении профиля
    ) {
        this.notifySubscribers();
    }
  }

  public subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private notifySubscribers(): void {
    this.subscribers.forEach(callback => {
      try {
        callback();
      } catch (e) {
        logger.error('[AuthService] Error in subscriber callback:', e);
      }
    });
  }

  /**
   * Handles the authentication process.
   * Checks for an OAuth2 callback, otherwise tries to load session from localStorage.
   * This should be called once when the application initializes.
   * @returns Promise<boolean> - True if a new authentication (callback) was processed, false otherwise.
   */
  public async handleAuthentication(): Promise<boolean> {
    this.setState({ isProcessing: true, error: null });
    logger.info('[AuthService] Starting handleAuthentication...');

    try {
      const hasAuthCode = await this.oauthClient.isReturningFromAuthServer();
      if (hasAuthCode) {
        logger.info('[AuthService] OAuth callback detected (code in URL).');
        await this._processAuthCallback();
        this.setState({ isProcessing: false });
        return true; // Коллбэк был обработан
      } else {
        logger.info('[AuthService] No OAuth callback detected. Checking for stored session.');
        await this._loadStoredSession();
        this.setState({ isProcessing: false });
        return false; // Коллбэк не обрабатывался, загружалась (или нет) сохраненная сессия
      }
    } catch (err: any) { // Используем any для err
      const errorMessage = err.error_description || err.message || 'Unknown authentication error';
      logger.error('[AuthService] Error during handleAuthentication:', errorMessage, err);
      this.clearAuthDataLocal(); // Очищаем все при ошибке на этом этапе
      this.setState({
        isAuthenticated: false,
        userProfile: null,
        accessToken: null,
        isProcessing: false,
        error: `Authentication failed: ${errorMessage}`,
      });
      return true; // Считаем, что коллбэк "обрабатывался", но с ошибкой
    }
  }

  private async _processAuthCallback(): Promise<void> {
    logger.info('[AuthService] Processing authorization code...');
    // isProcessing уже true
    try {
      const accessContext = await this.oauthClient.getAccessToken();
      logger.debug('[AuthService] Lichess access context from callback:', accessContext);

      const token: AccessToken | undefined = accessContext.token;
      if (token?.value) {
        this.setState({ accessToken: token.value, error: null });
        localStorage.setItem('lichess_token', token.value);

        await this.fetchUserProfile(); // Загрузит профиль и установит isAuthenticated, userProfile

        if (this.state.isAuthenticated && this.state.userProfile) {
          await this.syncUserProfileWithBackend(this.state.userProfile, this.state.accessToken, "registration");
        } else {
           throw new Error('User profile could not be fetched or authentication failed after token exchange.');
        }
        // Очистка URL от code и state
        this._clearAuthParamsFromUrl();
      } else {
        throw new Error('Received empty token from Lichess during callback.');
      }
    } catch (err) { // err будет any
        logger.error('[AuthService] Error processing auth callback:', err);
        this._clearAuthParamsFromUrl(); // Все равно очищаем URL
        this.clearAuthDataLocal(); // Сбрасываем все локальные данные
        // Ошибка будет передана в вызывающий handleAuthentication
        throw err;
    }
  }

  private async _loadStoredSession(): Promise<void> {
    // isProcessing уже true
    const storedToken = localStorage.getItem('lichess_token');
    const storedProfileString = localStorage.getItem('lichess_user_profile');

    if (storedToken) {
      logger.info('[AuthService] Found stored Lichess token. Attempting to validate.');
      this.setState({ accessToken: storedToken }); // Временно устанавливаем токен для fetchUserProfile
      try {
        await this.fetchUserProfile(); // Этот метод установит isAuthenticated и userProfile если токен валиден
        if (!this.state.isAuthenticated) {
          logger.warn('[AuthService] Stored token validation failed. User is logged out.');
          this.clearAuthDataLocal(); // Если fetchUserProfile не смог аутентифицировать, очищаем
        } else if (storedProfileString && this.state.userProfile?.id === JSON.parse(storedProfileString)?.id) {
            try {
                const parsedProfile = JSON.parse(storedProfileString) as UserSessionProfile;
                this.setState({ userProfile: parsedProfile }); // Восстанавливаем полный профиль, если он совпадает
                 logger.info('[AuthService] Successfully initialized with stored token and profile.');
            } catch (e) {
                 logger.warn('[AuthService] Could not parse stored profile, but token is valid. Profile was re-fetched.');
            }
        } else {
             logger.info('[AuthService] Stored token valid, profile (re)fetched.');
        }
      } catch (error) {
        logger.error('[AuthService] Error during initial profile fetch with stored token:', error);
        this.clearAuthDataLocal(); // Очищаем при ошибке
      }
    } else {
      logger.info('[AuthService] No stored Lichess token found.');
      this.clearAuthDataLocal(); // Убедимся, что все чисто
    }
  }

  private _clearAuthParamsFromUrl(): void {
    const newUrl = window.location.pathname + window.location.hash;
    if (window.location.search) { // Очищаем только если есть search params
        window.history.replaceState({}, document.title, newUrl);
        logger.info(`[AuthService] Auth params (code, state) cleared from URL. New URL: ${newUrl}`);
    }
  }

  public async login(): Promise<void> {
    logger.info('[AuthService] Initiating Lichess login...');
    this.setState({ error: null, isProcessing: true });
    try {
      // OAuth2AuthCodePKCE сам обработает редирект
      await this.oauthClient.fetchAuthorizationCode();
      // Если fetchAuthorizationCode не вызвал редирект (например, из-за ошибки конфигурации),
      // isProcessing останется true. AppController должен это учитывать.
      // Обычно здесь происходит редирект, и код дальше не выполняется.
    } catch (err: any) { // Используем any для err
      const errorMessage = err.error_description || err.message || 'Unknown login initiation error';
      logger.error('[AuthService] Lichess login initiation failed:', errorMessage, err);
      this.setState({ error: `Failed to initiate login: ${errorMessage}`, isProcessing: false });
    }
  }

  // Метод handleCallback больше не нужен, его логика интегрирована в handleAuthentication/_processAuthCallback

  public async fetchUserProfile(): Promise<void> {
    if (!this.state.accessToken) {
      logger.warn('[AuthService] fetchUserProfile called without an access token.');
      if (this.state.isAuthenticated) this.setState({ isAuthenticated: false, userProfile: null, error: 'Access token missing for profile fetch' });
      return;
    }
    logger.info('[AuthService] Fetching Lichess user profile...');
    // isProcessing должен быть уже true, если это часть _processAuthCallback или _loadStoredSession
    // Если вызывается отдельно, вызывающий должен управлять isProcessing или мы должны установить его здесь.
    // Для безопасности установим его здесь, если он еще не установлен.
    const wasProcessing = this.state.isProcessing;
    if (!wasProcessing) this.setState({ isProcessing: true });

    try {
      const fetchWithAuth = this.oauthClient.decorateFetchHTTPClient(window.fetch);
      const response = await fetchWithAuth(`${LICHESS_HOST}/api/account`);

      if (!response.ok) {
        logger.warn(`[AuthService] Fetch profile failed with status ${response.status}.`);
        if (response.status === 401) { // Неавторизован - токен невалиден
             logger.warn('[AuthService] fetchUserProfile got 401, implies token is definitively invalid. Clearing session.');
             this.clearAuthDataLocal(); // Очищаем всё, так как токен плохой
             this.setState({ isAuthenticated: false, userProfile: null, accessToken: null, error: 'Invalid token (401)' });
        } else {
            this.setState({ error: `Failed to fetch profile - Status ${response.status}` });
        }
        // Не выбрасываем ошибку, чтобы позволить setState отработать
        return; // Выходим, так как профиль не получен
      }

      const lichessProfile: LichessUserProfile = await response.json();
      logger.debug('[AuthService] Lichess profile data received:', lichessProfile);

      // Пытаемся восстановить tier из localStorage, если профиль совпадает
      let previousTier: SubscriptionTier = 'bronze'; // Значение по умолчанию
      const storedProfileString = localStorage.getItem('lichess_user_profile');
      if (storedProfileString) {
          try {
              const storedFullProfile = JSON.parse(storedProfileString) as UserSessionProfile;
              if (storedFullProfile.id === lichessProfile.id && storedFullProfile.subscriptionTier) {
                  previousTier = storedFullProfile.subscriptionTier;
              }
          } catch (e) { /* ignore parsing error of old data */ }
      }

      const sessionProfile: UserSessionProfile = {
        ...lichessProfile,
        subscriptionTier: previousTier, // Используем сохраненный или дефолтный tier
      };

      localStorage.setItem('lichess_user_profile', JSON.stringify(sessionProfile));
      this.setState({
        userProfile: sessionProfile,
        isAuthenticated: true, // Успешно получили профиль -> аутентифицирован
        // accessToken уже должен быть в state
        error: null,
      });
    } catch (err: any) { // Используем any для err
      logger.error('[AuthService] Error in fetchUserProfile:', err.message);
      // Если ошибка не 401, токен может быть еще валиден, но есть сетевая проблема.
      // Не очищаем токен здесь, если это не 401.
      this.setState({ error: `Failed to fetch profile: ${err.message}` });
    } finally {
        if (!wasProcessing) this.setState({ isProcessing: false });
    }
  }

  public async logout(callApiRevoke = true): Promise<void> {
    logger.info(`[AuthService] Logging out. Call API revoke: ${callApiRevoke}`);
    this.setState({ isProcessing: true });
    const tokenToRevoke = this.state.accessToken;

    if (callApiRevoke && tokenToRevoke) {
      try {
        logger.info('[AuthService] Revoking Lichess token on server...');
        // oauthClient.revoke() может быть предпочтительнее, если он доступен и корректно работает
        // В данном примере используется прямой fetch, как в вашем коде
        const response = await fetch(this.serviceTokenUrl, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${tokenToRevoke}` },
        });
        if (response.ok) {
          logger.info('[AuthService] Lichess token revoked successfully.');
        } else {
          logger.warn(
            '[AuthService] Failed to revoke Lichess token on server:',
            response.status,
            await response.text().catch(() => '')
          );
        }
      } catch (err) {
        logger.error('[AuthService] Error while revoking Lichess token:', err);
      }
    }
    this.clearAuthDataLocal(); // Очищает state и localStorage
    this.setState({ isProcessing: false, error: null }); // Убедимся, что isProcessing сброшен
  }

  private clearAuthDataLocal(): void {
    // Эта функция теперь только меняет состояние и localStorage
    // setState вызовет notifySubscribers, если нужно
    localStorage.removeItem('lichess_token');
    localStorage.removeItem('lichess_user_profile');
    this.setState({
        accessToken: null,
        userProfile: null,
        isAuthenticated: false,
        // error и isProcessing не сбрасываем здесь, ими управляют вызывающие методы
    });
    logger.info('[AuthService] Local authentication data (state & localStorage) cleared.');
  }

  private async syncUserProfileWithBackend(
    profile: UserSessionProfile,
    tokenValue: string | null,
    eventType: "registration" | "update"
  ): Promise<void> {
    logger.info(`[AuthService] Attempting to sync user profile with backend. Event: ${eventType}. Profile ID: ${profile.id}`);
    if (!USER_INFO_WEBHOOK_URL) {
      logger.warn('[AuthService] VITE_WEBHOOK_USERINFO is not configured. Skipping user profile sync.');
      return;
    }
    if (!tokenValue) {
      logger.warn('[AuthService] No access token available for syncUserProfileWithBackend. Skipping.');
      return;
    }

    const payload = {
      event: eventType,
      lichess_id: profile.id,
      username: profile.username,
      email: profile.email,
      subscriptionTier: profile.subscriptionTier,
      perfs: profile.perfs,
      createdAt: profile.createdAt,
      accessToken: tokenValue,
    };
    logger.info(`[AuthService] Syncing user profile. Event: ${eventType}. URL: ${USER_INFO_WEBHOOK_URL}`);
    // logger.debug('[AuthService] Sync payload:', payload); // Осторожно с логированием токена
    try {
      const response = await fetch(USER_INFO_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        logger.error(`[AuthService] Backend sync failed. Status: ${response.status}. Resp: ${await response.text().catch(()=>'')}`);
      } else {
        logger.info('[AuthService] User profile synced with backend successfully.');
      }
    } catch (error: any) {
      logger.error('[AuthService] Network error during backend sync:', error.message);
    }
  }

  // --- Геттеры для состояния ---
  public getIsAuthenticated(): boolean { return this.state.isAuthenticated; }
  public getUserProfile(): UserSessionProfile | null { return this.state.userProfile; }
  public getAccessToken(): string | null { return this.state.accessToken; }
  public getUserSubscriptionTier(): SubscriptionTier { return this.state.userProfile?.subscriptionTier || 'none'; }
  public getError(): string | null { return this.state.error; }
  public getIsProcessing(): boolean { return this.state.isProcessing; }
}

export const AuthService = new AuthServiceController();
