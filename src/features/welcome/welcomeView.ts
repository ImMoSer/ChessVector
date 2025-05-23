// src/features/welcome/welcomeView.ts
import { h } from 'snabbdom';
import type { VNode } from 'snabbdom';
import type { WelcomeController } from './welcomeController';
import logger from '../../utils/logger'; // Для отладки, если понадобится

export function renderWelcomePage(controller: WelcomeController): VNode {
  // Обновляем локализованные тексты перед рендерингом, если язык мог измениться
  controller.updateLocalizedTexts(); // Это вызовет t() для loginButtonText
  const { isAuthProcessing, authError, loginButtonText } = controller.state;

  logger.debug('[WelcomeView] Rendering Welcome Page. isAuthProcessing:', isAuthProcessing, 'Error:', authError);

  return h('div.welcome-page-container', [
    h('div.welcome-content', [
      // Добавляем изображение
      h('img.welcome-image', {
        props: {
          src: '/svg/1920_Banner.svg', // Путь к изображению в папке public
          alt: 'Chessboard Image' // Альтернативный текст для изображения
        }
      }),
      // Оставляем только кнопку входа и сообщение об ошибке, если оно есть
      authError ? h('p.error-message', `Error: ${authError}`) : null,
      h('button.login-button.button-primary',
        {
          on: {
            click: () => controller.handleLogin(),
          },
          attrs: {
            disabled: isAuthProcessing,
          },
        },
        isAuthProcessing ? 'Processing...' : loginButtonText // Можно локализовать 'Processing...'
      ),
    ]),
  ]);
}
