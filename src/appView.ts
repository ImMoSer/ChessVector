// src/appView.ts
import { h } from 'snabbdom';
import type { VNode, Hooks } from 'snabbdom';
import type { AppController, AppPage } from './AppController';
import { FinishHimController } from './features/finishHim/finishHimController';
import { renderFinishHimUI, type FinishHimPageViewLayout } from './features/finishHim/finishHimView';
import { WelcomeController } from './features/welcome/welcomeController';
import { renderWelcomePage } from './features/welcome/welcomeView';
import { LichessCallbackController } from './features/auth/lichessCallbackController';
import { renderLichessCallbackPage } from './features/auth/lichessCallbackView';
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

  let navLinksConfig: Array<{ page: AppPage, textKey: string, requiresAuth?: boolean, hideWhenAuth?: boolean }> = [
    // { page: 'welcome', textKey: 'nav.welcome', hideWhenAuth: true }, // Скрываем welcome если залогинен
    { page: 'finishHim', textKey: 'nav.finishHim', requiresAuth: true },
    // Другие страницы можно добавить сюда
  ];

  // Фильтруем навигационные ссылки
  const visibleNavLinks = navLinksConfig.filter(link => {
    if (link.requiresAuth && !isAuthenticated) return false;
    if (link.hideWhenAuth && isAuthenticated) return false;
    return true;
  });

  // Определяем, какой контент рендерить
  let pageContentVNode: VNode | FinishHimPageViewLayout;

  if (activePageController) {
    switch (appState.currentPage) {
      case 'welcome':
        if (activePageController instanceof WelcomeController) {
          pageContentVNode = renderWelcomePage(activePageController);
        } else {
          pageContentVNode = h('p', t('errorPage.invalidController', { pageName: appState.currentPage }));
        }
        break;
      case 'lichessCallback':
        if (activePageController instanceof LichessCallbackController) {
          pageContentVNode = renderLichessCallbackPage(activePageController);
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
      default:
        pageContentVNode = h('p', t('errorPage.unknownPage', { pageName: appState.currentPage }));
    }
  } else {
    pageContentVNode = h('p', t('common.loadingController'));
    logger.debug(`[appView] No active page controller for page: ${appState.currentPage}`);
  }

  // Обработка структуры FinishHimPageViewLayout
  let leftPanelContent: VNode | null = null;
  let centerPanelContent: VNode;
  let rightPanelContent: VNode | null = null;

  if (typeof pageContentVNode === 'object' && 'center' in pageContentVNode && 'left' in pageContentVNode && 'right' in pageContentVNode) {
    // Это FinishHimPageViewLayout
    const layout = pageContentVNode as FinishHimPageViewLayout;
    leftPanelContent = layout.left;
    centerPanelContent = layout.center;
    rightPanelContent = layout.right;
  } else {
    // Это одиночный VNode (для Welcome, LichessCallback или ошибок)
    // Помещаем его в центральную панель, боковые панели будут пустыми или скрыты CSS для этих страниц
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

  return h('div#app-layout', [
    h('header#app-header', { class: { 'menu-open': appState.isNavExpanded && appState.isPortraitMode } }, [
      h('div.nav-header-content', [
        h('span.app-title', t('app.title')),
        // Кнопка "гамбургер"
        (visibleNavLinks.length > 0 || isAuthenticated) ? // Показываем гамбургер если есть ссылки или пользователь залогинен (для кнопки logout)
          h('button.nav-toggle-button', {
            on: { click: () => controller.toggleNav() }
          }, appState.isNavExpanded ? '✕' : '☰') : null,
        // Навигационные ссылки
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
            // Кнопка Logout, если пользователь аутентифицирован
            isAuthenticated ? h('li', [
              h('a', {
                props: { href: '#' }, // Или какой-то специальный href для logout
                on: {
                  click: async (e: Event) => {
                    e.preventDefault();
                    logger.info('[appView] Logout button clicked.');
                    await controller.services.authService.logout();
                    // AppController подпишется на изменение authState и сделает редирект на 'welcome'
                    if (appState.isNavExpanded) controller.toggleNav(); // Закрыть меню после клика
                  }
                }
              }, t('nav.logout'))
            ]) : null
          ].filter(Boolean) as VNode[] // filter(Boolean) для удаления null элементов, если они есть
        )
      ])
    ]),
    h('main#page-content-wrapper', [
      h(`div.three-column-layout`, {
        class: {
            'portrait-mode-layout': appState.isPortraitMode,
            'no-left-panel': !leftPanelContent && !appState.isPortraitMode, // Классы для скрытия панелей, если нет контента
            'no-right-panel': !rightPanelContent && !appState.isPortraitMode,
            'full-center': (!leftPanelContent && !rightPanelContent && !appState.isPortraitMode) || // Для Welcome/Callback в ландшафте
                           (appState.currentPage === 'welcome' || appState.currentPage === 'lichessCallback') // Явно для welcome/callback
        }
      },[
        // Левая панель
        (appState.isPortraitMode && !leftPanelContent) ? null : h('aside#left-panel', {
            class: {
                'portrait-mode-layout': appState.isPortraitMode && !!leftPanelContent,
                'hidden-in-landscape': !leftPanelContent && !appState.isPortraitMode && (appState.currentPage === 'welcome' || appState.currentPage === 'lichessCallback')
            }
        }, [leftPanelContent || '']), // Добавляем '' чтобы избежать ошибки если leftPanelContent null

        // Центральная панель
        h('div#center-panel-resizable-wrapper', {
            key: 'center-wrapper', // Важно для корректной работы хуков при смене страниц
            class: {
                'portrait-mode-layout': appState.isPortraitMode,
                 // Класс для растягивания на всю ширину, если это welcome/callback
                'center-full-width-page': appState.currentPage === 'welcome' || appState.currentPage === 'lichessCallback'
            }
        }, [
          h('section#center-panel', [centerPanelContent]),
          // Хэндл ресайза показываем только если это не welcome/callback и не портретный режим
          (appState.isPortraitMode || appState.currentPage === 'welcome' || appState.currentPage === 'lichessCallback')
            ? null
            : h('div.resize-handle-center', { hook: resizeHandleHook, key: 'center-resize-handle' })
        ]),

        // Правая панель
        (appState.isPortraitMode && !rightPanelContent) ? null : h('aside#right-panel', {
            class: {
                'portrait-mode-layout': appState.isPortraitMode && !!rightPanelContent,
                'hidden-in-landscape': !rightPanelContent && !appState.isPortraitMode && (appState.currentPage === 'welcome' || appState.currentPage === 'lichessCallback')
            }
        }, [rightPanelContent || '']) // Добавляем ''
      ])
    ])
  ]);
}
