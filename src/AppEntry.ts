// src/AppEntry.ts
import { init, propsModule, eventListenersModule, styleModule, classModule, attributesModule } from 'snabbdom';
import type { VNode } from 'snabbdom';
// Import main application styles
import './assets/main.css';
import './features/common/promotion/promotion.css';
import './features/analysis/analysisPanel.css';
import './features/finishHim/finishHim.css';
import './features/playFromFen/playFromFen.css'; // Новый CSS
import './features/welcome/welcome.css';
import './features/clubPage/clubPage.css';
import './features/recordsPage/recordsPage.css';
import './features/userCabinet/userCabinet.css';

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
  attributesModule,
  propsModule,
  eventListenersModule,
  styleModule,
  classModule,
]);

const chessboardService = new ChessboardService();
const stockfishService = new StockfishService();
const webhookServiceInstance = WebhookService;

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

let appController: AppController;
let isRedrawScheduled = false;
let animationFrameId: number | null = null;

function requestGlobalRedraw() {
  if (isRedrawScheduled) {
    logger.debug("[AppEntry requestGlobalRedraw] Skipped as a redraw is already scheduled.");
    return;
  }

  if (!appController) {
    logger.warn("[AppEntry requestGlobalRedraw] Skipped as appController is not yet initialized.");
    return;
  }

  isRedrawScheduled = true;
  logger.debug("[AppEntry requestGlobalRedraw] Scheduling redraw via requestAnimationFrame.");

  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
  }

  animationFrameId = requestAnimationFrame(() => {
    try {
      const newVNode = renderAppUI(appController);
      oldVNode = patch(oldVNode, newVNode);
      logger.debug("[AppEntry requestGlobalRedraw] Main application view re-rendered and patch completed (via rAF).");
    } catch (error) {
      logger.error("[AppEntry requestGlobalRedraw] Error during patch (via rAF):", error);
    } finally {
      isRedrawScheduled = false;
      animationFrameId = null;
    }
  });
}

async function initializeApplication() {
  try {
    await initI18nService('en'); // Или другой язык по умолчанию
    logger.info('[AppEntry] i18n service initialized.');

    appController = new AppController(
      {
        chessboardService,
        stockfishService,
        webhookService: webhookServiceInstance,
        logger
      },
      requestGlobalRedraw
    );

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
