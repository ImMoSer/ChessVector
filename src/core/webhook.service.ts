// src/core/webhook.service.ts
import logger from '../utils/logger';

export interface PuzzleRequestPayload {
  lichess_id: string;
  pieceCount?: number;
  rating?: number;
}

export interface PuzzleDataFromWebhook {
  FEN_0: string;
  HumanColor: 'white' | 'black';
  Moves: string;
  Rating?: string;
  PuzzleId: string;
  PieceCount?: string;
}

export interface AppPuzzle extends PuzzleDataFromWebhook {
}

// Чтение URL вебхука из переменных окружения Vite
// Убедитесь, что в вашем файле .env есть переменная VITE_WEBHOOK_PUZZLE_FEN
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
    // Используем URL из переменной окружения
    this.puzzleWebhookUrl = PUZZLE_FEN_WEBHOOK_URL;
    if (this.puzzleWebhookUrl) {
        logger.info(`[WebhookService] Initialized with URL from VITE_WEBHOOK_PUZZLE_FEN: ${this.puzzleWebhookUrl}`);
    } else {
        // Это сообщение будет показано, если проверка выше была закомментирована и приложение продолжило работу
        logger.error(`[WebhookService] Initialization failed: Webhook URL is undefined. Check VITE_WEBHOOK_PUZZLE_FEN.`);
    }
  }

  public async fetchPuzzle(): Promise<AppPuzzle | null> {
    if (!this.puzzleWebhookUrl) {
        logger.error("[WebhookService] Cannot fetch puzzle: Webhook URL is not configured.");
        return null;
    }

    const hardcodedPayload: PuzzleRequestPayload = {
      lichess_id: "valid_all",
      pieceCount: 4,
      rating: 600
    };

    logger.info(`[WebhookService] Sending POST request to: ${this.puzzleWebhookUrl}`);
    logger.debug('[WebhookService] Request payload (hardcoded):', hardcodedPayload);

    try {
      const response = await fetch(this.puzzleWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(hardcodedPayload),
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

// --- Пример использования (раскомментируйте для проверки) ---
// async function testFetchPuzzle() {
//   // const logger = { // Простой логгер для примера
//   //  info: console.log,
//   //  warn: console.warn,
//   //  error: console.error,
//   //  debug: console.log,
//   // };

//   // Перед созданием экземпляра WebhookService убедитесь, что VITE_WEBHOOK_PUZZLE_FEN доступна.
//   if (!import.meta.env.VITE_WEBHOOK_PUZZLE_FEN) {
//      logger.error("VITE_WEBHOOK_PUZZLE_FEN is not set. Aborting testFetchPuzzle.");
//      return;
//   }
//   const webhookService = new WebhookService();

//   logger.info('--- Starting testFetchPuzzle ---');
//   const puzzle = await webhookService.fetchPuzzle();

//   if (puzzle) {
//     logger.info('--- Puzzle received: ---', puzzle);
//   } else {
//     logger.warn('--- Failed to receive puzzle. ---');
//   }
//   logger.info('--- testFetchPuzzle finished ---');
// }

// testFetchPuzzle();
