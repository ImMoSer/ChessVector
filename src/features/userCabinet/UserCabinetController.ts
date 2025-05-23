// src/features/userCabinet/UserCabinetController.ts
import type { AppServices } from '../../AppController';
// FinishHimStats, SubscriptionTier, FollowClubs будут доступны через UserCabinetDataFromWebhook
// из webhook.service.ts, который в свою очередь импортирует их из auth.service.ts.
// Прямой импорт здесь не нужен.
import type { UserCabinetDataFromWebhook } from '../../core/webhook.service';
import { subscribeToLangChange, t } from '../../core/i18n.service';
import logger from '../../utils/logger';

export interface UserCabinetData extends UserCabinetDataFromWebhook {
  // На данный момент UserCabinetDataFromWebhook должен быть достаточен.
}

export interface UserCabinetControllerState {
  isLoading: boolean;
  error: string | null;
  cabinetData: UserCabinetData | null;
  pageTitle: string;
}

export class UserCabinetController {
  public state: UserCabinetControllerState;
  public services: AppServices; 
  private requestGlobalRedraw: () => void;
  private unsubscribeFromLangChange: (() => void) | null = null;
  private unsubscribeFromAuthChange: (() => void) | null = null;


  constructor(services: AppServices, requestGlobalRedraw: () => void) {
    this.services = services; 
    this.requestGlobalRedraw = requestGlobalRedraw;

    this.state = {
      isLoading: true,
      error: null,
      cabinetData: null,
      pageTitle: t('userCabinet.pageTitle.loading', { defaultValue: 'Loading User Cabinet...' }),
    };

    this.unsubscribeFromLangChange = subscribeToLangChange(() => {
      this.updateLocalizedTexts();
      this.requestGlobalRedraw();
    });

    this.unsubscribeFromAuthChange = this.services.authService.subscribe(() => {
        const isAuthenticated = this.services.authService.getIsAuthenticated();
        if (!isAuthenticated && this.state.cabinetData) {
            logger.info('[UserCabinetController] User logged out, clearing cabinet data.');
            this.setState({ cabinetData: null, error: t('userCabinet.error.notAuthenticated', { defaultValue: 'User is not authenticated.' }) });
        } else if (isAuthenticated && !this.state.cabinetData && !this.state.isLoading && !this.state.error) {
            logger.info('[UserCabinetController] User authenticated, but no cabinet data. Re-initializing.');
            this.initializePage();
        }
    });

    logger.info('[UserCabinetController] Initialized.');
  }

  public async initializePage(): Promise<void> {
    logger.info('[UserCabinetController] Initializing page data...');
    this.setState({ isLoading: true, error: null, cabinetData: null }); 
    this.updateLocalizedTexts(); 

    const currentUser = this.services.authService.getUserProfile();
    if (!currentUser || !currentUser.id) {
      logger.warn('[UserCabinetController] No authenticated user found. Cannot fetch cabinet data.');
      this.setState({
        isLoading: false,
        error: t('userCabinet.error.notAuthenticated', { defaultValue: 'User is not authenticated.' }),
        pageTitle: t('userCabinet.pageTitle.error', { defaultValue: 'Error' })
      });
      return;
    }

    try {
      const cabinetDataFromWebhook = await this.services.webhookService.fetchUserCabinetData({
        event: "userCabinet",
        lichess_id: currentUser.id,
      });

      if (cabinetDataFromWebhook) {
        this.setState({
          cabinetData: cabinetDataFromWebhook, 
          isLoading: false,
          error: null,
          pageTitle: t('userCabinet.pageTitle.loaded', { username: cabinetDataFromWebhook.username || currentUser.username, defaultValue: `${cabinetDataFromWebhook.username || currentUser.username}'s Cabinet` }),
        });
        logger.info('[UserCabinetController] User cabinet data loaded:', cabinetDataFromWebhook);
      } else {
        logger.error('[UserCabinetController] Failed to fetch user cabinet data: WebhookService returned null.');
        this.setState({
          isLoading: false,
          error: t('userCabinet.error.dataLoadFailed', { defaultValue: 'Failed to load user cabinet data.' }),
          cabinetData: null,
          pageTitle: t('userCabinet.pageTitle.error', { defaultValue: 'Error' })
        });
      }
    } catch (error: any) {
      logger.error('[UserCabinetController] Error fetching user cabinet data:', error);
      this.setState({
        isLoading: false,
        error: error.message || t('userCabinet.error.unknown', { defaultValue: 'An unknown error occurred.' }),
        cabinetData: null,
        pageTitle: t('userCabinet.pageTitle.error', { defaultValue: 'Error' })
      });
    }
  }

  public updateLocalizedTexts(): void {
    let newPageTitle = this.state.pageTitle;
    if (this.state.isLoading) {
      newPageTitle = t('userCabinet.pageTitle.loading', { defaultValue: 'Loading User Cabinet...' });
    } else if (this.state.error) {
      newPageTitle = t('userCabinet.pageTitle.error', { defaultValue: 'Error' });
    } else if (this.state.cabinetData) {
      const username = this.state.cabinetData.username || this.services.authService.getUserProfile()?.username || 'User';
      newPageTitle = t('userCabinet.pageTitle.loaded', { username: username, defaultValue: `${username}'s Cabinet` });
    }
    if (this.state.pageTitle !== newPageTitle) {
        this.setState({ pageTitle: newPageTitle });
    }
  }

  private setState(newState: Partial<UserCabinetControllerState>): void {
    let hasChanged = false;
    for (const key in newState) {
      if (Object.prototype.hasOwnProperty.call(newState, key)) {
        const typedKey = key as keyof UserCabinetControllerState;
        if (this.state[typedKey] !== newState[typedKey]) {
          hasChanged = true;
          break;
        }
      }
    }
    this.state = { ...this.state, ...newState };
    if (hasChanged) {
      this.requestGlobalRedraw();
    }
  }

  public destroy(): void {
    if (this.unsubscribeFromLangChange) {
      this.unsubscribeFromLangChange();
      this.unsubscribeFromLangChange = null;
    }
    if (this.unsubscribeFromAuthChange) {
        this.unsubscribeFromAuthChange();
        this.unsubscribeFromAuthChange = null;
    }
    logger.info('[UserCabinetController] Destroyed.');
  }
}
