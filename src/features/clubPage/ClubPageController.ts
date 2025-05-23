// src/features/clubPage/ClubPageController.ts
import logger from '../../utils/logger';
import type { AppServices } from '../../AppController';
// BackendUserSessionData теперь импортируется из auth.service
import type { ClubData, ClubFollowRequestPayload } from '../../core/webhook.service';
import type { BackendUserSessionData } from '../../core/auth.service'; // ИЗМЕНЕНО: Прямой импорт
import { subscribeToLangChange, t } from '../../core/i18n.service';

export interface ClubPageControllerState {
  isLoading: boolean;
  error: string | null;
  clubData: ClubData | null;
  clubId: string;
  pageTitle: string;
  expandedBattleId: string | null;
  isFollowingCurrentClub: boolean;
  isFollowRequestProcessing: boolean;
}

export class ClubPageController {
  public state: ClubPageControllerState;
  private services: AppServices;
  private requestGlobalRedraw: () => void;
  private clubId: string;
  private unsubscribeFromLangChange: (() => void) | null = null;
  private unsubscribeFromAuthChange: (() => void) | null = null;

  constructor(clubId: string, services: AppServices, requestGlobalRedraw: () => void) {
    this.clubId = clubId;
    this.services = services;
    this.requestGlobalRedraw = requestGlobalRedraw;

    this.state = {
      isLoading: true,
      error: null,
      clubData: null,
      clubId: this.clubId,
      pageTitle: t('clubPage.title.loading', { defaultValue: 'Loading Club...' }),
      expandedBattleId: null,
      isFollowingCurrentClub: false,
      isFollowRequestProcessing: false,
    };

    this.unsubscribeFromLangChange = subscribeToLangChange(() => {
        this.updateLocalizedTexts();
        this.requestGlobalRedraw();
    });

    this.unsubscribeFromAuthChange = this.services.authService.subscribe(() => {
        this.updateFollowStatusFromAuth();
    });

    logger.info(`[ClubPageController] Initialized for clubId: ${this.clubId}`);
  }

  public getIsUserAuthenticated(): boolean {
    return this.services.authService.getIsAuthenticated();
  }

  public async initializePage(): Promise<void> {
    logger.info(`[ClubPageController] Initializing page for clubId: ${this.clubId}`);
    this.setState({ isLoading: true, error: null, expandedBattleId: null, isFollowRequestProcessing: false });
    this.updateLocalizedTexts();
    this.updateFollowStatusFromAuth();

    try {
      const data = await this.services.webhookService.fetchClubStats(this.clubId);

      if (data) {
        this.setState({
          clubData: data,
          isLoading: false,
          error: null,
          pageTitle: t('clubPage.title.loaded', { clubName: data.club_name || this.clubId }),
        });
        logger.info(`[ClubPageController] Club data loaded for ${this.clubId}:`, data);
      } else {
        throw new Error(t('clubPage.error.dataLoadFailed', { defaultValue: 'Failed to load club data.' }));
      }
    } catch (error: any) {
      logger.error(`[ClubPageController] Error fetching club data for ${this.clubId}:`, error);
      this.setState({
        isLoading: false,
        error: error.message || t('clubPage.error.unknown', { defaultValue: 'An unknown error occurred.' }),
        clubData: null,
        pageTitle: t('clubPage.title.error', { defaultValue: 'Error Loading Club' }),
      });
    }
  }

  private updateFollowStatusFromAuth(): void {
    const isAuthenticated = this.getIsUserAuthenticated();
    let isFollowing = false;
    if (isAuthenticated) {
        const followedClubs = this.services.authService.getFollowClubs();
        isFollowing = !!(followedClubs && followedClubs.club_ids.includes(this.clubId));
    }
    if (this.state.isFollowingCurrentClub !== isFollowing) {
        this.setState({ isFollowingCurrentClub: isFollowing });
    }
  }


  private updateLocalizedTexts(): void {
    if (this.state.isLoading) {
        this.state.pageTitle = t('clubPage.title.loading', { defaultValue: 'Loading Club...' });
    } else if (this.state.error) {
        this.state.pageTitle = t('clubPage.title.error', { defaultValue: 'Error Loading Club' });
    } else if (this.state.clubData) {
        this.state.pageTitle = t('clubPage.title.loaded', { clubName: this.state.clubData.club_name || this.clubId });
    }
  }

  public toggleTournamentDetails(arenaId: string): void {
    const newExpandedId = this.state.expandedBattleId === arenaId ? null : arenaId;
    this.setState({ expandedBattleId: newExpandedId });
    logger.debug(`[ClubPageController] Toggled tournament details for ${arenaId}. Expanded: ${newExpandedId}`);
  }

  public async toggleFollowCurrentClub(): Promise<void> {
    if (!this.getIsUserAuthenticated()) {
      logger.warn('[ClubPageController toggleFollowCurrentClub] User not authenticated. Action aborted.');
      this.services.appController.showModal(t('auth.requiredForAction', {defaultValue: 'Please log in to perform this action.'}));
      return;
    }
    if (this.state.isFollowRequestProcessing) {
      logger.warn('[ClubPageController toggleFollowCurrentClub] Follow request already in progress.');
      return;
    }

    const currentUser = this.services.authService.getUserProfile();
    if (!currentUser) {
      logger.error('[ClubPageController toggleFollowCurrentClub] Authenticated user profile not found.');
      this.services.appController.showModal(t('clubPage.error.profileNotFound', {defaultValue: 'User profile not found. Please try logging in again.'}));
      return;
    }

    this.setState({ isFollowRequestProcessing: true });

    const action: 'follow' | 'unfollow' = this.state.isFollowingCurrentClub ? 'unfollow' : 'follow';
    const payload: ClubFollowRequestPayload = {
      event: "clubFollow",
      lichess_id: currentUser.id,
      club_id: this.clubId,
      action: action,
    };

    logger.info(`[ClubPageController toggleFollowCurrentClub] Sending request to ${action} club ${this.clubId}`);
    let modalMessageKey: string = '';

    try {
      const updatedSessionData: BackendUserSessionData | null = await this.services.webhookService.updateClubFollowStatus(payload);

      if (updatedSessionData && updatedSessionData.follow_clubs !== undefined) {
        this.services.authService.updateFollowClubs(updatedSessionData.follow_clubs);
        if (action === 'follow') {
            modalMessageKey = 'clubPage.follow.successAdded';
        } else {
            modalMessageKey = 'clubPage.follow.successRemoved';
        }
        logger.info(`[ClubPageController toggleFollowCurrentClub] Club follow status updated successfully. New follow_clubs:`, updatedSessionData.follow_clubs);
      } else {
        logger.error('[ClubPageController toggleFollowCurrentClub] Failed to update club follow status or webhook returned invalid data. Response:', updatedSessionData);
        modalMessageKey = 'clubPage.error.followFailed';
      }
    } catch (error: any) {
      logger.error('[ClubPageController toggleFollowCurrentClub] Error during follow/unfollow request:', error);
      modalMessageKey = 'clubPage.error.followRequestFailed';
    } finally {
      this.setState({ isFollowRequestProcessing: false });
      if (modalMessageKey) {
        this.services.appController.showModal(t(modalMessageKey));
      }
    }
  }

  private setState(newState: Partial<ClubPageControllerState>): void {
    let hasChanged = false;
    for (const key in newState) {
        if (Object.prototype.hasOwnProperty.call(newState, key)) {
            const typedKey = key as keyof ClubPageControllerState;
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
    logger.info(`[ClubPageController] Destroyed for clubId: ${this.clubId}`);
  }
}
