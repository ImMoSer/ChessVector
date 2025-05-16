// src/AppEntry.ts
import { init, propsModule, eventListenersModule, styleModule, classModule } from 'snabbdom';
import type { VNode } from 'snabbdom';
import './assets/style.css'
import './features/common/promotion/promotion.css';

// Импорт общих сервисов
import { ChessboardService } from './core/chessboard.service';
import { StockfishService } from './core/stockfish.service';
import { WebhookService } from './core/webhook.service';
import logger from './utils/logger';

// Импорт главного контроллера и вида приложения
import { AppController } from './AppController';
import { renderAppUI } from './appView';

// Стили chessground
import './vendor/chessground/chessground.base.css';
import './vendor/chessground/chessground.brown.css';
import './vendor/chessground/chessground.cburnett.css';


logger.info('[AppEntry] Application starting...');

// 1. Инициализация Snabbdom patch функции
const patch = init([
  propsModule,
  eventListenersModule,
  styleModule,
  classModule,
]);

// 2. Создание экземпляров общих сервисов
const chessboardService = new ChessboardService();
const stockfishService = new StockfishService();
const webhookService = new WebhookService();

// 3. Получение корневого элемента для монтирования приложения
let oldVNode: VNode | Element = document.getElementById('app')!;
if (!oldVNode) {
  logger.error("[AppEntry] Root element #app not found in index.html. Application cannot start.");
  throw new Error("Root element #app not found in index.html");
}

// 4. Флаг для предотвращения вложенных вызовов patch
let isCurrentlyPatching = false;

// 5. Функция для запроса перерисовки всего UI приложения
function requestGlobalRedraw() {
  if (isCurrentlyPatching) {
    logger.warn("[AppEntry requestGlobalRedraw] Skipped as a patch is already in progress.");
    return;
  }
  isCurrentlyPatching = true;
  const newVNode = renderAppUI(appController);
  oldVNode = patch(oldVNode, newVNode);
  isCurrentlyPatching = false;
  logger.debug("[AppEntry requestGlobalRedraw] Main application view re-rendered and patch completed.");
}

// 6. Создание экземпляра главного контроллера приложения
// ИСПРАВЛЕНО: Удален chessLogicService из передаваемых сервисов
const appController = new AppController(
  { 
    chessboardService,
    stockfishService,
    webhookService,
    logger
  },
  requestGlobalRedraw 
);

// 7. Начальная инициализация и отрисовка приложения
logger.info('[AppEntry] Initializing AppController and performing first render...');
appController.initializeApp(); 

// 8. Обработчик для корректного завершения работы Stockfish при закрытии вкладки
window.addEventListener('beforeunload', () => {
    logger.info('[AppEntry] beforeunload event triggered. Terminating Stockfish.');
    stockfishService.terminate();
});

// 9. Отслеживание изменения размера окна для адаптивной навигации
window.addEventListener('resize', () => {
    appController.handleResize();
});


logger.info('[AppEntry] Application mounted and AppController initialized.');
