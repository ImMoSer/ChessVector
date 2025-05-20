// src/features/auth/lichessCallbackView.ts
import { h } from 'snabbdom';
import type { VNode } from 'snabbdom';
import type { LichessCallbackController } from './lichessCallbackController';
import logger from '../../utils/logger';

export function renderLichessCallbackPage(controller: LichessCallbackController): VNode {
  controller.updateLocalizedTexts(); // Обновляем тексты перед рендерингом
  const { message, errorMessage, isProcessing } = controller.state;

  logger.debug('[LichessCallbackView] Rendering Lichess Callback Page. Message:', message, 'Error:', errorMessage, 'Processing:', isProcessing);

  return h('div.lichess-callback-page-container', [
    h('div.callback-content', [
      h('h1.callback-title', message),
      errorMessage ? h('p.error-message', errorMessage) : null,
      isProcessing ? h('div.loading-spinner') : null,
      // Можно добавить кнопку для возврата на главную, если обработка зависла или для информации
      !isProcessing && errorMessage ?
        h('a.button.button-secondary', { props: { href: '#welcome' }, on: { click: (e: Event) => {
            e.preventDefault();
            // controller.appController.navigateTo('welcome') // Если бы appController был доступен напрямую
            // Вместо этого, AppController должен сам обработать переход по хэшу
        }}}, 'Go to Welcome Page') // TODO: Локализовать
        : null
    ]),
  ]);
}
