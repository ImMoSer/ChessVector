// src/appView.ts
import { h } from 'snabbdom';
import type { VNode, Hooks } from 'snabbdom';
import type { AppController, AppPage } from './AppController';
import { PuzzleController } from './features/puzzle/PuzzleController'; // Обычный импорт
import { renderPuzzleUI, type PuzzlePageViewLayout } from './features/puzzle/puzzleView';
import { AnalysisTestController } from './features/analysis/AnalysisTestController'; // Обычный импорт
import { renderAnalysisTestUI } from './features/analysis/analysisTestView';
import logger from './utils/logger';

// --- Логика изменения размера центральной панели ---
let isResizingCenterPanel = false;
let initialCenterPanelMouseX: number | null = null;
let initialCenterPanelWidth: number | null = null;
let centerPanelResizableWrapperEl: HTMLElement | null = null;

const MIN_CENTER_PANEL_WIDTH_APPVIEW = 300; 
const MAX_CENTER_PANEL_WIDTH_PERCENT_APPVIEW = 0.9; // Макс. % от ширины окна для центральной панели

function onCenterPanelResizeStart(event: MouseEvent | TouchEvent, wrapperElement: HTMLElement) {
    event.preventDefault();
    event.stopPropagation();

    isResizingCenterPanel = true;
    centerPanelResizableWrapperEl = wrapperElement;
    document.body.classList.add('board-resizing'); 

    const clientX = (event as TouchEvent).touches ? (event as TouchEvent).touches[0].clientX : (event as MouseEvent).clientX;
    initialCenterPanelMouseX = clientX;
    initialCenterPanelWidth = centerPanelResizableWrapperEl.offsetWidth;

    // Привязываем обработчики к document для глобального отслеживания
    document.addEventListener('mousemove', onCenterPanelResizeMove, { passive: false });
    document.addEventListener('mouseup', onCenterPanelResizeEnd, { once: true });
    document.addEventListener('touchmove', onCenterPanelResizeMove, { passive: false });
    document.addEventListener('touchend', onCenterPanelResizeEnd, { once: true });
    logger.debug('[appView onCenterPanelResizeStart] Center panel resize started.');
}

function onCenterPanelResizeMove(event: MouseEvent | TouchEvent) {
    if (!isResizingCenterPanel || initialCenterPanelMouseX === null || initialCenterPanelWidth === null || !centerPanelResizableWrapperEl) return;

    event.preventDefault();
    const clientX = (event as TouchEvent).touches ? (event as TouchEvent).touches[0].clientX : (event as MouseEvent).clientX;
    const deltaX = clientX - initialCenterPanelMouseX;

    let newWidth = initialCenterPanelWidth + deltaX;
    newWidth = Math.max(MIN_CENTER_PANEL_WIDTH_APPVIEW, newWidth);
    
    // Ограничиваем максимальную ширину относительно окна, но также и относительно родителя, если он меньше
    const parentMaxWidth = centerPanelResizableWrapperEl.parentElement ? centerPanelResizableWrapperEl.parentElement.clientWidth * MAX_CENTER_PANEL_WIDTH_PERCENT_APPVIEW : window.innerWidth * MAX_CENTER_PANEL_WIDTH_PERCENT_APPVIEW;
    newWidth = Math.min(newWidth, parentMaxWidth);


    centerPanelResizableWrapperEl.style.width = `${newWidth}px`;
    // Высота центральной панели будет управляться через aspect-ratio доски внутри нее,
    // а высота боковых панелей будет равна высоте центральной через flexbox.

    // Уведомляем BoardView о необходимости перерисовки через кастомное событие
    // requestAnimationFrame для плавности и избежания слишком частых перерисовок
    requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('centerPanelResized'));
    });
}

function onCenterPanelResizeEnd() {
    if (!isResizingCenterPanel) return;
    isResizingCenterPanel = false;
    document.body.classList.remove('board-resizing');

    document.removeEventListener('mousemove', onCenterPanelResizeMove);
    document.removeEventListener('mouseup', onCenterPanelResizeEnd);
    document.removeEventListener('touchmove', onCenterPanelResizeMove);
    document.removeEventListener('touchend', onCenterPanelResizeEnd);

    if (centerPanelResizableWrapperEl) {
      logger.debug(`[appView onCenterPanelResizeEnd] Center panel resize ended. New width: ${centerPanelResizableWrapperEl.style.width}`);
      localStorage.setItem('centerPanelWidth', centerPanelResizableWrapperEl.style.width);
    }
    
    centerPanelResizableWrapperEl = null;
    initialCenterPanelMouseX = null;
    initialCenterPanelWidth = null;
    
    // Финальное уведомление, на всякий случай, если последний move не вызвал requestAnimationFrame
    window.dispatchEvent(new CustomEvent('centerPanelResized'));
}
// --- Конец логики изменения размера ---


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
      if (analysisLayout && typeof analysisLayout === 'object' && 
          'center' in analysisLayout && 'left' in analysisLayout && 'right' in analysisLayout) {
        pageSpecificVNodes = analysisLayout as PuzzlePageViewLayout; 
      } else if (analysisLayout) { 
        logger.warn('[appView] renderAnalysisTestUI did not return a full layout object. Using placeholders for side panels.');
        pageSpecificVNodes = {
            left: h('div.analysis-left-placeholder', 'Панель настроек анализа'), 
            center: analysisLayout as VNode, 
            right: h('div.analysis-right-placeholder', 'Результаты анализа') 
        };
      } else {
        pageSpecificVNodes.center = h('p', `Ошибка: renderAnalysisTestUI не вернул VNode для страницы ${appState.currentPage}`);
      }
    } else {
        pageSpecificVNodes.center = h('p', `Ошибка: Неверный контроллер для страницы ${appState.currentPage}`);
    }
  } else {
    pageSpecificVNodes.center = h('p', 'Загрузка контроллера страницы...');
  }
  
  const resizeHandleHook: Hooks = {
    insert: (vnode: VNode) => {
        const handleEl = vnode.elm as HTMLElement;
        const wrapperEl = handleEl.parentElement; // #center-panel-resizable-wrapper
        if (wrapperEl) {
            // Удаляем старые слушатели перед добавлением новых, на случай HMR
            handleEl.removeEventListener('mousedown', (e) => onCenterPanelResizeStart(e, wrapperEl));
            handleEl.removeEventListener('touchstart', (e) => onCenterPanelResizeStart(e, wrapperEl));

            handleEl.addEventListener('mousedown', (e) => onCenterPanelResizeStart(e, wrapperEl), { passive: false });
            handleEl.addEventListener('touchstart', (e) => onCenterPanelResizeStart(e, wrapperEl), { passive: false });
            logger.info('[appView resizeHandleHook.insert] Resize handle listeners attached to center panel handle.');
        } else {
            logger.error('[appView resizeHandleHook.insert] Parent wrapper for resize handle not found!');
        }
    },
    // destroy хук может быть полезен для очистки слушателей, если ручка удаляется
    destroy: (vnode: VNode) => {
        const handleEl = vnode.elm as HTMLElement;
        const wrapperEl = handleEl.parentElement; // Может быть null, если родитель уже удален
         if (wrapperEl) { // Проверяем, что wrapperEl существует
            handleEl.removeEventListener('mousedown', (e) => onCenterPanelResizeStart(e, wrapperEl));
            handleEl.removeEventListener('touchstart', (e) => onCenterPanelResizeStart(e, wrapperEl));
        }
        logger.info('[appView resizeHandleHook.destroy] Resize handle listeners potentially removed.');
    }
  };

  const savedCenterPanelWidth = localStorage.getItem('centerPanelWidth');
  const centerPanelInitialStyle: Record<string, string> = {};
  if (savedCenterPanelWidth && !appState.isPortraitMode) { // Применяем сохраненную ширину только для альбомного режима
    centerPanelInitialStyle.width = savedCenterPanelWidth;
  } else if (!appState.isPortraitMode) {
    centerPanelInitialStyle.width = 'var(--center-panel-width)'; // Используем дефолтную из CSS переменных
  }
  // В портретном режиме ширина будет 100% через CSS класс


  return h('div#app-layout', [
    h('header#app-header', [
      h('div.nav-header-content', [
        h('span.app-title', 'ChessApp'),
        h('button.nav-toggle-button', { 
          style: { display: appState.isPortraitMode ? 'block' : 'none' }, 
          on: { click: () => controller.toggleNav() } 
        }, appState.isNavExpanded ? '✕' : '☰'),
        h('ul.nav-links', { 
          style: { display: appState.isPortraitMode ? (appState.isNavExpanded ? 'flex' : 'none') : 'flex' }
        },
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
        // Боковые панели и их содержимое рендерятся условно
        appState.isPortraitMode ? null : h('aside#left-panel', { style: { width: 'var(--left-panel-width)' } }, [pageSpecificVNodes.left]),
        
        h('div#center-panel-resizable-wrapper', { 
            key: 'center-wrapper', // Стабильный ключ
            style: appState.isPortraitMode ? { width: '100%', minWidth:'unset' } : centerPanelInitialStyle,
        }, [
          h('section#center-panel', [pageSpecificVNodes.center]),
          // Ручка отображается только в альбомном режиме и если не было ошибки загрузки pageSpecificVNodes.center
          (appState.isPortraitMode || !pageSpecificVNodes.center || (pageSpecificVNodes.center as VNode).sel === 'p') 
            ? null 
            : h('div.resize-handle-center', { hook: resizeHandleHook, key: 'center-resize-handle' })
        ]),

        // Правая панель в портретном режиме отображается, если есть контент
        (appState.isPortraitMode && pageSpecificVNodes.right) 
            ? h('aside#right-panel.portrait-mode-layout', [pageSpecificVNodes.right]) 
            : (appState.isPortraitMode ? null : h('aside#right-panel', { style: { width: 'var(--right-panel-width)' } }, [pageSpecificVNodes.right]))
      ])
    ])
  ]);
}
