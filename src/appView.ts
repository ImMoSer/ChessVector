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
let initialCenterPanelWidth: number | null = null;
let centerPanelResizableWrapperEl: HTMLElement | null = null;

const MIN_CENTER_PANEL_WIDTH_APPVIEW = 300;
const MAX_CENTER_PANEL_WIDTH_PERCENT_APPVIEW = 0.9; // Макс. % от ширины окна для центральной панели

function getCssVariableValue(variableName: string, element: HTMLElement = document.documentElement): number {
    const value = getComputedStyle(element).getPropertyValue(variableName).trim();
    if (value.endsWith('px')) {
        return parseFloat(value);
    }
    // Если значение не в px, или не удалось распарсить, возвращаем 0 или другое значение по умолчанию
    // Для простоты, предполагаем, что наши переменные будут в px
    logger.warn(`[appView getCssVariableValue] Could not parse CSS variable ${variableName} as px. Value: ${value}`);
    return 0;
}


function onCenterPanelResizeStart(event: MouseEvent | TouchEvent, wrapperElement: HTMLElement) {
    event.preventDefault();
    event.stopPropagation();

    isResizingCenterPanel = true;
    centerPanelResizableWrapperEl = wrapperElement;
    document.body.classList.add('board-resizing');

    const clientX = (event as TouchEvent).touches ? (event as TouchEvent).touches[0].clientX : (event as MouseEvent).clientX;
    initialCenterPanelMouseX = clientX;
    initialCenterPanelWidth = centerPanelResizableWrapperEl.offsetWidth;

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

    // Ограничиваем максимальную ширину относительно родителя
    const parentElement = centerPanelResizableWrapperEl.parentElement;
    let parentMaxWidth = window.innerWidth * MAX_CENTER_PANEL_WIDTH_PERCENT_APPVIEW; // Fallback
    if (parentElement) {
        // Учитываем padding родителя, если он есть, чтобы не выйти за его контентную область
        const parentStyle = getComputedStyle(parentElement);
        const parentPaddingLeft = parseFloat(parentStyle.paddingLeft) || 0;
        const parentPaddingRight = parseFloat(parentStyle.paddingRight) || 0;
        parentMaxWidth = (parentElement.clientWidth - parentPaddingLeft - parentPaddingRight) * MAX_CENTER_PANEL_WIDTH_PERCENT_APPVIEW;
    }
    newWidth = Math.min(newWidth, parentMaxWidth);

    // --- НОВОЕ ОГРАНИЧЕНИЕ: по максимальной высоте доски ---
    // Получаем значения CSS переменных для расчета максимальной высоты доски
    // Эти переменные должны быть определены в :root или body в вашем style.css
    const headerHeight = getCssVariableValue('--header-height');
    const pageVerticalPadding = getCssVariableValue('--page-vertical-padding');
    
    // Максимальный размер доски (и, следовательно, #center-panel-resizable-wrapper)
    // ограничен высотой окна просмотра.
    // #board-wrapper имеет max-width и max-height = calc(100vh - var(--header-height) - (2 * var(--page-vertical-padding)))
    const maxBoardDimensionBasedOnViewportHeight = window.innerHeight - headerHeight - (2 * pageVerticalPadding);
    
    newWidth = Math.min(newWidth, maxBoardDimensionBasedOnViewportHeight);
    // --- КОНЕЦ НОВОГО ОГРАНИЧЕНИЯ ---


    centerPanelResizableWrapperEl.style.width = `${newWidth}px`;

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

    window.dispatchEvent(new CustomEvent('centerPanelResized'));
}


export function renderAppUI(controller: AppController): VNode {
  const appState = controller.state;
  const activePageController = controller.activePageController;

  const navLinks = [
    { page: 'puzzle' as AppPage, text: 'Puzzles' }, // Translated
    { page: 'analysisTest' as AppPage, text: 'Analysis Test' }, // Translated
  ];

  let pageSpecificVNodes: PuzzlePageViewLayout = {
    left: h('div.panel-placeholder', 'Left panel not loaded'),
    center: h('div.panel-placeholder', 'Center panel not loaded'),
    right: h('div.panel-placeholder', 'Right panel not loaded')
  };

  if (activePageController) {
    if (appState.currentPage === 'puzzle' && activePageController instanceof PuzzleController) {
      pageSpecificVNodes = renderPuzzleUI(activePageController);
    } else if (appState.currentPage === 'analysisTest' && activePageController instanceof AnalysisTestController) {
      const analysisLayout = renderAnalysisTestUI(activePageController);
      // Ensure analysisLayout is a VNode before assigning.
      // If it's a full layout, it will be handled inside renderAnalysisTestUI or by its return type.
      // This example assumes renderAnalysisTestUI returns a VNode for the center panel.
      if (analysisLayout && typeof analysisLayout === 'object' && 'sel' in analysisLayout) {
         pageSpecificVNodes = {
            left: h('div.analysis-left-placeholder', 'Analysis Settings'),
            center: analysisLayout as VNode,
            right: h('div.analysis-right-placeholder', 'Analysis Results')
        };
      } else {
        pageSpecificVNodes.center = h('p', `Error: renderAnalysisTestUI did not return a VNode for page ${appState.currentPage}`);
      }
    } else {
        pageSpecificVNodes.center = h('p', `Error: Invalid controller for page ${appState.currentPage}`);
    }
  } else {
    pageSpecificVNodes.center = h('p', 'Loading page controller...');
  }

  const resizeHandleHook: Hooks = {
    insert: (vnode: VNode) => {
        const handleEl = vnode.elm as HTMLElement;
        const wrapperEl = handleEl.parentElement;
        if (wrapperEl) {
            handleEl.removeEventListener('mousedown', (e) => onCenterPanelResizeStart(e, wrapperEl));
            handleEl.removeEventListener('touchstart', (e) => onCenterPanelResizeStart(e, wrapperEl));

            handleEl.addEventListener('mousedown', (e) => onCenterPanelResizeStart(e, wrapperEl), { passive: false });
            handleEl.addEventListener('touchstart', (e) => onCenterPanelResizeStart(e, wrapperEl), { passive: false });
            logger.info('[appView resizeHandleHook.insert] Resize handle listeners attached to center panel handle.');
        } else {
            logger.error('[appView resizeHandleHook.insert] Parent wrapper for resize handle not found!');
        }
    },
    destroy: (vnode: VNode) => {
        const handleEl = vnode.elm as HTMLElement;
        const wrapperEl = handleEl.parentElement;
         if (wrapperEl) {
            handleEl.removeEventListener('mousedown', (e) => onCenterPanelResizeStart(e, wrapperEl));
            handleEl.removeEventListener('touchstart', (e) => onCenterPanelResizeStart(e, wrapperEl));
        }
        logger.info('[appView resizeHandleHook.destroy] Resize handle listeners potentially removed.');
    }
  };

  const savedCenterPanelWidth = localStorage.getItem('centerPanelWidth');
  const centerPanelInitialStyle: Record<string, string> = {};
  if (savedCenterPanelWidth && !appState.isPortraitMode) {
    centerPanelInitialStyle.width = savedCenterPanelWidth;
  } else if (!appState.isPortraitMode) {
    // Fallback to CSS variable if nothing saved or in portrait mode initially.
    // The actual width for portrait mode will be controlled by CSS class.
    // centerPanelInitialStyle.width = 'var(--initial-center-panel-width)'; // Removed, let CSS handle default
  }


  return h('div#app-layout', [
    h('header#app-header', { class: { 'menu-open': appState.isNavExpanded && appState.isPortraitMode } }, [ // Added menu-open class
      h('div.nav-header-content', [
        h('span.app-title', 'ChessApp'),
        h('button.nav-toggle-button', {
          // style: { display: appState.isPortraitMode ? 'block' : 'none' }, // Controlled by CSS media query
          on: { click: () => controller.toggleNav() }
        }, appState.isNavExpanded ? '✕' : '☰'),
        h('ul.nav-links', {
          // style: { display: appState.isPortraitMode ? (appState.isNavExpanded ? 'flex' : 'none') : 'flex' } // Controlled by CSS
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
        appState.isPortraitMode ? null : h('aside#left-panel', { /* style: { width: 'var(--left-panel-width)' } -- width from CSS */ }, [pageSpecificVNodes.left]),

        h('div#center-panel-resizable-wrapper', {
            key: 'center-wrapper',
            style: centerPanelInitialStyle, // Apply initial width only if not in portrait mode and value exists
            class: { 'portrait-mode-layout': appState.isPortraitMode } // Add class for portrait specific styles
        }, [
          h('section#center-panel', [pageSpecificVNodes.center]),
          (appState.isPortraitMode || !pageSpecificVNodes.center || (pageSpecificVNodes.center as VNode).sel === 'p')
            ? null
            : h('div.resize-handle-center', { hook: resizeHandleHook, key: 'center-resize-handle' })
        ]),

        (appState.isPortraitMode && pageSpecificVNodes.right)
            ? h('aside#right-panel.portrait-mode-layout', [pageSpecificVNodes.right])
            : (appState.isPortraitMode ? null : h('aside#right-panel', { /* style: { width: 'var(--right-panel-width)' } -- width from CSS */ }, [pageSpecificVNodes.right]))
      ])
    ])
  ]);
}
