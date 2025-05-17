// src/appView.ts
import { h } from 'snabbdom';
import type { VNode, Hooks } from 'snabbdom';
import type { AppController, AppPage } from './AppController';
import { PuzzleController } from './features/puzzle/PuzzleController';
import { renderPuzzleUI, type PuzzlePageViewLayout } from './features/puzzle/puzzleView';
import { AnalysisTestController } from './features/analysis/AnalysisTestController';
import { renderAnalysisTestUI } from './features/analysis/analysisTestView';
import logger from './utils/logger';

// --- Логика изменения размера центральной панели ---
let isResizingCenterPanel = false;
let initialCenterPanelMouseX: number | null = null;
// Вместо initialCenterPanelWidth будем хранить начальное значение userPreferredBoardSizeVh из AppController
let initialUserPreferredVh: number | null = null;
let centerPanelResizableWrapperEl: HTMLElement | null = null; // Остается для определения родителя

// Константы для чувствительности перетаскивания (пиксели смещения мыши на 1vh изменения)
// Меньшее значение = более чувствительное изменение
const PX_PER_VH_DRAG_SENSITIVITY = 10; // Например, 10px смещения мыши = 1vh изменения размера

function onCenterPanelResizeStart(event: MouseEvent | TouchEvent, wrapperElement: HTMLElement, controller: AppController) {
    event.preventDefault();
    event.stopPropagation();

    isResizingCenterPanel = true;
    centerPanelResizableWrapperEl = wrapperElement; // Это #center-panel-resizable-wrapper
    document.body.classList.add('board-resizing'); // Добавим класс для стилизации курсора

    const clientX = (event as TouchEvent).touches ? (event as TouchEvent).touches[0].clientX : (event as MouseEvent).clientX;
    initialCenterPanelMouseX = clientX;
    initialUserPreferredVh = controller.getUserPreferredBoardSizeVh(); // Получаем текущее предпочтение из контроллера

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

    // Преобразуем пиксельное смещение мыши в изменение vh
    const deltaVh = deltaX / PX_PER_VH_DRAG_SENSITIVITY;
    let newPreferredVh = initialUserPreferredVh + deltaVh;

    // AppController применит свои собственные BOARD_MIN_VH и BOARD_MAX_VH,
    // но мы можем здесь также грубо ограничить, чтобы не слать совсем дикие значения.
    // Однако, основное ограничение должно быть в AppController.
    // newPreferredVh = Math.max(10, Math.min(95, newPreferredVh)); // Грубое ограничение

    controller.setUserPreferredBoardSizeVh(newPreferredVh); // Сообщаем контроллеру новое предпочтение
    // AppController вызовет _calculateAndSetBoardSize и requestGlobalRedraw

    // Непосредственно здесь DOM не меняем, AppController обновит CSS переменную, и Snabbdom перерисует.
}

function onCenterPanelResizeEnd(controller: AppController, moveHandler: any, endHandler: any) {
    if (!isResizingCenterPanel) return;
    isResizingCenterPanel = false;
    document.body.classList.remove('board-resizing');

    document.removeEventListener('mousemove', moveHandler);
    document.removeEventListener('mouseup', endHandler);
    document.removeEventListener('touchmove', moveHandler);
    document.removeEventListener('touchend', endHandler);

    logger.debug(`[appView onCenterPanelResizeEnd] Center panel resize ended. Final preferred Vh sent to controller.`);

    // Сохранение предпочтения пользователя (если нужно) может быть сделано в AppController
    // controller.saveUserPreference(); 

    centerPanelResizableWrapperEl = null;
    initialCenterPanelMouseX = null;
    initialUserPreferredVh = null;

    // Финальный пересчет и перерисовка уже инициированы в AppController через setUserPreferredBoardSizeVh
}


export function renderAppUI(controller: AppController): VNode {
  const appState = controller.state;
  const activePageController = controller.activePageController;

  const navLinks = [
    { page: 'puzzle' as AppPage, text: 'Пазлы' },
    { page: 'analysisTest' as AppPage, text: 'Тест Анализа' },
  ];

  let pageSpecificVNodes: PuzzlePageViewLayout = {
    left: h('div.panel-placeholder', 'Левая панель не загружена'),
    center: h('div.panel-placeholder', 'Центральная панель не загружена'),
    right: h('div.panel-placeholder', 'Правая панель не загружена')
  };

  if (activePageController) {
    if (appState.currentPage === 'puzzle' && activePageController instanceof PuzzleController) {
      pageSpecificVNodes = renderPuzzleUI(activePageController);
    } else if (appState.currentPage === 'analysisTest' && activePageController instanceof AnalysisTestController) {
      const analysisLayout = renderAnalysisTestUI(activePageController);
      if (analysisLayout && typeof analysisLayout === 'object' && 'sel' in analysisLayout) {
         pageSpecificVNodes = {
            left: h('div.analysis-left-placeholder', 'Настройки Анализа'),
            center: analysisLayout as VNode,
            right: h('div.analysis-right-placeholder', 'Результаты Анализа')
        };
      } else {
        pageSpecificVNodes.center = h('p', `Ошибка: renderAnalysisTestUI не вернул VNode для страницы ${appState.currentPage}`);
        logger.error(`[appView] renderAnalysisTestUI did not return a VNode for page ${appState.currentPage}. Received:`, analysisLayout);
      }
    } else {
        pageSpecificVNodes.center = h('p', `Ошибка: Неверный контроллер для страницы ${appState.currentPage}`);
        logger.error(`[appView] Invalid controller for page ${appState.currentPage}. Controller:`, activePageController);
    }
  } else {
    pageSpecificVNodes.center = h('p', 'Загрузка контроллера страницы...');
    logger.debug(`[appView] No active page controller for page: ${appState.currentPage}`);
  }

  const resizeHandleHook: Hooks = {
    insert: (vnode: VNode) => {
        const handleEl = vnode.elm as HTMLElement;
        const wrapperEl = handleEl.parentElement; // Это #center-panel-resizable-wrapper
        if (wrapperEl) {
            // Удаляем старые слушатели, если они есть (на всякий случай, хотя insert обычно один раз)
            // handleEl.removeEventListener('mousedown', (e) => onCenterPanelResizeStart(e, wrapperEl, controller));
            // handleEl.removeEventListener('touchstart', (e) => onCenterPanelResizeStart(e, wrapperEl, controller));

            handleEl.addEventListener('mousedown', (e) => onCenterPanelResizeStart(e as MouseEvent, wrapperEl, controller), { passive: false });
            handleEl.addEventListener('touchstart', (e) => onCenterPanelResizeStart(e as TouchEvent, wrapperEl, controller), { passive: false });
            logger.info('[appView resizeHandleHook.insert] Resize handle listeners attached.');
        } else {
            logger.error('[appView resizeHandleHook.insert] Parent wrapper for resize handle not found!');
        }
    },
    // destroy хук не нужен, т.к. слушатели на document, и они удаляются в onCenterPanelResizeEnd
  };


  return h('div#app-layout', [
    h('header#app-header', { class: { 'menu-open': appState.isNavExpanded && appState.isPortraitMode } }, [
      h('div.nav-header-content', [
        h('span.app-title', 'ChessApp'),
        h('button.nav-toggle-button', {
          on: { click: () => controller.toggleNav() }
        }, appState.isNavExpanded ? '✕' : '☰'),
        h('ul.nav-links',
          navLinks.map(link =>
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
              }, link.text)
            ])
          )
        )
      ])
    ]),
    h('main#page-content-wrapper', [
      h(`div.three-column-layout`, {
        class: { 'portrait-mode-layout': appState.isPortraitMode }
      },[
        appState.isPortraitMode ? null : h('aside#left-panel', [pageSpecificVNodes.left]),

        h('div#center-panel-resizable-wrapper', {
            key: 'center-wrapper', // Важно для Snabbdom, если структура меняется
            class: { 'portrait-mode-layout': appState.isPortraitMode }
        }, [
          h('section#center-panel', [pageSpecificVNodes.center]),
          // Ручка для изменения размера, отображается только если не портретный режим
          // и если есть центральный контент (не заглушка)
          (appState.isPortraitMode || !pageSpecificVNodes.center || (pageSpecificVNodes.center as VNode).sel === 'div.panel-placeholder' || (pageSpecificVNodes.center as VNode).sel === 'p')
            ? null
            : h('div.resize-handle-center', { hook: resizeHandleHook, key: 'center-resize-handle' })
        ]),

        (appState.isPortraitMode && pageSpecificVNodes.right)
            ? h('aside#right-panel.portrait-mode-layout', [pageSpecificVNodes.right])
            : (appState.isPortraitMode ? null : h('aside#right-panel', [pageSpecificVNodes.right]))
      ])
    ])
  ]);
}
