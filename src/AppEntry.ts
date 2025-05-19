// src/AppEntry.ts
import { init, propsModule, eventListenersModule, styleModule, classModule } from 'snabbdom';
import type { VNode } from 'snabbdom';
import './assets/style.css'; // Main styles
import './features/common/promotion/promotion.css'; // Promotion specific styles

// Import core services
import { ChessboardService } from './core/chessboard.service';
import { StockfishService } from './core/stockfish.service';
import { WebhookService } from './core/webhook.service';
import { initI18nService } from './core/i18n.service'; // Import i18n service
import logger from './utils/logger';

// Import main application controller and view
import { AppController } from './AppController';
import { renderAppUI } from './appView';

// Chessground styles
import './vendor/chessground/chessground.base.css';
import './vendor/chessground/chessground.brown.css';
import './vendor/chessground/chessground.cburnett.css';


logger.info('[AppEntry] Application starting...');

// 1. Initialize Snabbdom patch function
const patch = init([
  propsModule,
  eventListenersModule,
  styleModule,
  classModule,
]);

// 2. Create instances of core services
const chessboardService = new ChessboardService();
const stockfishService = new StockfishService();
const webhookService = new WebhookService();

// 3. Get the root element for mounting the application
let oldVNode: VNode | Element = document.getElementById('app')!;
if (!oldVNode) {
  const errorMsg = "[AppEntry] Root element #app not found in index.html. Application cannot start.";
  logger.error(errorMsg);
  // Display error to user if possible, or throw to stop execution
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

// 4. Flag to prevent nested patch calls
let isCurrentlyPatching = false;

// 5. Function to request a global UI redraw
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
    // Handle patch error, maybe try to recover or display a message
  } finally {
    isCurrentlyPatching = false;
  }
}

// 6. Declare appController - will be initialized after i18n
let appController: AppController;

// 7. Asynchronous initialization sequence
async function initializeApplication() {
  try {
    // Initialize i18n service first
    await initI18nService('en'); // Initialize with English as default
    logger.info('[AppEntry] i18n service initialized.');

    // Create instance of the main application controller
    appController = new AppController(
      {
        chessboardService,
        stockfishService,
        webhookService,
        logger
      },
      requestGlobalRedraw
    );

    // Initialize the AppController (which loads page controllers, etc.)
    appController.initializeApp(); // This will trigger the first render via its own logic or requestGlobalRedraw
    logger.info('[AppEntry] AppController initialized and first render sequence initiated.');

  } catch (error) {
    logger.error('[AppEntry] Critical error during application initialization:', error);
    // Display a more user-friendly error message on the page
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

// Start the asynchronous initialization
initializeApplication();

// 8. Event listener for proper Stockfish termination on tab close
window.addEventListener('beforeunload', () => {
    logger.info('[AppEntry] beforeunload event triggered. Terminating Stockfish.');
    stockfishService.terminate();
});

// 9. Track window resize for adaptive navigation and layout adjustments
window.addEventListener('resize', () => {
    if (appController) { // Ensure appController is initialized
        appController.handleResize();
    }
});

logger.info('[AppEntry] Initial setup complete. Asynchronous initialization started.');
