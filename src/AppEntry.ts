// src/AppEntry.ts
import { init, propsModule, eventListenersModule, styleModule, classModule } from 'snabbdom';
import type { VNode } from 'snabbdom';
import './assets/style.css'
import './features/promotion/promotion.css';

// Импорт общих сервисов
import { ChessboardService } from './core/chessboard.service';
import { ChessLogicService } from './core/chess-logic.service';
import { StockfishService } from './core/stockfish.service';
import { WebhookService } from './core/webhook.service'; // Если нужен глобально, иначе можно инициализировать в контроллерах
import logger from './utils/logger';

// Импорт главного контроллера и вида приложения
import { AppController } from './AppController'; // Предполагаем, что AppController.ts будет в той же папке
import { renderAppUI } from './appView';     // Предполагаем, что appView.ts будет в той же папке

// Стили (если у вас есть общие стили для всего приложения, импортируйте их здесь)
// import './assets/main.css'; // Пример общего файла стилей
// Стили chessground (из вашей папки vendor)
import './vendor/chessground/chessground.base.css'; // Базовые стили доски
import './vendor/chessground/chessground.brown.css'; // Тема доски (например, коричневая)
import './vendor/chessground/chessground.cburnett.css'; // <--- СТИЛИ ФИГУР (например, тема cburnett)

import './assets/style.css'; // Ваши общие стили, если они применяются ко всему приложению

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
const chessLogicService = new ChessLogicService();
const stockfishService = new StockfishService();
const webhookService = new WebhookService(); // Создаем, если он нужен AppController или передается дальше

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
  // renderAppUI будет получать AppController и возвращать VNode для всего приложения
  const newVNode = renderAppUI(appController);
  oldVNode = patch(oldVNode, newVNode);
  isCurrentlyPatching = false;
  logger.debug("[AppEntry requestGlobalRedraw] Main application view re-rendered and patch completed.");
}

// 6. Создание экземпляра главного контроллера приложения
const appController = new AppController(
  { // Передаем объект с сервисами для удобства
    chessboardService,
    chessLogicService,
    stockfishService,
    webhookService,
    logger
  },
  requestGlobalRedraw // Передаем функцию для запроса перерисовки
);

// 7. Начальная инициализация и отрисовка приложения
logger.info('[AppEntry] Initializing AppController and performing first render...');
appController.initializeApp(); // Метод в AppController для начальной настройки (например, установка первой страницы)

// 8. Обработчик для корректного завершения работы Stockfish при закрытии вкладки
window.addEventListener('beforeunload', () => {
    logger.info('[AppEntry] beforeunload event triggered. Terminating Stockfish.');
    stockfishService.terminate();
});

// 9. Отслеживание изменения размера окна для адаптивной навигации
window.addEventListener('resize', () => {
    // AppController будет иметь метод для обработки изменения размера/ориентации
    appController.handleResize();
});


logger.info('[AppEntry] Application mounted and AppController initialized.');
