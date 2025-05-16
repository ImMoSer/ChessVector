// src/puzzleEntry.ts
// ИСПРАВЛЕНО: Удален неиспользуемый импорт 'h'
import { init, propsModule, eventListenersModule, styleModule, classModule } from 'snabbdom';
import type { VNode } from 'snabbdom';
import { ChessboardService } from './core/chessboard.service';
// ChessLogicService больше не нужен для PuzzleController
// import { ChessLogicService } from './core/chess-logic.service';
import { WebhookService } from './core/webhook.service';
import { StockfishService } from './core/stockfish.service';
import { BoardHandler } from './core/boardHandler'; // Импортируем BoardHandler
import logger from './utils/logger';
import { PuzzleController } from './features/puzzle/PuzzleController';
import { renderPuzzleUI } from './features/puzzle/puzzleView'; // Убедимся, что экспорт корректен

import './vendor/chessground/chessground.base.css';
import './vendor/chessground/chessground.brown.css';
import './vendor/chessground/chessground.cburnett.css';
import './features/common/promotion/promotion.css'; // Стили для промоушена
import './assets/style.css';


const patch = init([
  propsModule,
  eventListenersModule,
  styleModule,
  classModule,
]);

const chessboardService = new ChessboardService();
// const chessLogicService = new ChessLogicService(); // Удаляем экземпляр ChessLogicService
const webhookService = new WebhookService();
const stockfishService = new StockfishService();

let oldVNode: VNode | Element = document.getElementById('app')!;
if (!oldVNode) {
  logger.error("[puzzleEntry.ts] Root element #app not found in index.html. Application cannot start.");
  throw new Error("Root element #app not found in index.html");
}

let isCurrentlyPatching = false;

function requestRedraw() {
  if (isCurrentlyPatching) {
    logger.warn("[puzzleEntry.ts requestRedraw] Skipped as a patch is already in progress.");
    return;
  }
  isCurrentlyPatching = true;
  const newVNode = renderPuzzleUI(puzzleController);
  oldVNode = patch(oldVNode, newVNode);
  isCurrentlyPatching = false;
  logger.debug("[puzzleEntry.ts requestRedraw] View re-rendered and patch completed.");
}

// Создаем экземпляр BoardHandler
const boardHandler = new BoardHandler(chessboardService, requestRedraw);

// Создание экземпляра контроллера пазлов с BoardHandler
const puzzleController = new PuzzleController(
  chessboardService,
  boardHandler, // Передаем BoardHandler
  webhookService,
  stockfishService,
  requestRedraw
);

logger.info('[puzzleEntry.ts] Application initializing...');
puzzleController.initializeGame();

window.addEventListener('beforeunload', () => {
    logger.info('[puzzleEntry.ts] beforeunload event triggered. Terminating Stockfish.');
    stockfishService.terminate();
});

logger.info('[puzzleEntry.ts] Application mounted and first puzzle loading initiated.');

