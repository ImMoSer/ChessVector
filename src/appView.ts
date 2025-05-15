// src/appView.ts
import { h } from 'snabbdom';
import type { VNode } from 'snabbdom';
import type { AppController } from './AppController';

// Импорты функций рендеринга для каждой страницы/режима
import { PuzzleController } from './features/puzzle/PuzzleController';
import { renderPuzzleUI } from './features/puzzle/puzzleView';
// ИСПРАВЛЕНИЕ: Раскомментируем и проверяем путь
import { AnalysisTestController } from './features/analysis/AnalysisTestController'; // Убедитесь, что путь верный (был analysis_test)
import { renderAnalysisTestUI } from './features/analysis/analysisTestView';   // ИСПРАВЛЕНИЕ: Путь изменен на /analysis/

export function renderAppUI(controller: AppController): VNode {
  const state = controller.state;
  const activeController = controller.activePageController;

  // ИСПРАВЛЕНИЕ: Раскомментируем ссылку для Теста Анализа
  const navLinks = [
    { page: 'puzzle', text: 'Пазлы' }, // Puzzles
    { page: 'analysisTest', text: 'Тест Анализа' }, // Analysis Test
    // Добавьте другие ссылки здесь
  ];

  let navClasses = 'app-nav';
  if (state.isPortraitMode) {
    navClasses += ' is-portrait-header';
    if (state.isNavExpanded) {
      navClasses += ' menu-open';
    }
  } else {
    navClasses += ' is-landscape-sidebar';
    if (state.isNavExpanded) {
      navClasses += ' sidebar-expanded';
    } else {
      navClasses += ' sidebar-collapsed';
    }
  }
  
  let mainContentStyle: Record<string, string> = {};
  if (state.isPortraitMode) {
    mainContentStyle.paddingTop = 'var(--header-height, 60px)';
  } else {
    mainContentStyle.paddingLeft = state.isNavExpanded ? 'var(--sidebar-width-expanded, 250px)' : 'var(--sidebar-width-collapsed, 60px)';
  }

  return h('div#app-layout', { class: { 'portrait-mode': state.isPortraitMode, 'landscape-mode': !state.isPortraitMode } }, [
    h(`nav#${state.isPortraitMode ? 'app-header' : 'app-sidebar'}.${navClasses}`, [
      h('div.nav-header', [
        state.isPortraitMode || state.isNavExpanded ? h('span.app-title', 'ChessApp') : '',
        h('button.nav-toggle-button', { on: { click: () => controller.toggleNav() } },
          state.isNavExpanded ? '✕' : '☰'
        )
      ]),
      h('ul.nav-links', { class: { 'hidden-in-portrait-collapsed': state.isPortraitMode && !state.isNavExpanded } },
        navLinks.map(link =>
          h('li', [
            h('a', {
              class: { active: state.currentPage === link.page },
              props: { href: `#${link.page}` },
              on: {
                click: (e: Event) => {
                  e.preventDefault();
                  controller.navigateTo(link.page as any);
                }
              }
            }, link.text)
          ])
        )
      )
    ]),
    h('main#main-content', { style: mainContentStyle }, [
      (() => {
        if (!activeController) {
          return h('p', 'Загрузка контроллера страницы...'); // Loading page controller...
        }
        switch (state.currentPage) {
          case 'puzzle':
            if (activeController instanceof PuzzleController) {
              return renderPuzzleUI(activeController);
            }
            return h('p', 'Ошибка: Неверный контроллер для страницы Пазлы'); // Error: Incorrect controller for Puzzles page
          // ИСПРАВЛЕНИЕ: Раскомментируем блок для analysisTest
          case 'analysisTest':
            if (activeController instanceof AnalysisTestController) {
              return renderAnalysisTestUI(activeController);
            }
            return h('p', 'Ошибка: Неверный контроллер для страницы Тест Анализа'); // Error: Incorrect controller for Analysis Test page
          default:
            return h('p', `Страница "${state.currentPage}" не найдена или контроллер не загружен.`); // Page not found or controller not loaded.
        }
      })()
    ])
  ]);
}
