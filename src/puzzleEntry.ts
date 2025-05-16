// src/puzzleEntry.ts
import { init, h, propsModule, eventListenersModule, styleModule, classModule } from 'snabbdom';
import type { VNode } from 'snabbdom';
import { ChessboardService } from './core/chessboard.service';
import { ChessLogicService } from './core/chess-logic.service';
import { WebhookService } from './core/webhook.service';
import { StockfishService } from './core/stockfish.service';
import logger from './utils/logger';
import { PuzzleController } from './features/puzzle/PuzzleController';
import { renderPuzzleUI } from './features/puzzle/puzzleView';
import './vendor/chessground/chessground.base.css'; // Путь относительный от puzzleEntry.ts
import './vendor/chessground/chessground.brown.css';
import './vendor/chessground/chessground.cburnett.css';

import './assets/style.css';


// Инициализация Snabbdom
const patch = init([
  propsModule,
  eventListenersModule,
  styleModule,
  classModule,
]);

// Создание экземпляров сервисов
const chessboardService = new ChessboardService();
const chessLogicService = new ChessLogicService();
const webhookService = new WebhookService();
const stockfishService = new StockfishService();

// Переменная для хранения предыдущего VNode
let oldVNode: VNode | Element = document.getElementById('app')!;
if (!oldVNode) {
  throw new Error("Root element #app not found in index.html");
}

// Флаг для предотвращения вложенных вызовов patch
let isCurrentlyPatching = false;

// Функция для запроса перерисовки UI
function requestRedraw() {
  if (isCurrentlyPatching) {
    logger.warn("[puzzleEntry.ts requestRedraw] Skipped as a patch is already in progress.");
    return;
  }
  isCurrentlyPatching = true;
  // Теперь renderPuzzleUI будет получать контроллер и возвращать VNode
  const newVNode = renderPuzzleUI(puzzleController);
  oldVNode = patch(oldVNode, newVNode);
  isCurrentlyPatching = false;
  logger.debug("[puzzleEntry.ts requestRedraw] View re-rendered and patch completed.");
}

// Создание экземпляра контроллера пазлов
const puzzleController = new PuzzleController(
  chessboardService,
  chessLogicService,
  webhookService,
  stockfishService,
  requestRedraw // Передаем функцию requestRedraw в контроллер
);

// Начальная инициализация приложения
logger.info('[puzzleEntry.ts] Application initializing...');
puzzleController.initializeGame(); // Инициализируем игру через контроллер

// Обработчик для корректного завершения работы Stockfish при закрытии вкладки
window.addEventListener('beforeunload', () => {
    logger.info('[puzzleEntry.ts] beforeunload event triggered. Terminating Stockfish.');
    stockfishService.terminate();
});

logger.info('[puzzleEntry.ts] Application mounted and first puzzle loading initiated.');
