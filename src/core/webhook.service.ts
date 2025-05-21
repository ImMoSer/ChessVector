// src/core/webhook.service.ts
import logger from '../utils/logger';
import type { FinishHimStats } from './auth.service';

// --- Существующие интерфейсы для fetchPuzzle ---
export interface PuzzleRequestPayload {
  event?: string;
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

// --- Существующие интерфейсы для отправки статистики FinishHim ---
export interface FinishHimRatingUpdatePayload {
    event: "finishHimRatingUpdate";
    lichess_id: string;
    finishHimStats: FinishHimStats;
}

// --- Новые интерфейсы для Club Stats ---
export interface ClubStatsRequestPayload {
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
  topMax?: number; // Добавлено новое поле
}

export type ClubStatsResponse = ClubData[] | ClubData;


// --- URL вебхуков ---
const PUZZLE_FEN_WEBHOOK_URL = import.meta.env.VITE_WEBHOOK_PUZZLE_FEN as string;
const FINISH_HIM_STATS_WEBHOOK_URL = import.meta.env.VITE_WEBHOOK_FINISH_HIM_STATS as string;
const CLUB_STATS_WEBHOOK_URL = import.meta.env.VITE_WEBHOOK_CLUB_STATS as string;

if (!PUZZLE_FEN_WEBHOOK_URL) {
  logger.error(
    '[WebhookService] Critical Configuration Error: VITE_WEBHOOK_PUZZLE_FEN is not defined in your .env file.'
  );
}
if (!FINISH_HIM_STATS_WEBHOOK_URL) {
  logger.warn(
    '[WebhookService] Configuration Warning: VITE_WEBHOOK_FINISH_HIM_STATS is not defined. FinishHim stats updates will not be sent.'
  );
}
if (!CLUB_STATS_WEBHOOK_URL) {
  logger.warn(
    '[WebhookService] Configuration Warning: VITE_WEBHOOK_CLUB_STATS is not defined. Club stats fetching will not work.'
  );
}

export class WebhookService {
  private puzzleWebhookUrl: string;
  private finishHimStatsWebhookUrl?: string;
  private clubStatsWebhookUrl?: string;

  constructor() {
    this.puzzleWebhookUrl = PUZZLE_FEN_WEBHOOK_URL;
    if (this.puzzleWebhookUrl) {
        logger.info(`[WebhookService] Puzzle Webhook Initialized with URL: ${this.puzzleWebhookUrl}`);
    } else {
        logger.error(`[WebhookService] Puzzle Webhook Initialization failed: URL is undefined. Check VITE_WEBHOOK_PUZZLE_FEN.`);
    }

    if (FINISH_HIM_STATS_WEBHOOK_URL) {
        this.finishHimStatsWebhookUrl = FINISH_HIM_STATS_WEBHOOK_URL;
        logger.info(`[WebhookService] FinishHim Stats Webhook Initialized with URL: ${this.finishHimStatsWebhookUrl}`);
    } else {
        logger.warn(`[WebhookService] FinishHim Stats Webhook not configured. Updates will not be sent.`);
    }

    if (CLUB_STATS_WEBHOOK_URL) {
        this.clubStatsWebhookUrl = CLUB_STATS_WEBHOOK_URL;
        logger.info(`[WebhookService] Club Stats Webhook Initialized with URL: ${this.clubStatsWebhookUrl}`);
    } else {
        logger.warn(`[WebhookService] Club Stats Webhook not configured. Club stats fetching will not work.`);
    }
  }

  public async fetchPuzzle(payload: PuzzleRequestPayload): Promise<AppPuzzle | null> {
    if (!this.puzzleWebhookUrl) {
        logger.error("[WebhookService] Cannot fetch puzzle: Puzzle Webhook URL is not configured.");
        return null;
    }

    logger.info(`[WebhookService] Sending POST request to Puzzle Webhook: ${this.puzzleWebhookUrl}`);
    logger.debug('[WebhookService] Request payload for fetchPuzzle:', payload);

    try {
      const response = await fetch(this.puzzleWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      logger.info(`[WebhookService fetchPuzzle] Response status: ${response.status}`);

      if (!response.ok) {
        let errorText = `HTTP error! Status: ${response.status} ${response.statusText}`;
        try {
          const responseBody = await response.text();
          if (responseBody) errorText += ` Body: ${responseBody}`;
        } catch (e) { /* ignore */ }
        logger.error(`[WebhookService fetchPuzzle] ${errorText}`);
        return null;
      }

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const puzzleData = (await response.json()) as PuzzleDataFromWebhook;
        if (puzzleData && puzzleData.PuzzleId) {
            logger.info('[WebhookService fetchPuzzle] Successfully fetched puzzle data:', puzzleData);
            return puzzleData as AppPuzzle;
        } else {
            logger.warn('[WebhookService fetchPuzzle] Fetched data is missing PuzzleId or is malformed. Response:', puzzleData);
            return null;
        }
      } else {
        const responseText = await response.text();
        logger.warn(
          `[WebhookService fetchPuzzle] Response was not JSON. Content-Type: ${contentType}. Response text:`,
          responseText,
        );
        return null;
      }
    } catch (error: any) {
      logger.error('[WebhookService fetchPuzzle] Network or fetch error:', error.message, error);
      return null;
    }
  }

  public async sendFinishHimStatsUpdate(lichess_id: string, stats: FinishHimStats): Promise<boolean> {
    if (!this.finishHimStatsWebhookUrl) {
      logger.warn("[WebhookService] Cannot send FinishHim stats: Stats Webhook URL is not configured. Update will be skipped.");
      return false;
    }

    const payload: FinishHimRatingUpdatePayload = {
      event: "finishHimRatingUpdate",
      lichess_id: lichess_id,
      finishHimStats: stats,
    };

    logger.info(`[WebhookService] Sending POST request to FinishHim Stats Webhook: ${this.finishHimStatsWebhookUrl}`);
    logger.debug('[WebhookService] Request payload for sendFinishHimStatsUpdate:', payload);

    try {
      const response = await fetch(this.finishHimStatsWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      logger.info(`[WebhookService sendFinishHimStatsUpdate] Response status: ${response.status}`);

      if (!response.ok) {
        let errorText = `HTTP error! Status: ${response.status} ${response.statusText}`;
        try {
          const responseBody = await response.text();
          if (responseBody) errorText += ` Body: ${responseBody}`;
        } catch (e) { /* ignore */ }
        logger.error(`[WebhookService sendFinishHimStatsUpdate] ${errorText}`);
        return false;
      }
      logger.info('[WebhookService sendFinishHimStatsUpdate] Successfully sent FinishHim stats to backend.');
      return true;
    } catch (error: any) {
      logger.error('[WebhookService sendFinishHimStatsUpdate] Network or fetch error:', error.message, error);
      return false;
    }
  }

  public async fetchClubStats(payload: ClubStatsRequestPayload): Promise<ClubData | null> {
    if (!this.clubStatsWebhookUrl) {
        logger.error("[WebhookService] Cannot fetch club stats: Club Stats Webhook URL is not configured.");
        return null;
    }

    logger.info(`[WebhookService] Sending POST request to Club Stats Webhook: ${this.clubStatsWebhookUrl}`);
    logger.debug('[WebhookService] Request payload for fetchClubStats:', payload);

    try {
      const response = await fetch(this.clubStatsWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      logger.info(`[WebhookService fetchClubStats] Response status: ${response.status}`);

      if (!response.ok) {
        let errorText = `HTTP error! Status: ${response.status} ${response.statusText}`;
        try {
          const responseBody = await response.text();
          if (responseBody) errorText += ` Body: ${responseBody}`;
        } catch (e) { /* ignore */ }
        logger.error(`[WebhookService fetchClubStats] ${errorText}`);
        return null;
      }

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const responseData = (await response.json()) as ClubStatsResponse;
        
        if (Array.isArray(responseData)) {
          if (responseData.length > 0 && responseData[0].club_id) {
              logger.info('[WebhookService fetchClubStats] Successfully fetched club data (from array):', responseData[0]);
              return responseData[0];
          } else {
              logger.warn('[WebhookService fetchClubStats] Fetched data is an empty array or malformed. Response:', responseData);
              return null;
          }
        } else if (responseData && typeof responseData === 'object' && (responseData as ClubData).club_id) {
          logger.info('[WebhookService fetchClubStats] Successfully fetched club data (single object):', responseData);
          return responseData as ClubData;
        } else {
          logger.warn('[WebhookService fetchClubStats] Fetched data is not in the expected format (array or single ClubData object) or is malformed. Response:', responseData);
          return null;
        }
      } else {
        const responseText = await response.text();
        logger.warn(
          `[WebhookService fetchClubStats] Response was not JSON. Content-Type: ${contentType}. Response text:`,
          responseText,
        );
        return null;
      }
    } catch (error: any) {
      logger.error('[WebhookService fetchClubStats] Network or fetch error:', error.message, error);
      return null;
    }
  }
}
