// src/core/webhook.service.ts
import logger from '../utils/logger';

// Расширенный интерфейс для payload
export interface PuzzleRequestPayload {
  event?: string; // Добавлено поле event
  lichess_id: string;
  pieceCount?: number;
  rating?: number;
  puzzleType?: string; // Добавлено поле puzzleType
}

export interface PuzzleDataFromWebhook {
  FEN_0: string;
  HumanColor: 'white' | 'black';
  Moves: string;
  Rating?: string;
  PuzzleId: string;
  PieceCount?: string;
}

// AppPuzzle остается таким же, так как он описывает данные *ответа* от вебхука
export interface AppPuzzle extends PuzzleDataFromWebhook {
}

const PUZZLE_FEN_WEBHOOK_URL = import.meta.env.VITE_WEBHOOK_PUZZLE_FEN as string;

if (!PUZZLE_FEN_WEBHOOK_URL) {
  logger.error(
    '[WebhookService] Critical Configuration Error: VITE_WEBHOOK_PUZZLE_FEN is not defined in your .env file.'
  );
  // В реальном приложении здесь можно выбросить ошибку или предпринять другие действия
  // throw new Error('Critical Configuration Error: VITE_WEBHOOK_PUZZLE_FEN is not defined.');
}

export class WebhookService {
  private puzzleWebhookUrl: string;

  constructor() {
    this.puzzleWebhookUrl = PUZZLE_FEN_WEBHOOK_URL;
    if (this.puzzleWebhookUrl) {
        logger.info(`[WebhookService] Initialized with URL from VITE_WEBHOOK_PUZZLE_FEN: ${this.puzzleWebhookUrl}`);
    } else {
        logger.error(`[WebhookService] Initialization failed: Webhook URL is undefined. Check VITE_WEBHOOK_PUZZLE_FEN.`);
    }
  }

  /**
   * Fetches a puzzle from the webhook using the provided payload.
   * @param payload - The data to send in the request body.
   * @returns A promise that resolves to AppPuzzle or null.
   */
  public async fetchPuzzle(payload: PuzzleRequestPayload): Promise<AppPuzzle | null> {
    if (!this.puzzleWebhookUrl) {
        logger.error("[WebhookService] Cannot fetch puzzle: Webhook URL is not configured.");
        return null;
    }

    // Больше не используем hardcodedPayload, используем переданный payload
    logger.info(`[WebhookService] Sending POST request to: ${this.puzzleWebhookUrl}`);
    logger.debug('[WebhookService] Request payload:', payload);

    try {
      const response = await fetch(this.puzzleWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(payload), // Используем переданный payload
      });

      logger.info(`[WebhookService] Response status: ${response.status}`);

      if (!response.ok) {
        let errorText = `HTTP error! Status: ${response.status} ${response.statusText}`;
        try {
          const responseBody = await response.text();
          if (responseBody) {
            errorText += ` Body: ${responseBody}`;
          }
        } catch (e) {
          logger.warn(
            `[WebhookService] Could not read error response body for status ${response.status}`,
          );
        }
        logger.error(`[WebhookService] ${errorText}`);
        return null;
      }

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const puzzleData = (await response.json()) as PuzzleDataFromWebhook;
        logger.info('[WebhookService] Successfully fetched puzzle data (single object):', puzzleData);
        if (puzzleData && puzzleData.PuzzleId) {
            return puzzleData as AppPuzzle;
        } else {
            logger.warn('[WebhookService] Fetched data is missing PuzzleId or is malformed. Response:', puzzleData);
            return null;
        }
      } else {
        const responseText = await response.text();
        logger.warn(
          `[WebhookService] Response was not JSON. Content-Type: ${contentType}. Response text:`,
          responseText,
        );
        return null;
      }
    } catch (error: any) {
      logger.error('[WebhookService] Network or fetch error:', error.message, error);
      return null;
    }
  }
}

// --- Пример использования (для PuzzleController, теперь он должен передавать payload) ---
// async function testFetchPuzzleInPuzzleController() {
//   const webhookService = new WebhookService();
//   const examplePayloadForPuzzleMode: PuzzleRequestPayload = {
//     lichess_id: "valid_all", // или другое значение по умолчанию для старого режима
//     pieceCount: 10,
//     rating: 1800
//     // event и puzzleType могут отсутствовать для старого режима,
//     // или вебхук должен их игнорировать, если они нерелевантны
//   };
//   logger.info('--- Starting testFetchPuzzle (PuzzleController context) ---');
//   const puzzle = await webhookService.fetchPuzzle(examplePayloadForPuzzleMode);

//   if (puzzle) {
//     logger.info('--- Puzzle received: ---', puzzle);
//   } else {
//     logger.warn('--- Failed to receive puzzle. ---');
//   }
//   logger.info('--- testFetchPuzzle (PuzzleController context) finished ---');
// }
// testFetchPuzzleInPuzzleController();
