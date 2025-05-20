// src/features/welcome/welcomeView.ts
import { h } from 'snabbdom';
import type { VNode } from 'snabbdom';
import type { WelcomeController } from './welcomeController';
import logger from '../../utils/logger'; // Для отладки, если понадобится

export function renderWelcomePage(controller: WelcomeController): VNode {
  // Обновляем локализованные тексты перед рендерингом, если язык мог измениться
  controller.updateLocalizedTexts();
  const { isAuthProcessing, authError, welcomeMessage, loginButtonText } = controller.state;

  logger.debug('[WelcomeView] Rendering Welcome Page. isAuthProcessing:', isAuthProcessing, 'Error:', authError);

  return h('div.welcome-page-container', [
    h('div.welcome-content', [
      h('h1.welcome-title', welcomeMessage),
      h('p.welcome-subtitle', 'chessboard.fun'), // Можно также локализовать, если нужно
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
      // Можно добавить дополнительную информацию или ссылки здесь
    ]),
  ]);
}
