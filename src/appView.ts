// src/appView.ts
import { h } from 'snabbdom';
import type { VNode, Hooks } from 'snabbdom';
import type { AppController, AppPage } from './AppController';
// PuzzleController and AnalysisTestController are no longer imported for page rendering here
import { FinishHimController } from './features/finishHim/finishHimController';
import { renderFinishHimUI, type FinishHimPageViewLayout } from './features/finishHim/finishHimView';
import logger from './utils/logger';
import { t } from './core/i18n.service';

// --- Resize logic for center panel (remains unchanged) ---
let isResizingCenterPanel = false;
let initialCenterPanelMouseX: number | null = null;
let initialUserPreferredVh: number | null = null;
let centerPanelResizableWrapperEl: HTMLElement | null = null;
const PX_PER_VH_DRAG_SENSITIVITY = 10;

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

  // Only "FinishHim" link is shown for now
  const navLinks = [
    { page: 'finishHim' as AppPage, textKey: 'nav.finishHim' },
  ];

  // Use FinishHimPageViewLayout as the primary layout type now
  let pageSpecificVNodes: FinishHimPageViewLayout = {
    left: h('div.panel-placeholder', t('common.panel.leftNotLoaded')),
    center: h('div.panel-placeholder', t('common.panel.centerNotLoaded')),
    right: h('div.panel-placeholder', t('common.panel.rightNotLoaded'))
  };

  if (activePageController) {
    if (appState.currentPage === 'finishHim' && activePageController instanceof FinishHimController) {
      pageSpecificVNodes = renderFinishHimUI(activePageController);
    } else {
        // This case should ideally not be hit if AppController correctly loads FinishHimController for 'finishHim' page
        pageSpecificVNodes.center = h('p', t('errorPage.invalidController', { pageName: appState.currentPage }));
        logger.error(`[appView] Invalid controller instance for page ${appState.currentPage}. Controller:`, activePageController);
    }
  } else {
    pageSpecificVNodes.center = h('p', t('common.loadingController'));
    logger.debug(`[appView] No active page controller for page: ${appState.currentPage}`);
  }

  const resizeHandleHook: Hooks = {
    insert: (vnode: VNode) => {
        const handleEl = vnode.elm as HTMLElement;
        const wrapperEl = handleEl.parentElement;
        if (wrapperEl) {
            handleEl.addEventListener('mousedown', (e) => onCenterPanelResizeStart(e as MouseEvent, wrapperEl, controller), { passive: false });
            handleEl.addEventListener('touchstart', (e) => onCenterPanelResizeStart(e as TouchEvent, wrapperEl, controller), { passive: false });
            logger.info('[appView resizeHandleHook.insert] Resize handle listeners attached.');
        } else {
            logger.error('[appView resizeHandleHook.insert] Parent wrapper for resize handle not found!');
        }
    },
  };

  return h('div#app-layout', [
    h('header#app-header', { class: { 'menu-open': appState.isNavExpanded && appState.isPortraitMode } }, [
      h('div.nav-header-content', [
        h('span.app-title', t('app.title')),
        h('button.nav-toggle-button', {
          on: { click: () => controller.toggleNav() }
        }, appState.isNavExpanded ? '✕' : '☰'),
        h('ul.nav-links',
          navLinks.map(link =>
            h('li', [
              h('a', {
                class: { active: appState.currentPage === link.page },
                props: { href: `#${link.page}` }, // href can remain for potential deep linking or semantics
                on: {
                  click: (e: Event) => {
                    e.preventDefault();
                    controller.navigateTo(link.page);
                  }
                }
              }, t(link.textKey))
            ])
          )
        )
      ])
    ]),
    h('main#page-content-wrapper', [
      h(`div.three-column-layout`, {
        class: { 'portrait-mode-layout': appState.isPortraitMode }
      },[
        // Left panel: Always render if not portrait, or if portrait and content exists
        (appState.isPortraitMode && !pageSpecificVNodes.left) ? null : h('aside#left-panel', { class: { 'portrait-mode-layout': appState.isPortraitMode && !!pageSpecificVNodes.left } }, [pageSpecificVNodes.left]),

        h('div#center-panel-resizable-wrapper', {
            key: 'center-wrapper',
            class: { 'portrait-mode-layout': appState.isPortraitMode }
        }, [
          h('section#center-panel', [pageSpecificVNodes.center]),
          (appState.isPortraitMode || !pageSpecificVNodes.center || (pageSpecificVNodes.center as VNode).sel === 'div.panel-placeholder' || (pageSpecificVNodes.center as VNode).sel === 'p')
            ? null
            : h('div.resize-handle-center', { hook: resizeHandleHook, key: 'center-resize-handle' })
        ]),

        // Right panel: Always render if not portrait, or if portrait and content exists
        (appState.isPortraitMode && !pageSpecificVNodes.right) ? null : h('aside#right-panel', { class: { 'portrait-mode-layout': appState.isPortraitMode && !!pageSpecificVNodes.right } }, [pageSpecificVNodes.right])
      ])
    ])
  ]);
}
