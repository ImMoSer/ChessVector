// src/AppEntry.ts
import { init, propsModule, eventListenersModule, styleModule, classModule, attributesModule } from 'snabbdom'; // ДОБАВЛЕН attributesModule
import type { VNode } from 'snabbdom';
// Import main application styles
import './assets/main.css'; // Main styles
import './features/common/promotion/promotion.css'; // Promotion specific styles
import './features/analysis/analysisPanel.css';
import './features/finishHim/finishHim.css';
import './features/welcome/welcome.css';
import './features/clubPage/clubPage.css';


// Import core services
import { ChessboardService } from './core/chessboard.service';
import { StockfishService } from './core/stockfish.service';
import { WebhookService } from './core/webhook.service';
import { initI18nService } from './core/i18n.service';
import logger from './utils/logger';

// Import main application controller and view
import { AppController } from './AppController';
import { renderAppUI } from './appView';

// Chessground styles
import './vendor/chessground/chessground.base.css';
import './vendor/chessground/chessground.brown.css';
import './vendor/chessground/chessground.cburnett.css';


logger.info('[AppEntry] Application starting...');

const patch = init([
  attributesModule, // <--- ДОБАВЛЕН ЗДЕСЬ
  propsModule,
  eventListenersModule,
  styleModule,
  classModule,
]);

const chessboardService = new ChessboardService();
const stockfishService = new StockfishService();
const webhookService = new WebhookService();

let oldVNode: VNode | Element = document.getElementById('app')!;
if (!oldVNode) {
  const errorMsg = "[AppEntry] Root element #app not found in index.html. Application cannot start.";
  logger.error(errorMsg);
  const body = document.body;
  if (body) {
      const errorDiv = document.createElement('div');
      errorDiv.textContent = errorMsg;
      errorDiv.style.color = 'red';
      errorDiv.style.padding = '20px';
      errorDiv.style.fontSize = '18px';
      body.prepend(errorDiv);
  }
  throw new Error(errorMsg);
}

let isCurrentlyPatching = false;
let appController: AppController; // Объявляем здесь

function requestGlobalRedraw() {
  if (isCurrentlyPatching) {
    logger.warn("[AppEntry requestGlobalRedraw] Skipped as a patch is already in progress.");
    return;
  }
  if (!appController) {
    logger.warn("[AppEntry requestGlobalRedraw] Skipped as appController is not yet initialized.");
    return;
  }
  isCurrentlyPatching = true;
  try {
    const newVNode = renderAppUI(appController);
    oldVNode = patch(oldVNode, newVNode);
    logger.debug("[AppEntry requestGlobalRedraw] Main application view re-rendered and patch completed.");
  } catch (error) {
    logger.error("[AppEntry requestGlobalRedraw] Error during patch:", error);
  } finally {
    isCurrentlyPatching = false;
  }
}

async function initializeApplication() {
  try {
    await initI18nService('en');
    logger.info('[AppEntry] i18n service initialized.');

    appController = new AppController(
      {
        chessboardService,
        stockfishService,
        webhookService,
        logger
      },
      requestGlobalRedraw
    );

    // initializeApp in AppController now handles auth and initial page loading
    await appController.initializeApp();
    logger.info('[AppEntry] AppController initialization sequence complete.');

  } catch (error) {
    logger.error('[AppEntry] Critical error during application initialization:', error);
    if (oldVNode instanceof Element) {
        const errorVNode = {
            sel: 'div',
            data: { style: { color: 'red', padding: '20px', fontSize: '18px', textAlign: 'center' } },
            children: [
                { sel: 'h1', data: {}, text: 'Application Initialization Failed' },
                { sel: 'p', data: {}, text: 'A critical error occurred. Please try refreshing the page or contact support.' },
                { sel: 'pre', data: { style: { whiteSpace: 'pre-wrap', fontSize: '12px' } }, text: (error as Error).message }
            ]
        };
        patch(oldVNode, errorVNode as VNode);
    }
  }
}

initializeApplication();

window.addEventListener('beforeunload', () => {
    logger.info('[AppEntry] beforeunload event triggered. Terminating Stockfish.');
    stockfishService.terminate();
});

window.addEventListener('resize', () => {
    if (appController) {
        appController.handleResize();
    }
});

logger.info('[AppEntry] Initial setup complete. Asynchronous initialization started.');
