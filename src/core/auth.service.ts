// src/core/auth.service.ts
import { OAuth2AuthCodePKCE, type AccessContext, type AccessToken } from '@bity/oauth2-auth-code-pkce';
import logger from '../utils/logger';
// Импортируем инстанс WebhookService и тип его контроллера
import { WebhookService, type WebhookServiceController } from '../core/webhook.service';


// --- Типы и Интерфейсы ---
export type SubscriptionTier = 'none' | 'bronze' | 'silver' | 'gold' | 'platinum';

export interface LedClubs {
  club_ids: string[];
}

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

export interface FinishHimStats {
  gamesPlayed: number;
  tacticalRating: number;
  tacticalWins: number;
  tacticalLosses: number;
  finishHimRating: number;
  playoutWins: number;
  playoutDraws: number;
  playoutLosses: number;
  currentPieceCount: number;
}

export interface UserSessionProfile extends LichessUserProfile {
  subscriptionTier: SubscriptionTier;
  finishHimStats: FinishHimStats;
  led_clubs?: LedClubs;
}

// Этот payload используется для отправки данных на бэкенд через WebhookService
export interface UserSessionUpsertPayload {
    event: "userSessionUpsert" | "oAuth";
    lichess_id: string;
    username: string;
    lichessAccessToken: string;
}

// Структура ответа, ожидаемая от бэкенда (через WebhookService)
export interface BackendUserSessionData {
    lichess_id: string;
    username?: string; // username может быть опциональным в ответе, если мы его уже знаем
    FinishHimStats: FinishHimStats;
    subscriptionTier: SubscriptionTier;
    led_clubs?: LedClubs;
}


export interface AuthState {
  isAuthenticated: boolean;
  userProfile: UserSessionProfile | null;
  accessToken: string | null;
  isProcessing: boolean;
  error: string | null;
}

// --- Константы ---
const LICHESS_HOST = 'https://lichess.org';
const CLIENT_ID = import.meta.env.VITE_LICHESS_CLIENT_ID || 'chesstomate.app.default';
const REDIRECT_URI = import.meta.env.VITE_LICHESS_REDIRECT_URI || `${window.location.origin}/`;

// USER_SESSION_WEBHOOK_URL удалена, так как теперь используется единый VITE_BACKEND через WebhookService

const TOKEN_URL = `${LICHESS_HOST}/api/token`;
const SCOPES = [ 'preference:read']; // 'email:read' можно добавить, если нужно

class AuthServiceController {
  private oauthClient: OAuth2AuthCodePKCE;
  private readonly lichessTokenUrl: string;
  // Добавляем свойство для хранения инстанса WebhookService
  private webhookService: WebhookServiceController;

  private state: AuthState = {
    isAuthenticated: false,
    userProfile: null,
    accessToken: null,
    isProcessing: false,
    error: null,
  };

  private subscribers = new Set<() => void>();

  constructor() {
    logger.info(`[AuthService] Initializing with CLIENT_ID: ${CLIENT_ID}, REDIRECT_URI: ${REDIRECT_URI}`);
    this.lichessTokenUrl = TOKEN_URL;
    this.webhookService = WebhookService; // Присваиваем импортированный инстанс

    this.oauthClient = new OAuth2AuthCodePKCE({
      authorizationUrl: `${LICHESS_HOST}/oauth`,
      tokenUrl: this.lichessTokenUrl,
      clientId: CLIENT_ID,
      scopes: SCOPES,
      redirectUrl: REDIRECT_URI,
      onAccessTokenExpiry: async (refreshAccessToken): Promise<AccessContext> => {
        logger.info('[AuthService] Lichess token expired, attempting refresh...');
        this.setState({ isProcessing: true });
        try {
          const newAccessContext = await refreshAccessToken();
          const token = newAccessContext.token;
          if (token?.value) {
            this.setState({ accessToken: token.value, error: null });
            localStorage.setItem('lichess_token', token.value);
            await this._fetchAndSetUserSessionProfile(token.value, false); // isInitialAuth = false
            logger.info('[AuthService] Token refreshed successfully and user session profile re-fetched.');
          }
          return newAccessContext;
        } catch (err: any) {
          logger.error('[AuthService] Failed to refresh Lichess token during onAccessTokenExpiry. Logging out.', err);
          await this.logout(false);
          throw err;
        } finally {
            this.setState({ isProcessing: false });
        }
      },
      onInvalidGrant: async (_retry) => {
        logger.error('[AuthService] Lichess refresh token invalid (onInvalidGrant). Logging out.');
        await this.logout(false);
      },
    });

    // Проверка VITE_BACKEND теперь происходит в WebhookService
  }

  public getState(): Readonly<AuthState> {
    return this.state;
  }

  private setState(newState: Partial<AuthState>) {
    const previousIsAuthenticated = this.state.isAuthenticated;
    const previousIsProcessing = this.state.isProcessing;
    const previousError = this.state.error;
    const previousUserProfileId = this.state.userProfile?.id;
    const previousFinishHimStats = JSON.stringify(this.state.userProfile?.finishHimStats);
    const previousLedClubs = JSON.stringify(this.state.userProfile?.led_clubs);


    this.state = { ...this.state, ...newState };

    if (
        (newState.isAuthenticated !== undefined && newState.isAuthenticated !== previousIsAuthenticated) ||
        (newState.isProcessing !== undefined && newState.isProcessing !== previousIsProcessing) ||
        (newState.error !== undefined && newState.error !== previousError) ||
        (newState.userProfile?.id !== undefined && newState.userProfile.id !== previousUserProfileId) ||
        (newState.userProfile?.finishHimStats !== undefined && JSON.stringify(newState.userProfile.finishHimStats) !== previousFinishHimStats) ||
        (newState.userProfile?.led_clubs !== undefined && JSON.stringify(newState.userProfile.led_clubs) !== previousLedClubs)
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
      try { callback(); } catch (e) { logger.error('[AuthService] Error in subscriber callback:', e); }
    });
  }

  public async handleAuthentication(): Promise<boolean> {
    this.setState({ isProcessing: true, error: null });
    logger.info('[AuthService] Starting handleAuthentication...');
    try {
      const hasAuthCode = await this.oauthClient.isReturningFromAuthServer();
      if (hasAuthCode) {
        logger.info('[AuthService] OAuth callback detected.');
        await this._processAuthCallback();
        return true;
      } else {
        logger.info('[AuthService] No OAuth callback. Checking for stored session.');
        await this._loadStoredSession();
        return false; // Возвращаем false, если это не был колбэк, чтобы AppController продолжил обработку хэша
      }
    } catch (err: any) {
      const errorMessage = err.error_description || err.message || 'Unknown authentication error';
      logger.error('[AuthService] Error during handleAuthentication:', errorMessage, err);
      this.clearAuthDataLocal();
      this.setState({ isAuthenticated: false, userProfile: null, accessToken: null, error: `Authentication failed: ${errorMessage}` });
      return true; // Возвращаем true, так как ошибка обработана и URL, вероятно, нужно очистить
    } finally {
        this.setState({ isProcessing: false });
    }
  }

  private async _processAuthCallback(): Promise<void> {
    logger.info('[AuthService] Processing authorization code...');
    const accessContext = await this.oauthClient.getAccessToken();
    const token: AccessToken | undefined = accessContext.token;

    if (token?.value) {
      this.setState({ accessToken: token.value, error: null });
      localStorage.setItem('lichess_token', token.value);
      this._clearAuthParamsFromUrl();
      await this._fetchAndSetUserSessionProfile(token.value, true); // isInitialAuth = true
    } else {
      this._clearAuthParamsFromUrl();
      throw new Error('Received empty token from Lichess during callback.');
    }
  }

  private async _loadStoredSession(): Promise<void> {
    const storedToken = localStorage.getItem('lichess_token');
    if (storedToken) {
      logger.info('[AuthService] Found stored Lichess token. Validating session.');
      this.setState({ accessToken: storedToken });
      await this._fetchAndSetUserSessionProfile(storedToken, false); // isInitialAuth = false
      if (!this.state.isAuthenticated) {
        logger.warn('[AuthService] Stored token validation failed. User is logged out.');
        this.clearAuthDataLocal(); // Очищаем только если сессия не подтвердилась
      }
    } else {
      logger.info('[AuthService] No stored Lichess token found.');
      this.clearAuthDataLocal(); // Очищаем, так как токена нет
    }
  }

  private async _fetchAndSetUserSessionProfile(lichessAccessToken: string, isInitialAuth: boolean): Promise<void> {
    const eventType = isInitialAuth ? "oAuth" : "userSessionUpsert";
    logger.info(`[AuthService] Fetching Lichess basic profile and then full user session from backend (event: ${eventType})...`);
    try {
      const fetchWithAuth = this.oauthClient.decorateFetchHTTPClient(window.fetch);
      const lichessResponse = await fetchWithAuth(`${LICHESS_HOST}/api/account`, {
        headers: { 'Authorization': `Bearer ${lichessAccessToken}` },
      });

      if (!lichessResponse.ok) {
        if (lichessResponse.status === 401) logger.warn('[AuthService] Lichess token is invalid (401). Clearing session.');
        else logger.warn(`[AuthService] Failed to fetch Lichess profile. Status: ${lichessResponse.status}.`);
        throw new Error(`Lichess API request failed: ${lichessResponse.status}`);
      }
      const lichessProfileData: LichessUserProfile = await lichessResponse.json();
      logger.debug('[AuthService] Basic Lichess profile data received:', lichessProfileData);

      const upsertPayload: UserSessionUpsertPayload = {
        event: eventType,
        lichess_id: lichessProfileData.id,
        username: lichessProfileData.username,
        lichessAccessToken: lichessAccessToken, // Передаем токен на бэкенд
      };

      // Используем WebhookService для отправки запроса на бэкенд
      const backendSpecificData = await this.webhookService.upsertUserSession(upsertPayload);

      if (!backendSpecificData) {
        logger.error(`[AuthService] User session upsert to backend failed (event: ${eventType}). WebhookService returned null.`);
        throw new Error(`Backend userSessionUpsert failed (event: ${eventType}): WebhookService returned null`);
      }
      
      logger.debug('[AuthService] Raw backendSpecificData from WebhookService:', JSON.stringify(backendSpecificData));

      if (lichessProfileData.id !== backendSpecificData.lichess_id) {
        logger.error(
            `Lichess ID mismatch. Lichess API: ${lichessProfileData.id}, Backend: ${backendSpecificData.lichess_id}`
        );
        throw new Error("Lichess ID mismatch between Lichess API and backend response");
      }
      
      if (!backendSpecificData.FinishHimStats || typeof backendSpecificData.subscriptionTier === 'undefined') {
          logger.error('[AuthService] Backend response missing required fields: FinishHimStats or subscriptionTier.', backendSpecificData);
          throw new Error('Backend response missing required fields.');
      }

      const finalUserSessionProfile: UserSessionProfile = {
        ...lichessProfileData,
        subscriptionTier: backendSpecificData.subscriptionTier as SubscriptionTier,
        finishHimStats: backendSpecificData.FinishHimStats as FinishHimStats,
        led_clubs: backendSpecificData.led_clubs ? { ...backendSpecificData.led_clubs } : undefined,
      };

      localStorage.setItem('lichess_user_profile', JSON.stringify(finalUserSessionProfile));
      this.setState({
        userProfile: finalUserSessionProfile,
        isAuthenticated: true,
        accessToken: lichessAccessToken, // Убеждаемся, что токен сохраняется в state
        error: null,
      });

    } catch (error: any) {
      logger.error(`[AuthService] Error in _fetchAndSetUserSessionProfile (event: ${eventType}):`, error.message, error.stack);
      this.clearAuthDataLocal(); // Очищаем при любой ошибке здесь
      this.setState({ isAuthenticated: false, userProfile: null, accessToken: null, error: `Failed to establish session: ${error.message}` });
    }
  }

  private _clearAuthParamsFromUrl(): void {
    // Удаляем параметры code и state из URL, если они есть
    const url = new URL(window.location.href);
    let paramsCleared = false;
    if (url.searchParams.has('code')) {
        url.searchParams.delete('code');
        paramsCleared = true;
    }
    if (url.searchParams.has('state')) {
        url.searchParams.delete('state');
        paramsCleared = true;
    }
    if (paramsCleared) {
        window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
        logger.info('[AuthService] OAuth parameters (code, state) cleared from URL search string.');
    }
}

  public async login(): Promise<void> {
    logger.info('[AuthService] Initiating Lichess login...');
    this.setState({ error: null, isProcessing: true });
    try {
      await this.oauthClient.fetchAuthorizationCode();
    } catch (err: any) {
      const errorMessage = err.error_description || err.message || 'Unknown login initiation error';
      logger.error('[AuthService] Lichess login initiation failed:', errorMessage, err);
      this.setState({ error: `Failed to initiate login: ${errorMessage}`, isProcessing: false });
    }
  }

  public async logout(callApiRevoke = true): Promise<void> {
    logger.info(`[AuthService] Logging out. Call API revoke: ${callApiRevoke}`);
    this.setState({ isProcessing: true });
    const tokenToRevoke = this.state.accessToken;

    if (callApiRevoke && tokenToRevoke) {
      try {
        // Используем OAuth2AuthCodePKCE для отзыва токена, если он предоставляет такой метод,
        // или делаем прямой запрос, как раньше.
        // Для простоты оставляем прямой запрос, так как revokeToken может быть не всегда доступен или работать иначе.
        await fetch(this.lichessTokenUrl, { // Убедитесь, что это правильный URL для отзыва
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${tokenToRevoke}` },
        });
        logger.info('[AuthService] Lichess token revoked successfully.');
      } catch (err) {
        logger.error('[AuthService] Error while revoking Lichess token:', err);
        // Продолжаем выход из системы локально, даже если отзыв не удался
      }
    }
    this.clearAuthDataLocal(); // Это уже вызовет setState и notifySubscribers
    this.setState({ isProcessing: false, error: null }); // Дополнительно сбрасываем isProcessing и error
  }

  private clearAuthDataLocal(): void {
    localStorage.removeItem('lichess_token');
    localStorage.removeItem('lichess_user_profile');
    // Вызов setState здесь приведет к обновлению состояния и уведомлению подписчиков
    this.setState({ accessToken: null, userProfile: null, isAuthenticated: false });
    logger.info('[AuthService] Local authentication data cleared.');
  }

  // --- Геттеры для доступа к состоянию ---
  public getIsAuthenticated(): boolean { return this.state.isAuthenticated; }
  public getUserProfile(): UserSessionProfile | null { return this.state.userProfile; }
  public getAccessToken(): string | null { return this.state.accessToken; }
  public getUserSubscriptionTier(): SubscriptionTier {
      return this.state.userProfile?.subscriptionTier || 'none';
  }
  public getError(): string | null { return this.state.error; }
  public getIsProcessing(): boolean { return this.state.isProcessing; }
  public getFinishHimStats(): FinishHimStats | null {
    return this.state.userProfile?.finishHimStats || null;
  }
  public getLedClubs(): LedClubs | undefined {
    return this.state.userProfile?.led_clubs;
  }
}

export const AuthService = new AuthServiceController();
