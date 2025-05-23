// src/core/auth.service.ts
import { OAuth2AuthCodePKCE, type AccessContext, type AccessToken } from '@bity/oauth2-auth-code-pkce';
import logger from '../utils/logger';
// Импортируем инстанс WebhookService и тип его контроллера
import { WebhookService, type WebhookServiceController } from '../core/webhook.service';


// --- Типы и Интерфейсы ---
export type SubscriptionTier = 'none' | 'bronze' | 'silver' | 'gold' | 'platinum';

export interface ClubIdNamePair {
  club_id: string;
  club_name: string;
}

// Обновленный интерфейс FollowClubs
export interface FollowClubs {
  clubs: ClubIdNamePair[];
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
  follow_clubs?: FollowClubs; // Используем обновленный FollowClubs
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
    username?: string; // username может быть опциональным, если бэкенд его не всегда возвращает для всех событий
    FinishHimStats: FinishHimStats;
    subscriptionTier: SubscriptionTier;
    follow_clubs?: FollowClubs; // Используем обновленный FollowClubs
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

const TOKEN_URL = `${LICHESS_HOST}/api/token`;
const SCOPES = [ 'preference:read'];

class AuthServiceController {
  private oauthClient: OAuth2AuthCodePKCE;
  private readonly lichessTokenUrl: string;
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
    this.webhookService = WebhookService;

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
            await this._fetchAndSetUserSessionProfile(token.value, false);
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
    // Сравниваем follow_clubs по содержимому, а не по ссылке
    const previousFollowClubsString = this.state.userProfile?.follow_clubs ? JSON.stringify(this.state.userProfile.follow_clubs.clubs) : undefined;


    this.state = { ...this.state, ...newState };

    const currentFollowClubsString = this.state.userProfile?.follow_clubs ? JSON.stringify(this.state.userProfile.follow_clubs.clubs) : undefined;

    if (
        (newState.isAuthenticated !== undefined && newState.isAuthenticated !== previousIsAuthenticated) ||
        (newState.isProcessing !== undefined && newState.isProcessing !== previousIsProcessing) ||
        (newState.error !== undefined && newState.error !== previousError) ||
        (newState.userProfile?.id !== undefined && newState.userProfile.id !== previousUserProfileId) ||
        (newState.userProfile?.finishHimStats !== undefined && JSON.stringify(newState.userProfile.finishHimStats) !== previousFinishHimStats) ||
        (currentFollowClubsString !== previousFollowClubsString) // Сравнение строковых представлений
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
        return false;
      }
    } catch (err: any) {
      const errorMessage = err.error_description || err.message || 'Unknown authentication error';
      logger.error('[AuthService] Error during handleAuthentication:', errorMessage, err);
      this.clearAuthDataLocal();
      this.setState({ isAuthenticated: false, userProfile: null, accessToken: null, error: `Authentication failed: ${errorMessage}` });
      return true; // Возвращаем true, так как URL был обработан (даже если с ошибкой)
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
      await this._fetchAndSetUserSessionProfile(token.value, true);
    } else {
      this._clearAuthParamsFromUrl(); // Очищаем URL даже если токен не пришел
      throw new Error('Received empty token from Lichess during callback.');
    }
  }

  private async _loadStoredSession(): Promise<void> {
    const storedToken = localStorage.getItem('lichess_token');
    if (storedToken) {
      logger.info('[AuthService] Found stored Lichess token. Validating session.');
      this.setState({ accessToken: storedToken }); // Устанавливаем токен в состояние до проверки
      await this._fetchAndSetUserSessionProfile(storedToken, false); // isInitialAuth = false
      if (!this.state.isAuthenticated) { // Проверяем, установилась ли аутентификация после fetch
        logger.warn('[AuthService] Stored token validation failed. User is logged out.');
        this.clearAuthDataLocal(); // Очищаем данные, если профиль не загрузился
      }
    } else {
      logger.info('[AuthService] No stored Lichess token found.');
      this.clearAuthDataLocal(); // На всякий случай, если токена нет, а профиль остался
    }
  }

  private async _fetchAndSetUserSessionProfile(lichessAccessToken: string, isInitialAuth: boolean): Promise<void> {
    const eventType = isInitialAuth ? "oAuth" : "userSessionUpsert";
    logger.info(`[AuthService] Fetching Lichess basic profile and then full user session from backend (event: ${eventType})...`);
    try {
      // 1. Получаем базовый профиль Lichess
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

      // 2. Отправляем запрос на бэкенд для получения/обновления сессии пользователя с нашим Event Type
      const upsertPayload: UserSessionUpsertPayload = {
        event: eventType,
        lichess_id: lichessProfileData.id,
        username: lichessProfileData.username,
        lichessAccessToken: lichessAccessToken, // Передаем токен, чтобы бэкенд мог его сохранить/проверить при необходимости
      };

      // Используем WebhookService для отправки данных на бэкенд
      const backendSpecificData = await this.webhookService.upsertUserSession(upsertPayload);

      if (!backendSpecificData) {
        logger.error(`[AuthService] User session upsert to backend failed (event: ${eventType}). WebhookService returned null.`);
        throw new Error(`Backend userSessionUpsert failed (event: ${eventType}): WebhookService returned null`);
      }
      
      logger.debug('[AuthService] Raw backendSpecificData from WebhookService:', JSON.stringify(backendSpecificData));


      // Проверка на несоответствие lichess_id (добавлена для надежности)
      if (lichessProfileData.id !== backendSpecificData.lichess_id) {
        logger.error(
            `Lichess ID mismatch. Lichess API: ${lichessProfileData.id}, Backend: ${backendSpecificData.lichess_id}`
        );
        throw new Error("Lichess ID mismatch between Lichess API and backend response");
      }
      
      // Проверка обязательных полей от бэкенда
      if (!backendSpecificData.FinishHimStats || typeof backendSpecificData.subscriptionTier === 'undefined') {
          logger.error('[AuthService] Backend response missing required fields: FinishHimStats or subscriptionTier.', backendSpecificData);
          throw new Error('Backend response missing required fields.');
      }

      // 3. Собираем полный профиль сессии пользователя
      // Убедимся, что follow_clubs соответствует новой структуре
      let normalizedFollowClubs: FollowClubs | undefined = undefined;
      if (backendSpecificData.follow_clubs) {
        if (Array.isArray((backendSpecificData.follow_clubs as FollowClubs).clubs)) {
            normalizedFollowClubs = backendSpecificData.follow_clubs as FollowClubs;
        } else if (typeof backendSpecificData.follow_clubs === 'object' && Object.keys(backendSpecificData.follow_clubs).length === 0) {
            // Если пришел пустой объект {}, считаем это как отсутствие подписок
            normalizedFollowClubs = { clubs: [] };
            logger.debug('[AuthService] backendSpecificData.follow_clubs was empty object, normalized to { clubs: [] }');
        } else {
            logger.warn('[AuthService] backendSpecificData.follow_clubs has unexpected structure, treating as no followed clubs. Data:', backendSpecificData.follow_clubs);
            normalizedFollowClubs = { clubs: [] };
        }
      }


      const finalUserSessionProfile: UserSessionProfile = {
        ...lichessProfileData, // Данные из Lichess API
        subscriptionTier: backendSpecificData.subscriptionTier as SubscriptionTier,
        finishHimStats: backendSpecificData.FinishHimStats as FinishHimStats,
        follow_clubs: normalizedFollowClubs,
      };

      // Сохраняем в localStorage и обновляем состояние
      localStorage.setItem('lichess_user_profile', JSON.stringify(finalUserSessionProfile));
      this.setState({
        userProfile: finalUserSessionProfile,
        isAuthenticated: true,
        accessToken: lichessAccessToken, // Сохраняем токен Lichess в состоянии
        error: null,
      });

    } catch (error: any) {
      logger.error(`[AuthService] Error in _fetchAndSetUserSessionProfile (event: ${eventType}):`, error.message, error.stack);
      this.clearAuthDataLocal(); // Очищаем данные при любой ошибке в этом процессе
      this.setState({ isAuthenticated: false, userProfile: null, accessToken: null, error: `Failed to establish session: ${error.message}` });
    }
  }

  // Метод для очистки параметров OAuth из URL
  private _clearAuthParamsFromUrl(): void {
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
    // Добавим очистку error и error_description, если они есть от Lichess
    if (url.searchParams.has('error')) {
        url.searchParams.delete('error');
        paramsCleared = true;
    }
    if (url.searchParams.has('error_description')) {
        url.searchParams.delete('error_description');
        paramsCleared = true;
    }

    if (paramsCleared) {
        window.history.replaceState({}, document.title, url.pathname + url.search + url.hash); // Используем pathname + search + hash для сохранения других параметров, если они есть
        logger.info('[AuthService] OAuth parameters (code, state, error, error_description) cleared from URL search string.');
    }
}


  public async login(): Promise<void> {
    logger.info('[AuthService] Initiating Lichess login...');
    this.setState({ error: null, isProcessing: true }); // Сбрасываем ошибку перед логином
    try {
      // this.oauthClient.reset(); // Сброс состояния клиента перед новым запросом, если необходимо
      await this.oauthClient.fetchAuthorizationCode();
      // Редирект произойдет здесь, если все успешно
    } catch (err: any) {
      // Ошибки здесь обычно связаны с конфигурацией или недоступностью Lichess OAuth сервера
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
        // Используем fetch, декорированный клиентом OAuth, если это предпочтительнее,
        // но для простого DELETE запроса с Bearer токеном обычный fetch тоже подойдет.
        // const fetchWithAuth = this.oauthClient.decorateFetchHTTPClient(window.fetch);
        await fetch(this.lichessTokenUrl, { // Используем this.lichessTokenUrl, который ${LICHESS_HOST}/api/token
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${tokenToRevoke}` },
        });
        logger.info('[AuthService] Lichess token revoked successfully.');
      } catch (err) {
        // Ошибка отзыва токена не должна прерывать процесс локального выхода
        logger.error('[AuthService] Error while revoking Lichess token:', err);
      }
    }
    // Вне зависимости от успеха отзыва токена, очищаем локальные данные
    this.clearAuthDataLocal();
    this.setState({ isProcessing: false, error: null }); // Сброс isProcessing и ошибки
  }

  private clearAuthDataLocal(): void {
    localStorage.removeItem('lichess_token');
    localStorage.removeItem('lichess_user_profile');
    this.setState({ accessToken: null, userProfile: null, isAuthenticated: false });
    logger.info('[AuthService] Local authentication data cleared.');
  }

  // Обновленный метод для обновления follow_clubs
  public updateFollowClubs(newFollowClubs: FollowClubs | undefined): void {
    if (this.state.userProfile) {
      // Убедимся, что newFollowClubs соответствует новой структуре или undefined
      let normalizedNewFollowClubs: FollowClubs | undefined = undefined;
      if (newFollowClubs && Array.isArray(newFollowClubs.clubs)) {
        normalizedNewFollowClubs = newFollowClubs;
      } else if (newFollowClubs) {
        // Если пришла невалидная структура, логируем и не обновляем или ставим пустой массив
        logger.warn('[AuthService updateFollowClubs] Received invalid structure for newFollowClubs. Setting to empty.', newFollowClubs);
        normalizedNewFollowClubs = { clubs: [] };
      }

      const updatedProfile = {
        ...this.state.userProfile,
        follow_clubs: normalizedNewFollowClubs,
      };
      this.setState({ userProfile: updatedProfile });
      localStorage.setItem('lichess_user_profile', JSON.stringify(updatedProfile));
      logger.info('[AuthService] Followed clubs updated in state and localStorage:', normalizedNewFollowClubs);
    } else {
      logger.warn('[AuthService updateFollowClubs] Cannot update follow_clubs: userProfile is null.');
    }
  }

  // Геттеры
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
  // Обновленный геттер
  public getFollowClubs(): FollowClubs | undefined {
    // Обеспечиваем возврат корректной структуры или undefined
    if (this.state.userProfile?.follow_clubs && Array.isArray(this.state.userProfile.follow_clubs.clubs)) {
        return this.state.userProfile.follow_clubs;
    }
    return undefined; // или { clubs: [] } если это предпочтительнее для потребителей
  }
}

export const AuthService = new AuthServiceController();