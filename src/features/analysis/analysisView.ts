// src/features/analysis/analysisView.ts
import { h } from 'snabbdom';
import type { VNode } from 'snabbdom';
import type { AnalysisStateForUI, EvaluatedLineWithSan } from '../../core/analysis.service'; // Тип EvaluatedLineWithSan используется
import { t } from '../../core/i18n.service';
import logger from '../../utils/logger';

/**
 * Рендерит отображение линий анализа в виде цветных плашек.
 * @param analysisState - Текущее состояние анализа (isActive, isLoading, lines).
 * @param onPlayMoveFromLine - Колбэк, вызываемый при клике на линию анализа. 
 * Передает UCI первого хода выбранной линии.
 * @returns VNode контейнера с линиями анализа или сообщение о состоянии.
 */
export function renderAnalysisLinesView(
  analysisState: AnalysisStateForUI | null,
  onPlayMoveFromLine: (uciMove: string) => void
): VNode {
  if (!analysisState || !analysisState.isActive) {
    return h('div.analysis-view-container', [
      h('div.inactive-message', t('analysis.inactive'))
    ]);
  }

  if (analysisState.isLoading) {
    return h('div.analysis-view-container', [
      h('div.loading-message', t('analysis.loading'))
    ]);
  }

  if (!analysisState.lines || analysisState.lines.length === 0) {
    return h('div.analysis-view-container', [
      h('div.no-data-message', t('analysis.noData'))
    ]);
  }

  const lineLozenges = analysisState.lines.map((line: EvaluatedLineWithSan, index: number) => { // Явная аннотация типа для line
    let lozengeClass = 'analysis-line-lozenge';
    if (index === 0) {
      lozengeClass += '.best-line';
    } else if (index === 1) {
      lozengeClass += '.second-line';
    } else if (index === 2) {
      lozengeClass += '.third-line';
    } else {
      lozengeClass += '.other-line';
    }

    const scoreValueDisplay = line.score.type === 'cp' 
      ? (line.score.value / 100).toFixed(2) 
      : `${t('analysis.mateIn', { value: Math.abs(line.score.value) })}${line.score.value < 0 ? ' (противник)' : ''}`;

    let pvString = "";
    let currentMoveNumber = line.initialFullMoveNumber;
    let turnForPv = line.initialTurn;

    line.pvSan.forEach((san, sanIndex) => {
      if (turnForPv === 'white') {
        pvString += `${currentMoveNumber}. ${san} `;
      } else {
        if (sanIndex === 0 && line.pvSan.length > 1) {
             pvString += `${currentMoveNumber}...${san} `;
        } else {
             pvString += `${san} `;
        }
      }
      if (turnForPv === 'black') {
        currentMoveNumber++;
      }
      turnForPv = turnForPv === 'white' ? 'black' : 'white';
    });
    
    const firstMoveUci = line.pvUci.length > 0 ? line.pvUci[0] : null;

    return h(lozengeClass, {
      key: `analysis-line-${line.id}-${index}`,
      on: {
        click: () => {
          if (firstMoveUci) {
            logger.debug(`[analysisView] Clicked line ${index + 1}, first move UCI: ${firstMoveUci}`);
            onPlayMoveFromLine(firstMoveUci);
          } else {
            logger.warn(`[analysisView] Clicked line ${index + 1}, but no UCI move available.`);
          }
        }
      },
      attrs: {
        title: firstMoveUci ? t('analysis.pvPrefix') + pvString.trim() : t('analysis.noData')
      }
    }, [
      h('span.analysis-score', scoreValueDisplay),
      h('span.analysis-pv-san', pvString.trim())
    ]);
  });

  return h('div.analysis-view-container', lineLozenges);
}
