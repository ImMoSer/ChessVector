// src/puzzleEntry.ts
import { init, propsModule, eventListenersModule, styleModule, classModule } from 'snabbdom';
import type { VNode } from 'snabbdom'; // VNode is used for oldVNode and the result of patch
import { ChessboardService } from './core/chessboard.service';
import { WebhookService } from './core/webhook.service';
import { StockfishService } from './core/stockfish.service';
import { BoardHandler } from './core/boardHandler';
import logger from './utils/logger';
import { PuzzleController } from './features/puzzle/PuzzleController';
import { renderPuzzleUI, type PuzzlePageViewLayout } from './features/puzzle/puzzleView'; // PuzzlePageViewLayout is used for typing the result of renderPuzzleUI

import './vendor/chessground/chessground.base.css';
import './vendor/chessground/chessground.brown.css'; // Assuming this is your active theme CSS
// import './vendor/chessground/chessground.cburnett.css'; // cburnett is likely for pieces
import './features/common/promotion/promotion.css';
import './assets/style.css';


const patch = init([
  propsModule,
  eventListenersModule,
  styleModule,
  classModule,
]);

const chessboardService = new ChessboardService();
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
  // Используем .center, так как renderPuzzleUI возвращает PuzzlePageViewLayout,
  // а для puzzleEntry нам нужна только центральная VNode для #app.
  const puzzleLayout: PuzzlePageViewLayout = renderPuzzleUI(puzzleController);
  const newVNode: VNode = puzzleLayout.center; // <--- ИЗМЕНЕНИЕ ЗДЕСЬ
  oldVNode = patch(oldVNode, newVNode);
  isCurrentlyPatching = false;
  logger.debug("[puzzleEntry.ts requestRedraw] View re-rendered and patch completed.");
}

const boardHandler = new BoardHandler(chessboardService, requestRedraw);

const puzzleController = new PuzzleController(
  chessboardService,
  boardHandler,
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
