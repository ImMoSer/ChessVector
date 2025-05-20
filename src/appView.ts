// src/appView.ts
import { h } from 'snabbdom';
import type { VNode, Hooks } from 'snabbdom';
import type { AppController, AppPage } from './AppController';
import { FinishHimController } from './features/finishHim/finishHimController';
import { renderFinishHimUI, type FinishHimPageViewLayout } from './features/finishHim/finishHimView';
import { WelcomeController } from './features/welcome/welcomeController';
import { renderWelcomePage } from './features/welcome/welcomeView';
// LichessCallbackController and its view are no longer imported
import logger from './utils/logger';
import { t } from './core/i18n.service';

// --- Resize logic for center panel (remains unchanged) ---
let isResizingCenterPanel = false;
let initialCenterPanelMouseX: number | null = null;
let initialUserPreferredVh: number | null = null;
let centerPanelResizableWrapperEl: HTMLElement | null = null;
const PX_PER_VH_DRAG_SENSITIVITY = 10; // Pixels of drag to change VH by 1

function onCenterPanelResizeStart(event: MouseEvent | TouchEvent, wrapperElement: HTMLElement, controller: AppController) {
    event.preventDefault();
    event.stopPropagation();
    isResizingCenterPanel = true;
    centerPanelResizableWrapperEl = wrapperElement;
    document.body.classList.add('board-resizing');
    const clientX = (event as TouchEvent).touches ? (event as TouchEvent).touches[0].clientX : (event as MouseEvent).clientX;
    initialCenterPanelMouseX = clientX;
    initialUserPreferredVh = controller.getUserPreferredBoardSizeVh();
    const moveHandler = (e: MouseEvent | TouchEvent) => onCenterPanelResizeMove(e, controller);
    const endHandler = () => onCenterPanelResizeEnd(controller, moveHandler, endHandler);
    document.addEventListener('mousemove', moveHandler, { passive: false });
    document.addEventListener('mouseup', endHandler, { once: true });
    document.addEventListener('touchmove', moveHandler, { passive: false });
    document.addEventListener('touchend', endHandler, { once: true });
    logger.debug('[appView onCenterPanelResizeStart] Center panel resize started.');
}

function onCenterPanelResizeMove(event: MouseEvent | TouchEvent, controller: AppController) {
    if (!isResizingCenterPanel || initialCenterPanelMouseX === null || initialUserPreferredVh === null || !centerPanelResizableWrapperEl) return;
    event.preventDefault();
    const clientX = (event as TouchEvent).touches ? (event as TouchEvent).touches[0].clientX : (event as MouseEvent).clientX;
    const deltaX = clientX - initialCenterPanelMouseX;
    const deltaVh = deltaX / PX_PER_VH_DRAG_SENSITIVITY;
    controller.setUserPreferredBoardSizeVh(initialUserPreferredVh + deltaVh);
}

function onCenterPanelResizeEnd(_controller: AppController, moveHandler: any, endHandler: any) {
    if (!isResizingCenterPanel) return;
    isResizingCenterPanel = false;
    document.body.classList.remove('board-resizing');
    document.removeEventListener('mousemove', moveHandler);
    document.removeEventListener('mouseup', endHandler);
    document.removeEventListener('touchmove', moveHandler);
    document.removeEventListener('touchend', endHandler);
    logger.debug(`[appView onCenterPanelResizeEnd] Center panel resize ended.`);
    centerPanelResizableWrapperEl = null;
    initialCenterPanelMouseX = null;
    initialUserPreferredVh = null;
}
// --- End of resize logic ---

export function renderAppUI(controller: AppController): VNode {
  const appState = controller.state;
  const activePageController = controller.activePageController;
  const isAuthenticated = controller.services.authService.getIsAuthenticated();

  // Nav links config - 'lichessCallback' and 'challenge' removed for now
  let navLinksConfig: Array<{ page: AppPage, textKey: string, requiresAuth?: boolean, hideWhenAuth?: boolean }> = [
    { page: 'finishHim', textKey: 'nav.finishHim', requiresAuth: true },
  ];

  const visibleNavLinks = navLinksConfig.filter(link => {
    if (link.requiresAuth && !isAuthenticated) return false;
    if (link.hideWhenAuth && isAuthenticated) return false;
    return true;
  });

  let pageContentVNode: VNode | FinishHimPageViewLayout;

  // Global loading indicator for authentication processing
  if (appState.isLoadingAuth && appState.currentPage !== 'welcome') { 
    pageContentVNode = h('div.global-loader-container', [ 
        h('h2', t('auth.processingLogin', {defaultValue: "Processing Login..."})),
        h('div.loading-spinner') 
    ]);
  } else if (activePageController) {
    switch (appState.currentPage) {
      case 'welcome':
        if (activePageController instanceof WelcomeController) {
          pageContentVNode = renderWelcomePage(activePageController);
        } else {
          pageContentVNode = h('p', t('errorPage.invalidController', { pageName: appState.currentPage }));
        }
        break;
      case 'finishHim':
        if (activePageController instanceof FinishHimController) {
          pageContentVNode = renderFinishHimUI(activePageController);
        } else {
          pageContentVNode = h('p', t('errorPage.invalidController', { pageName: appState.currentPage }));
        }
        break;
      // 'challenge' case removed
      default:
        // This should not be reached if AppPage in AppController is 'welcome' | 'finishHim'
        const exhaustiveCheck: never = appState.currentPage; 
        pageContentVNode = h('p', t('errorPage.unknownPage', { pageName: exhaustiveCheck }));
        logger.error(`[appView] Reached default case in page switch with page: ${exhaustiveCheck}`);
    }
  } else {
    pageContentVNode = h('p', t('common.loadingController'));
    logger.debug(`[appView] No active page controller for page: ${appState.currentPage}`);
  }

  let leftPanelContent: VNode | null = null;
  let centerPanelContent: VNode;
  let rightPanelContent: VNode | null = null;

  if (typeof pageContentVNode === 'object' && 'center' in pageContentVNode && 'left' in pageContentVNode && 'right' in pageContentVNode) {
    const layout = pageContentVNode as FinishHimPageViewLayout;
    leftPanelContent = layout.left;
    centerPanelContent = layout.center;
    rightPanelContent = layout.right;
  } else {
    centerPanelContent = pageContentVNode as VNode;
  }


  const resizeHandleHook: Hooks = {
    insert: (vnode: VNode) => {
        const handleEl = vnode.elm as HTMLElement;
        const wrapperEl = handleEl.parentElement;
        if (wrapperEl) {
            handleEl.addEventListener('mousedown', (e) => onCenterPanelResizeStart(e as MouseEvent, wrapperEl, controller), { passive: false });
            handleEl.addEventListener('touchstart', (e) => onCenterPanelResizeStart(e as TouchEvent, wrapperEl, controller), { passive: false });
        } else {
            logger.error('[appView resizeHandleHook.insert] Parent wrapper for resize handle not found!');
        }
    },
  };

  // Determine if panels should be shown based on current page
  // Panels are shown for 'finishHim'. 'challenge' logic removed.
  const showPanels = appState.currentPage === 'finishHim';

  return h('div#app-layout', [
    h('header#app-header', { class: { 'menu-open': appState.isNavExpanded && appState.isPortraitMode } }, [
      h('div.nav-header-content', [
        h('span.app-title', t('app.title')),
        (visibleNavLinks.length > 0 || isAuthenticated) ?
          h('button.nav-toggle-button', {
            on: { click: () => controller.toggleNav() }
          }, appState.isNavExpanded ? '✕' : '☰') : null,
        h('ul.nav-links',
          [
            ...visibleNavLinks.map(link =>
              h('li', [
                h('a', {
                  class: { active: appState.currentPage === link.page },
                  props: { href: `#${link.page}` },
                  on: {
                    click: (e: Event) => {
                      e.preventDefault();
                      controller.navigateTo(link.page);
                    }
                  }
                }, t(link.textKey))
              ])
            ),
            isAuthenticated ? h('li', [
              h('a', {
                props: { href: '#' }, 
                on: {
                  click: async (e: Event) => {
                    e.preventDefault();
                    logger.info('[appView] Logout button clicked.');
                    await controller.services.authService.logout();
                    if (appState.isNavExpanded) controller.toggleNav(); 
                  }
                }
              }, t('nav.logout'))
            ]) : null
          ].filter(Boolean) as VNode[] 
        )
      ])
    ]),
    h('main#page-content-wrapper', [
      h(`div.three-column-layout`, {
        class: {
            'portrait-mode-layout': appState.isPortraitMode,
            'no-left-panel': !leftPanelContent && !appState.isPortraitMode && showPanels,
            'no-right-panel': !rightPanelContent && !appState.isPortraitMode && showPanels,
            'full-center': !showPanels // For Welcome or if panels are explicitly hidden
        }
      },[
        (appState.isPortraitMode && !leftPanelContent && showPanels) ? null : h('aside#left-panel', {
            class: {
                'portrait-mode-layout': appState.isPortraitMode && !!leftPanelContent && showPanels,
                'hidden-in-landscape': !leftPanelContent && !appState.isPortraitMode && !showPanels
            }
        }, [(showPanels && leftPanelContent) ? leftPanelContent : '']), 

        h('div#center-panel-resizable-wrapper', {
            key: 'center-wrapper', 
            class: {
                'portrait-mode-layout': appState.isPortraitMode,
                'center-full-width-page': !showPanels // Welcome page takes full width
            }
        }, [
          h('section#center-panel', [centerPanelContent]),
          (appState.isPortraitMode || !showPanels) // Hide resize handle in portrait or for non-panel pages
            ? null
            : h('div.resize-handle-center', { hook: resizeHandleHook, key: 'center-resize-handle' })
        ]),

        (appState.isPortraitMode && !rightPanelContent && showPanels) ? null : h('aside#right-panel', {
            class: {
                'portrait-mode-layout': appState.isPortraitMode && !!rightPanelContent && showPanels,
                'hidden-in-landscape': !rightPanelContent && !appState.isPortraitMode && !showPanels
            }
        }, [(showPanels && rightPanelContent) ? rightPanelContent : '']) 
      ])
    ])
  ]);
}
