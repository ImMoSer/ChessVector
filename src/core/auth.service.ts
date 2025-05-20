// src/core/auth.service.ts
import { OAuth2AuthCodePKCE, type AccessContext, type AccessToken } from '@bity/oauth2-auth-code-pkce';
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
}

export interface UserSessionUpsertPayload {
    event: "userSessionUpsert";
    lichess_id: string;
    username: string;
    lichessAccessToken: string;
}

// Структура ответа, ожидаемая от бэкенда на событие userSessionUpsert
export interface BackendUserSessionData {
    lichess_id: string;
    username?: string;
    FinishHimStats: FinishHimStats; // Ожидаем с большой F от бэкенда
    subscriptionTier: SubscriptionTier;
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

const USER_SESSION_WEBHOOK_URL = import.meta.env.VITE_WEBHOOK_USER_SESSION as string;

const TOKEN_URL = `${LICHESS_HOST}/api/token`;
const SCOPES = ['email:read', 'preference:read', 'board:play'];

class AuthServiceController {
  private oauthClient: OAuth2AuthCodePKCE;
  private readonly lichessTokenUrl: string;
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

    if (!REDIRECT_URI.startsWith('http://localhost') && !REDIRECT_URI.startsWith('https://')) {
        logger.error(`[AuthService] Critical Configuration Error: VITE_LICHESS_REDIRECT_URI must be an absolute URL. Current value: "${REDIRECT_URI}"`);
    }

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
            await this._fetchAndSetUserSessionProfile(token.value);
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

    if (!USER_SESSION_WEBHOOK_URL) {
        logger.error('[AuthService] Critical: VITE_WEBHOOK_USER_SESSION is not defined in .env file.');
    }
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

    this.state = { ...this.state, ...newState };

    if (
        (newState.isAuthenticated !== undefined && newState.isAuthenticated !== previousIsAuthenticated) ||
        (newState.isProcessing !== undefined && newState.isProcessing !== previousIsProcessing) ||
        (newState.error !== undefined && newState.error !== previousError) ||
        (newState.userProfile?.id !== undefined && newState.userProfile.id !== previousUserProfileId) ||
        (newState.userProfile?.finishHimStats !== undefined && JSON.stringify(newState.userProfile.finishHimStats) !== previousFinishHimStats)
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
      return true;
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
      await this._fetchAndSetUserSessionProfile(token.value);
      this._clearAuthParamsFromUrl();
    } else {
      throw new Error('Received empty token from Lichess during callback.');
    }
  }

  private async _loadStoredSession(): Promise<void> {
    const storedToken = localStorage.getItem('lichess_token');
    if (storedToken) {
      logger.info('[AuthService] Found stored Lichess token. Validating session.');
      this.setState({ accessToken: storedToken });
      await this._fetchAndSetUserSessionProfile(storedToken);
      if (!this.state.isAuthenticated) {
        logger.warn('[AuthService] Stored token validation failed. User is logged out.');
        this.clearAuthDataLocal();
      }
    } else {
      logger.info('[AuthService] No stored Lichess token found.');
      this.clearAuthDataLocal();
    }
  }

  private async _fetchAndSetUserSessionProfile(lichessAccessToken: string): Promise<void> {
    logger.info('[AuthService] Fetching Lichess basic profile and then full user session from backend...');
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
      const lichessProfile: LichessUserProfile = await lichessResponse.json();
      logger.debug('[AuthService] Basic Lichess profile data received:', lichessProfile);

      const upsertPayload: UserSessionUpsertPayload = {
        event: "userSessionUpsert",
        lichess_id: lichessProfile.id,
        username: lichessProfile.username,
        lichessAccessToken: lichessAccessToken,
      };

      const backendResponse = await fetch(USER_SESSION_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(upsertPayload),
      });

      if (!backendResponse.ok) {
        const errorText = await backendResponse.text().catch(() => '');
        logger.error(`[AuthService] User session upsert to backend failed. Status: ${backendResponse.status}. Response: ${errorText}`);
        throw new Error(`Backend userSessionUpsert failed: ${backendResponse.status}`);
      }

      // Бэкенд возвращает ОДИН ОБЪЕКТ, а не массив
      const backendSpecificData = await backendResponse.json() as Partial<BackendUserSessionData>;
      logger.debug('[AuthService] Raw backendSpecificData from JSON parse:', JSON.stringify(backendSpecificData));

      if (!backendSpecificData || typeof backendSpecificData !== 'object') {
        logger.error('[AuthService] Backend returned invalid data (not an object). backendSpecificData:', backendSpecificData);
        throw new Error("Backend returned invalid session data object");
      }

      if (lichessProfile.id !== backendSpecificData.lichess_id) {
        logger.error(
            `Lichess ID mismatch. Lichess API: ${lichessProfile.id}, Backend: ${backendSpecificData.lichess_id}`
        );
        throw new Error("Lichess ID mismatch between Lichess API and backend response");
      }
      
      if (!backendSpecificData.FinishHimStats || typeof backendSpecificData.subscriptionTier === 'undefined') {
          logger.error('[AuthService] Backend response missing required fields: FinishHimStats (capital F) or subscriptionTier.', backendSpecificData);
          throw new Error('Backend response missing required fields.');
      }

      const finalUserSessionProfile: UserSessionProfile = {
        ...lichessProfile,
        subscriptionTier: backendSpecificData.subscriptionTier as SubscriptionTier,
        finishHimStats: backendSpecificData.FinishHimStats as FinishHimStats,
      };

      localStorage.setItem('lichess_user_profile', JSON.stringify(finalUserSessionProfile));
      this.setState({
        userProfile: finalUserSessionProfile,
        isAuthenticated: true,
        accessToken: lichessAccessToken,
        error: null,
      });

    } catch (error: any) {
      logger.error('[AuthService] Error in _fetchAndSetUserSessionProfile:', error.message, error.stack);
      this.clearAuthDataLocal();
      this.setState({ isAuthenticated: false, userProfile: null, accessToken: null, error: `Failed to establish session: ${error.message}` });
    }
  }

  private _clearAuthParamsFromUrl(): void {
    const newUrl = window.location.pathname + window.location.hash;
    if (window.location.search) {
        window.history.replaceState({}, document.title, newUrl);
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
        await fetch(this.lichessTokenUrl, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${tokenToRevoke}` },
        });
        logger.info('[AuthService] Lichess token revoked successfully.');
      } catch (err) {
        logger.error('[AuthService] Error while revoking Lichess token:', err);
      }
    }
    this.clearAuthDataLocal();
    this.setState({ isProcessing: false, error: null });
  }

  private clearAuthDataLocal(): void {
    localStorage.removeItem('lichess_token');
    localStorage.removeItem('lichess_user_profile');
    this.setState({ accessToken: null, userProfile: null, isAuthenticated: false });
    logger.info('[AuthService] Local authentication data cleared.');
  }

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
}

export const AuthService = new AuthServiceController();
