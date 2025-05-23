// src/appView.ts
import { h } from 'snabbdom';
import type { VNode, Hooks } from 'snabbdom';
import type { AppController, AppPage } from './AppController';
import { FinishHimController } from './features/finishHim/finishHimController';
import { renderFinishHimUI, type FinishHimPageViewLayout } from './features/finishHim/finishHimView';
import { WelcomeController } from './features/welcome/welcomeController';
import { renderWelcomePage } from './features/welcome/welcomeView';
import { ClubPageController } from './features/clubPage/ClubPageController';
import { renderClubPage } from './features/clubPage/clubPageView';
import { RecordsPageController } from './features/recordsPage/RecordsPageController';
import { renderRecordsPage } from './features/recordsPage/RecordsPageView';
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

// --- Modal Rendering ---
function renderModal(controller: AppController): VNode | null {
  const appState = controller.state;
  if (!appState.isModalVisible || !appState.modalMessage) {
    return null;
  }

  return h('div.modal-overlay', {
    on: { click: () => controller.hideModal() } // Закрытие по клику на оверлей
  }, [
    h('div.modal-content', {
      on: { click: (e: Event) => e.stopPropagation() } // Предотвращение закрытия при клике на контент модалки
    }, [
      h('p.modal-message', appState.modalMessage),
      h('button.button.modal-ok-button', {
        on: { click: () => controller.hideModal() }
      }, t('common.ok', { defaultValue: 'OK' }))
    ])
  ]);
}


export function renderAppUI(controller: AppController): VNode {
  const appState = controller.state;
  const activePageController = controller.activePageController;
  const isAuthenticated = controller.services.authService.getIsAuthenticated();

  let navLinksConfig: Array<{
    page?: AppPage,
    textKey: string,
    requiresAuth?: boolean,
    hideWhenAuth?: boolean,
    clubIdToMatch?: string | null,
  }> = [
    { page: 'finishHim', textKey: 'nav.finishHim', requiresAuth: true },
    { page: 'recordsPage', textKey: 'nav.leaderboards' },
  ];

  const visibleNavLinks = navLinksConfig.filter(link => {
    if (link.requiresAuth && !isAuthenticated) return false;
    if (link.hideWhenAuth && isAuthenticated) return false;
    return true;
  });

  let pageSpecificContentVNode: VNode;

  if (appState.isLoadingAuth && appState.currentPage !== 'welcome') {
    pageSpecificContentVNode = h('div.global-loader-container', [
        h('h2', t('auth.processingLogin', {defaultValue: "Processing Login..."})),
        h('div.loading-spinner')
    ]);
  } else if (activePageController) {
    switch (appState.currentPage) {
      case 'welcome':
        if (activePageController instanceof WelcomeController) {
          pageSpecificContentVNode = renderWelcomePage(activePageController);
        } else {
          pageSpecificContentVNode = h('p', t('errorPage.invalidController', { pageName: appState.currentPage }));
        }
        break;
      case 'finishHim':
        if (activePageController instanceof FinishHimController) {
          pageSpecificContentVNode = h('div.finish-him-placeholder');
        } else {
          pageSpecificContentVNode = h('p', t('errorPage.invalidController', { pageName: appState.currentPage }));
        }
        break;
      case 'clubPage':
        if (activePageController instanceof ClubPageController) {
          pageSpecificContentVNode = renderClubPage(activePageController);
        } else {
          pageSpecificContentVNode = h('p', t('errorPage.invalidController', { pageName: appState.currentPage }));
        }
        break;
      case 'recordsPage':
        if (activePageController instanceof RecordsPageController) {
          pageSpecificContentVNode = renderRecordsPage(activePageController);
        } else {
          pageSpecificContentVNode = h('p', t('errorPage.invalidController', { pageName: appState.currentPage }));
        }
        break;
      default:
        const exhaustiveCheck: never = appState.currentPage;
        pageSpecificContentVNode = h('p', t('errorPage.unknownPage', { pageName: exhaustiveCheck }));
        logger.error(`[appView] Reached default case in page switch with page: ${exhaustiveCheck}`);
    }
  } else {
    pageSpecificContentVNode = h('p', t('common.loadingController'));
    logger.debug(`[appView] No active page controller for page: ${appState.currentPage}`);
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

  let mainContentStructure: VNode;

  if (appState.currentPage === 'finishHim' && activePageController instanceof FinishHimController) {
    const fhLayout: FinishHimPageViewLayout = renderFinishHimUI(activePageController);
    mainContentStructure = h('div.three-column-layout', {
        class: {
            'portrait-mode-layout': appState.isPortraitMode,
            'no-left-panel': !fhLayout.left && !appState.isPortraitMode,
            'no-right-panel': !fhLayout.right && !appState.isPortraitMode,
        }
      },[
        fhLayout.left ? h('aside#left-panel', { class: { 'portrait-mode-layout': appState.isPortraitMode } }, [fhLayout.left]) : null,
        h('div#center-panel-resizable-wrapper', {
            key: 'center-wrapper-fh',
            class: { 'portrait-mode-layout': appState.isPortraitMode }
        }, [
          h('section#center-panel', [fhLayout.center]),
          appState.isPortraitMode ? null : h('div.resize-handle-center', { hook: resizeHandleHook, key: 'center-resize-handle-fh' })
        ]),
        fhLayout.right ? h('aside#right-panel', { class: { 'portrait-mode-layout': appState.isPortraitMode } }, [fhLayout.right]) : null,
      ].filter(Boolean) as VNode[]);
  } else {
    mainContentStructure = pageSpecificContentVNode;
  }

  return h('div#app-layout', [
    h('header#app-header', { class: { 'menu-open': appState.isNavExpanded && appState.isPortraitMode } }, [
      h('div.nav-header-content', [
        h('img.app-logo', {
          props: {
            src: '/svg/1920_Banner.svg',
            alt: t('app.title')
          },
          on: {
            click: () => controller.navigateTo(isAuthenticated ? 'finishHim' : 'welcome', true, null)
          }
        }),
        (visibleNavLinks.length > 0 || isAuthenticated) ?
          h('button.nav-toggle-button', {
            on: { click: () => controller.toggleNav() }
          }, appState.isNavExpanded ? '✕' : '☰') : null,
        h('ul.nav-links',
          [
            ...visibleNavLinks.map(link =>
              h('li', [
                h('a', {
                  class: {
                    active: link.page ? (appState.currentPage === link.page && (link.page !== 'clubPage' || appState.currentClubId === null)) : false,
                  },
                  props: { href: link.page ? (link.page === 'recordsPage' ? '#/records' : `#${link.page}`) : '#' },
                  on: {
                    click: (e: Event) => {
                      e.preventDefault();
                      if (link.page) {
                        controller.navigateTo(link.page, true, null);
                        if (appState.isPortraitMode && appState.isNavExpanded) {
                            controller.toggleNav();
                        }
                      }
                    }
                  }
                }, t(link.textKey)
                ),
              ])
            ),
            isAuthenticated ? h('li', [
              h('a', {
                class: { 'logout-link': true },
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
        mainContentStructure
    ]),
    renderModal(controller) // Рендерим модальное окно здесь
  ]);
}
