// src/core/webhook.service.ts
import logger from '../utils/logger';
import type {
  SubscriptionTier,
  UserSessionUpsertPayload,
  FinishHimStats,
  BackendUserSessionData,
  FollowClubs
} from './auth.service';

// --- Интерфейсы для Puzzle (режим FinishHim) ---
export interface PuzzleRequestPayload {
  event?: string;
  lichess_id: string;
  pieceCount?: number;
  rating?: number;
  puzzleType?: string;
  position_class?: string;
  material_difference?: number;
  num_pieces?: number;
  difficulty_class?: number;
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

// --- Интерфейсы для PlayFromFen ---
export interface PlayFromFenRequestPayload {
  event: "playFromFen";
  lichess_id: string;
  position_class: string;
  material_difference: number;
  num_pieces: number;
  difficulty_class: number;
}

// Ожидаемый формат одного объекта из массива ответа бэкенда
export interface PlayFromFenBackendEntry {
  fen: string;
  cp?: string | number; // cp может быть строкой или числом
  position_class?: string;
  difficulty_class?: string | number; // difficulty_class может быть строкой или числом
  // PuzzleId опционально, если бэкенд его возвращает
  PuzzleId?: string;
}

// Интерфейс для ответа, который будет использоваться в контроллере
export interface ProcessedPlayFromFenResponseData {
  FEN_0: string;
  cp?: number;
  position_class?: string;
  difficulty_class?: number;
  PuzzleId?: string;
}


// --- Интерфейсы для FinishHim Stats ---
export interface FinishHimRatingUpdatePayload {
    event: "finishHimRatingUpdate";
    lichess_id: string;
    finishHimStats: FinishHimStats;
}

// --- Интерфейсы для Club Stats ---
export interface ClubStatsRequestPayload {
  event: "fetchClubStats";
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

export interface AggregatedPlayerData {
  user: {
    id: string;
    name: string;
    title?: string;
    flair?: string;
  };
  totalScore: number;
  tournamentsPlayed: number;
  maxScoreInOneTournament: number;
  maxScoreTournamentName?: string;
  maxScoreTournamentArenaUrl?: string;
}

export interface ClubData {
  club_id: string;
  club_name: string;
  grunder: string;
  nb_members: number;
  club_bild?: string | null;
  topMax?: number;
  jsonb_array_leader: ClubLeader[];
  jsonb_array_battle: ClubBattle[];
  aggregated_player_stats: AggregatedPlayerData[];
  last_update?: string;
  last_arena?: string;
}

export type ClubStatsResponse = ClubData[] | ClubData;

// --- Интерфейсы для Leaderboards (Страница Рекордов) ---
export interface RawLeaderboardUserData {
  lichess_id: string;
  username: string;
  FinishHimStats: FinishHimStats;
  subscriptionTier: SubscriptionTier;
  follow_clubs?: FollowClubs;
}

export interface LeaderboardsApiResponse {
  leaderboards: { [lichess_id: string]: RawLeaderboardUserData };
}

export interface FetchLeaderboardsRequestPayload {
  event: "fetchAllUserStats";
}

// --- Интерфейс для Club Follow ---
export interface ClubFollowRequestPayload {
  event: "clubFollow";
  lichess_id: string;
  club_id: string;
  club_name: string;
  action: 'follow' | 'unfollow';
}

// --- Новые интерфейсы для User Cabinet ---
export interface UserCabinetDataFromWebhook {
  lichess_id: string;
  username: string;
  subscriptionTier: SubscriptionTier;
  FinishHimStats: FinishHimStats;
  follow_clubs?: FollowClubs;
  club_leader?: FollowClubs;
  club_founder?: FollowClubs;
}

export interface UserCabinetRequestPayload {
  event: "userCabinet";
  lichess_id: string;
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
        try {
            return JSON.parse(responseText) as TResponse;
        } catch (e) {
            logger.error(`[WebhookService ${context}] Failed to parse non-JSON response as JSON.`);
            return null;
        }
      }
    } catch (error: any) {
      logger.error(`[WebhookService ${context}] Network or fetch error:`, error.message, error);
      return null;
    }
  }

  public async fetchPuzzle(payload: PuzzleRequestPayload): Promise<AppPuzzle | null> {
    const finalPayload = { ...payload, event: payload.event || "FinishHim" };
    const puzzleData = await this._postRequest<PuzzleDataFromWebhook, PuzzleRequestPayload>(finalPayload, "fetchPuzzle");
    if (puzzleData && puzzleData.PuzzleId && puzzleData.FEN_0 && puzzleData.Moves) {
        return puzzleData as AppPuzzle;
    } else if (puzzleData && finalPayload.event === "FinishHim") {
        logger.warn('[WebhookService fetchPuzzle] Fetched data for FinishHim is missing required fields or is malformed. Response:', puzzleData);
    }
    return null;
  }

  public async fetchFenForPlay(payload: PlayFromFenRequestPayload): Promise<ProcessedPlayFromFenResponseData | null> {
    // Ожидаем ОДИН PlayFromFenBackendEntry объект от бэкенда, а не массив
    const entry = await this._postRequest<PlayFromFenBackendEntry, PlayFromFenRequestPayload>(payload, "fetchFenForPlay");

    if (entry && entry.fen) { // Проверяем, что entry существует и у него есть поле fen
        // Преобразуем в ProcessedPlayFromFenResponseData
        const processedData: ProcessedPlayFromFenResponseData = {
            FEN_0: entry.fen, // Переименовываем fen в FEN_0
            cp: entry.cp !== undefined ? (typeof entry.cp === 'string' ? parseInt(entry.cp, 10) : entry.cp) : undefined,
            position_class: entry.position_class,
            difficulty_class: entry.difficulty_class !== undefined ? (typeof entry.difficulty_class === 'string' ? parseInt(entry.difficulty_class, 10) : entry.difficulty_class) : undefined,
            PuzzleId: entry.PuzzleId
        };
        // Проверяем, что cp и difficulty_class стали числами, если были строками
        if (processedData.cp !== undefined && isNaN(processedData.cp)) {
            logger.warn('[WebhookService fetchFenForPlay] "cp" could not be parsed to a number:', entry.cp);
            processedData.cp = undefined;
        }
        if (processedData.difficulty_class !== undefined && isNaN(processedData.difficulty_class)) {
            logger.warn('[WebhookService fetchFenForPlay] "difficulty_class" could not be parsed to a number:', entry.difficulty_class);
            processedData.difficulty_class = undefined;
        }
        return processedData;
    } else if (entry) { // Если entry есть, но нет поля fen
        logger.warn('[WebhookService fetchFenForPlay] Response object is missing "fen" field or is malformed. Entry:', entry);
    } else { // Если entry вообще null (например, ошибка сети или HTTP)
         logger.warn('[WebhookService fetchFenForPlay] No data received from backend or request failed.');
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
    return !!response;
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
                if (!responseData[0].aggregated_player_stats) {
                    responseData[0].aggregated_player_stats = [];
                }
                return responseData[0];
            } else {
                logger.warn('[WebhookService fetchClubStats] Fetched data is an empty array or malformed (array). Response:', responseData);
                return null;
            }
        } else if (typeof responseData === 'object' && (responseData as ClubData).club_id) {
            if (!(responseData as ClubData).aggregated_player_stats) {
                (responseData as ClubData).aggregated_player_stats = [];
            }
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
    } else if (apiResponse) {
      logger.warn('[WebhookService fetchAllUserStatsForLeaderboards] Fetched data is not in the expected format. Actual structure:', JSON.stringify(apiResponse));
    }
    return null;
  }

  public async upsertUserSession(payload: UserSessionUpsertPayload): Promise<BackendUserSessionData | null> {
    const sessionData = await this._postRequest<BackendUserSessionData, UserSessionUpsertPayload>(payload, "upsertUserSession");
    if (sessionData && !Array.isArray(sessionData) && sessionData.lichess_id && sessionData.FinishHimStats && typeof sessionData.subscriptionTier !== 'undefined') {
        if (sessionData.follow_clubs && typeof sessionData.follow_clubs === 'object' && Object.keys(sessionData.follow_clubs).length === 0) {
            sessionData.follow_clubs = { clubs: [] };
        } else if (sessionData.follow_clubs && !Array.isArray((sessionData.follow_clubs as FollowClubs).clubs)) {
            sessionData.follow_clubs = { clubs: [] };
        }
        return sessionData;
    } else if (sessionData) {
        logger.warn('[WebhookService upsertUserSession] Fetched data is malformed, an array, or missing required fields. Response:', sessionData);
    }
    return null;
  }

  public async updateClubFollowStatus(payload: ClubFollowRequestPayload): Promise<BackendUserSessionData | null> {
    const sessionData = await this._postRequest<BackendUserSessionData, ClubFollowRequestPayload>(payload, "updateClubFollowStatus");
    if (sessionData && !Array.isArray(sessionData) && sessionData.lichess_id && sessionData.FinishHimStats && typeof sessionData.subscriptionTier !== 'undefined') {
        if (sessionData.follow_clubs && typeof sessionData.follow_clubs === 'object' && Object.keys(sessionData.follow_clubs).length === 0) {
            sessionData.follow_clubs = { clubs: [] };
        } else if (sessionData.follow_clubs && !Array.isArray((sessionData.follow_clubs as FollowClubs).clubs)) {
            sessionData.follow_clubs = { clubs: [] };
        }
        return sessionData;
    } else if (sessionData) {
        logger.warn('[WebhookService updateClubFollowStatus] Fetched data is malformed, an array, or missing required fields. Response:', sessionData);
    }
    return null;
  }

  public async fetchUserCabinetData(payload: UserCabinetRequestPayload): Promise<UserCabinetDataFromWebhook | null> {
    const userData = await this._postRequest<UserCabinetDataFromWebhook, UserCabinetRequestPayload>(payload, "fetchUserCabinetData");

    if (userData && userData.lichess_id) {
        const fieldsToNormalize: (keyof Pick<UserCabinetDataFromWebhook, 'follow_clubs' | 'club_leader' | 'club_founder'>)[] = ['follow_clubs', 'club_leader', 'club_founder'];

        fieldsToNormalize.forEach(field => {
            const clubAffiliation = userData[field] as FollowClubs | {} | undefined;
            if (clubAffiliation) {
                if (typeof clubAffiliation === 'object' && !Array.isArray((clubAffiliation as FollowClubs).clubs)) {
                    (userData[field] as FollowClubs) = { clubs: [] };
                }
            }
        });
        return userData;
    } else if (userData) {
        logger.warn('[WebhookService fetchUserCabinetData] Fetched data is missing lichess_id or is malformed. Response:', userData);
    } else {
        logger.warn('[WebhookService fetchUserCabinetData] _postRequest returned null.');
    }
    return null;
  }
}

export const WebhookService = new WebhookServiceController();
