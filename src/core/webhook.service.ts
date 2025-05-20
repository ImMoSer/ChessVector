// src/core/webhook.service.ts
import logger from '../utils/logger';
// Импортируем FinishHimStats из AuthService. Если это вызовет проблемы с циклическими зависимостями,
// то FinishHimStats и связанные типы лучше вынести в отдельный файл (например, src/types/stats.types.ts)
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

// --- Новые интерфейсы для отправки статистики FinishHim ---
/**
 * Payload для отправки обновленной статистики FinishHim на бэкенд.
 */
export interface FinishHimRatingUpdatePayload {
    event: "finishHimRatingUpdate";
    lichess_id: string;
    finishHimStats: FinishHimStats; // Полный объект статистики для обновления
}

// --- URL вебхуков ---
const PUZZLE_FEN_WEBHOOK_URL = import.meta.env.VITE_WEBHOOK_PUZZLE_FEN as string;
const FINISH_HIM_STATS_WEBHOOK_URL = import.meta.env.VITE_WEBHOOK_FINISH_HIM_STATS as string; // Новый URL

if (!PUZZLE_FEN_WEBHOOK_URL) {
  logger.error(
    '[WebhookService] Critical Configuration Error: VITE_WEBHOOK_PUZZLE_FEN is not defined in your .env file.'
  );
}
if (!FINISH_HIM_STATS_WEBHOOK_URL) {
  // Это предупреждение, так как основная функция fetchPuzzle может работать и без этого.
  logger.warn(
    '[WebhookService] Configuration Warning: VITE_WEBHOOK_FINISH_HIM_STATS is not defined. FinishHim stats updates will not be sent.'
  );
}

export class WebhookService {
  private puzzleWebhookUrl: string;
  private finishHimStatsWebhookUrl?: string; // Делаем опциональным, если не задан

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
  }

  /**
   * Fetches a puzzle from the webhook using the provided payload.
   * @param payload - The data to send in the request body.
   * @returns A promise that resolves to AppPuzzle or null.
   */
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

  /**
   * Sends updated FinishHim statistics to the backend.
   * @param lichess_id - The Lichess ID of the user.
   * @param stats - The FinishHimStats object to send.
   * @returns A promise that resolves to true if the update was successful (or at least sent without client-side error), false otherwise.
   */
  public async sendFinishHimStatsUpdate(lichess_id: string, stats: FinishHimStats): Promise<boolean> {
    if (!this.finishHimStatsWebhookUrl) {
      logger.warn("[WebhookService] Cannot send FinishHim stats: Stats Webhook URL is not configured. Update will be skipped.");
      return false; // Не удалось отправить, так как URL не настроен
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
          'Accept': 'application/json', // Бэкенд может вернуть обновленный профиль или просто статус
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
        return false; // Ошибка при отправке
      }

      // Можно дополнительно обработать ответ, если бэкенд что-то возвращает (например, обновленный UserSessionProfile)
      // const responseData = await response.json();
      // logger.info('[WebhookService sendFinishHimStatsUpdate] Successfully sent stats. Response data:', responseData);
      logger.info('[WebhookService sendFinishHimStatsUpdate] Successfully sent FinishHim stats to backend.');
      return true; // Успешно отправлено
    } catch (error: any) {
      logger.error('[WebhookService sendFinishHimStatsUpdate] Network or fetch error:', error.message, error);
      return false; // Ошибка при отправке
    }
  }
}
