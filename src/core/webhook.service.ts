// src/core/webhook.service.ts
import logger from '../utils/logger';
// Импортируем типы, которые раньше были в auth.service, но теперь нужны здесь для нового метода
import type { FinishHimStats, SubscriptionTier, UserSessionUpsertPayload, BackendUserSessionData, LedClubs } from './auth.service';

// --- Интерфейсы для Puzzle ---
export interface PuzzleRequestPayload {
  event?: string; // Это поле уже используется, например, "FinishHim"
  lichess_id: string;
  pieceCount?: number;
  rating?: number;
  puzzleType?: string;
}

export interface PuzzleDataFromWebhook {
  FEN_0: string;
  HumanColor: 'white' | 'black';
  Moves: string;
  Rating?: string;
  PuzzleId: string;
  PieceCount?: string;
}

export interface AppPuzzle extends PuzzleDataFromWebhook {}

// --- Интерфейсы для FinishHim Stats ---
export interface FinishHimRatingUpdatePayload {
    event: "finishHimRatingUpdate"; // Поле event уже есть
    lichess_id: string;
    finishHimStats: FinishHimStats;
}

// --- Интерфейсы для Club Stats ---
export interface ClubStatsRequestPayload {
  event: "fetchClubStats"; // Добавлено поле event
  club_id: string;
}

export interface ClubPlayer {
  user: {
    id: string;
    name: string;
    flair?: string;
    title?: string;
  };
  score: number;
}

export interface ClubBattle {
  club_id: string;
  players: ClubPlayer[];
  arena_id: string;
  duration: number;
  fullName: string;
  arena_url: string;
  club_rank: number;
  club_score: number;
  startsAt_ms: number;
  clock_control: {
    limit: number;
    increment: number;
  };
  startsAt_Date: string;
}

export interface ClubLeader {
  id: string;
  name: string;
  flair?: string;
  title?: string;
}

export interface ClubData {
  club_id: string;
  jsonb_array_battle: ClubBattle[];
  club_name: string;
  grunder: string;
  nb_members: string;
  jsonb_array_leader: ClubLeader[];
  club_bild?: string;
  topMax?: number;
}

export type ClubStatsResponse = ClubData[] | ClubData;

// --- Интерфейсы для Leaderboards (Страница Рекордов) ---
export interface RawLeaderboardUserData {
  lichess_id: string;
  username: string;
  FinishHimStats: FinishHimStats;
  subscriptionTier: SubscriptionTier;
  led_clubs?: LedClubs; // Добавлено поле led_clubs, если оно приходит от бэкенда для лидербордов
}

export interface LeaderboardsApiResponse {
  leaderboards: { [lichess_id: string]: RawLeaderboardUserData };
}

export interface FetchLeaderboardsRequestPayload {
  event: "fetchAllUserStats"; // Поле event уже есть
}

// --- URL единого бэкенд вебхука ---
const BACKEND_URL = import.meta.env.VITE_BACKEND as string;

if (!BACKEND_URL) {
  logger.error(
    '[WebhookService] Critical Configuration Error: VITE_BACKEND is not defined in your .env file.'
  );
}

export class WebhookServiceController {
  private backendWebhookUrl: string;

  constructor() {
    this.backendWebhookUrl = BACKEND_URL;
    if (this.backendWebhookUrl) {
        logger.info(`[WebhookService] Initialized with Backend URL: ${this.backendWebhookUrl}`);
    } else {
        logger.error(`[WebhookService] Initialization failed: Backend URL (VITE_BACKEND) is undefined.`);
    }
  }

  private async _postRequest<TResponse, TPayload extends { event?: string }>(
    payload: TPayload,
    context: string
  ): Promise<TResponse | null> {
    if (!this.backendWebhookUrl) {
      logger.error(`[WebhookService ${context}] Cannot send request: Backend URL is not configured.`);
      return null;
    }

    logger.info(`[WebhookService ${context}] Sending POST request to Backend URL: ${this.backendWebhookUrl}`);
    logger.debug(`[WebhookService ${context}] Request payload:`, payload);

    try {
      const response = await fetch(this.backendWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      logger.info(`[WebhookService ${context}] Response status: ${response.status}`);

      if (!response.ok) {
        let errorText = `HTTP error! Status: ${response.status} ${response.statusText}`;
        try {
          const responseBody = await response.text();
          if (responseBody) errorText += ` Body: ${responseBody}`;
        } catch (e) { /* ignore */ }
        logger.error(`[WebhookService ${context}] ${errorText}`);
        return null;
      }

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const responseData = (await response.json()) as TResponse;
        logger.info(`[WebhookService ${context}] Successfully fetched data.`);
        logger.debug(`[WebhookService ${context}] Response data:`, responseData);
        return responseData;
      } else {
        const responseText = await response.text();
        logger.warn(
          `[WebhookService ${context}] Response was not JSON. Content-Type: ${contentType}. Response text:`,
          responseText,
        );
        return null;
      }
    } catch (error: any) {
      logger.error(`[WebhookService ${context}] Network or fetch error:`, error.message, error);
      return null;
    }
  }

  public async fetchPuzzle(payload: PuzzleRequestPayload): Promise<AppPuzzle | null> {
    // Убедимся, что event установлен, если он не пришел из payload
    const finalPayload = { ...payload, event: payload.event || "FinishHim" };
    const puzzleData = await this._postRequest<PuzzleDataFromWebhook, PuzzleRequestPayload>(finalPayload, "fetchPuzzle");
    if (puzzleData && puzzleData.PuzzleId) {
        return puzzleData as AppPuzzle;
    } else if (puzzleData) { // Если puzzleData есть, но нет PuzzleId
        logger.warn('[WebhookService fetchPuzzle] Fetched data is missing PuzzleId or is malformed. Response:', puzzleData);
    }
    return null;
  }

  public async sendFinishHimStatsUpdate(lichess_id: string, stats: FinishHimStats): Promise<boolean> {
    const payload: FinishHimRatingUpdatePayload = {
      event: "finishHimRatingUpdate",
      lichess_id: lichess_id,
      finishHimStats: stats,
    };
    const response = await this._postRequest<any, FinishHimRatingUpdatePayload>(payload, "sendFinishHimStatsUpdate");
    return !!response; // Считаем успешным, если ответ не null (т.е. запрос прошел без ошибок)
  }

  public async fetchClubStats(club_id: string): Promise<ClubData | null> {
    const payload: ClubStatsRequestPayload = {
        event: "fetchClubStats",
        club_id: club_id
    };
    const responseData = await this._postRequest<ClubStatsResponse, ClubStatsRequestPayload>(payload, "fetchClubStats");

    if (responseData) {
        if (Array.isArray(responseData)) {
            if (responseData.length > 0 && responseData[0].club_id) {
                return responseData[0];
            } else {
                logger.warn('[WebhookService fetchClubStats] Fetched data is an empty array or malformed (array). Response:', responseData);
                return null;
            }
        } else if (typeof responseData === 'object' && (responseData as ClubData).club_id) {
            return responseData as ClubData;
        } else {
            logger.warn('[WebhookService fetchClubStats] Fetched data is not in the expected format (array or single ClubData object) or is malformed. Response:', responseData);
            return null;
        }
    }
    return null;
  }

  public async fetchAllUserStatsForLeaderboards(): Promise<RawLeaderboardUserData[] | null> {
    const payload: FetchLeaderboardsRequestPayload = {
        event: "fetchAllUserStats"
    };
    const apiResponse = await this._postRequest<LeaderboardsApiResponse, FetchLeaderboardsRequestPayload>(payload, "fetchAllUserStatsForLeaderboards");

    if (apiResponse &&
        typeof apiResponse === 'object' &&
        apiResponse.hasOwnProperty('leaderboards') &&
        typeof apiResponse.leaderboards === 'object' &&
        apiResponse.leaderboards !== null &&
        !Array.isArray(apiResponse.leaderboards)
        ) {
      const leaderboardsObject = apiResponse.leaderboards as { [key: string]: RawLeaderboardUserData };
      const dataArray: RawLeaderboardUserData[] = Object.values(leaderboardsObject);
      logger.info(`[WebhookService fetchAllUserStatsForLeaderboards] Successfully fetched and transformed ${dataArray.length} user stats entries.`);
      return dataArray;
    } else if (apiResponse) { // Если apiResponse есть, но структура неверная
      logger.warn('[WebhookService fetchAllUserStatsForLeaderboards] Fetched data is not in the expected format. Actual structure:', JSON.stringify(apiResponse));
    }
    return null;
  }

  // Новый метод для обработки сессии пользователя
  public async upsertUserSession(payload: UserSessionUpsertPayload): Promise<BackendUserSessionData | null> {
    // Поле 'event' уже должно быть в UserSessionUpsertPayload ("userSessionUpsert" или "oAuth")
    const sessionData = await this._postRequest<BackendUserSessionData, UserSessionUpsertPayload>(payload, "upsertUserSession");
    if (sessionData && sessionData.lichess_id && sessionData.FinishHimStats && typeof sessionData.subscriptionTier !== 'undefined') {
        return sessionData;
    } else if (sessionData) { // Если sessionData есть, но неполное
        logger.warn('[WebhookService upsertUserSession] Fetched data is missing required fields or is malformed. Response:', sessionData);
    }
    return null;
  }
}

// Экспортируем инстанс сервиса для использования в других модулях
export const WebhookService = new WebhookServiceController();
