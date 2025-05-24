// src/features/clubPage/ClubPageController.ts
import logger from '../../utils/logger';
import type { AppServices } from '../../AppController';
// ClubData теперь импортируется с обновленной структурой (включая aggregated_player_stats)
import type { ClubData, ClubFollowRequestPayload, AggregatedPlayerData } from '../../core/webhook.service'; // Добавлен AggregatedPlayerData
import type { BackendUserSessionData, FollowClubs } from '../../core/auth.service';
import { subscribeToLangChange, t } from '../../core/i18n.service';

export interface ClubPageControllerState {
  isLoading: boolean;
  error: string | null;
  clubData: ClubData | null; // Будет использовать обновленный ClubData
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
        // requestGlobalRedraw вызывается внутри updateFollowStatusFromAuth, если состояние изменилось
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
      const data: ClubData | null = await this.services.webhookService.fetchClubStats(this.clubId);

      if (data) {
        // Если aggregated_player_stats отсутствует, инициализируем его пустым массивом
        if (!data.aggregated_player_stats) {
            logger.warn(`[ClubPageController] Fetched ClubData for ${this.clubId} is missing aggregated_player_stats. Initializing with an empty array.`);
            data.aggregated_player_stats = [] as AggregatedPlayerData[]; // Приведение типа для TypeScript
        }

        this.setState({
          clubData: data,
          isLoading: false,
          error: null,
          pageTitle: t('clubPage.title.loaded', { clubName: data.club_name || this.clubId }),
        });
        logger.info(`[ClubPageController] Club data loaded for ${this.clubId}:`, data);
      } else {
        const errorMessageForState = t('clubPage.error.dataLoadFailedOrNotRegistered', { clubId: this.clubId, defaultValue: `Failed to load data for club ${this.clubId} or club is not registered.` });
        this.setState({
          isLoading: false,
          error: errorMessageForState,
          clubData: null,
          pageTitle: t('clubPage.title.error', { defaultValue: 'Error Loading Club' }),
        });
        logger.warn(`[ClubPageController] fetchClubStats returned null for clubId: ${this.clubId}. Displaying 'not registered' modal.`);

        const modalMessage = t('clubPage.error.clubNotRegisteredModal.message', { clubId: this.clubId, defaultValue: `Клуб "${this.clubId}" не зарегистрирован. Для регистрации клуба обратитесь к администрации` });
        const contactLink = t('clubPage.error.clubNotRegisteredModal.contactLink', { defaultValue: `https://chessboard.fun` });
        this.services.appController.showModal(`${modalMessage} ${contactLink}`);
      }
    } catch (error: any) {
      logger.error(`[ClubPageController] Critical error during fetchClubStats for ${this.clubId}:`, error);
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
        const followedClubsData: FollowClubs | undefined = this.services.authService.getFollowClubs();
        if (followedClubsData && Array.isArray(followedClubsData.clubs)) {
            isFollowing = followedClubsData.clubs.some(club => club.club_id === this.clubId);
        }
    }
    // Обновляем состояние только если оно изменилось, чтобы избежать лишних перерисовок
    if (this.state.isFollowingCurrentClub !== isFollowing) {
        this.setState({ isFollowingCurrentClub: isFollowing });
    }
  }


  private updateLocalizedTexts(): void {
    let newPageTitle = this.state.pageTitle;
    if (this.state.isLoading) {
        newPageTitle = t('clubPage.title.loading', { defaultValue: 'Loading Club...' });
    } else if (this.state.error) {
        newPageTitle = t('clubPage.title.error', { defaultValue: 'Error Loading Club' });
    } else if (this.state.clubData) {
        newPageTitle = t('clubPage.title.loaded', { clubName: this.state.clubData.club_name || this.clubId });
    }

    if (this.state.pageTitle !== newPageTitle) {
        this.setState({ pageTitle: newPageTitle });
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
      this.services.appController.showModal(t('auth.requiredForAction',{defaultValue: 'Please log in to perform this action.'}));
      return;
    }
    if (this.state.isFollowRequestProcessing) {
      logger.warn('[ClubPageController toggleFollowCurrentClub] Follow request already in progress.');
      return;
    }

    const currentUser = this.services.authService.getUserProfile();
    if (!currentUser) {
      logger.error('[ClubPageController toggleFollowCurrentClub] Authenticated user profile not found.');
      this.services.appController.showModal(t('clubPage.error.profileNotFound',{defaultValue: 'User profile not found. Please try logging in again.'}));
      return;
    }

    if (!this.state.clubData || !this.state.clubData.club_name) {
        logger.error('[ClubPageController toggleFollowCurrentClub] Club data or club name is not available in state.');
        this.services.appController.showModal(t('clubPage.error.clubDataMissing',{defaultValue: 'Club information is missing. Cannot process follow request.'}));
        return;
    }

    this.setState({ isFollowRequestProcessing: true });

    const action: 'follow' | 'unfollow' = this.state.isFollowingCurrentClub ? 'unfollow' : 'follow';
    const payload: ClubFollowRequestPayload = {
      event: "clubFollow",
      lichess_id: currentUser.id,
      club_id: this.clubId,
      club_name: this.state.clubData.club_name,
      action: action,
    };

    logger.info(`[ClubPageController toggleFollowCurrentClub] Sending request to ${action} club ${this.clubId} (${this.state.clubData.club_name})`);
    let modalMessageKey: string = '';
    let showSuccessModal = false;

    try {
      const updatedSessionData: BackendUserSessionData | null = await this.services.webhookService.updateClubFollowStatus(payload);

      if (updatedSessionData && updatedSessionData.follow_clubs !== undefined) {
        this.services.authService.updateFollowClubs(updatedSessionData.follow_clubs);

        if (action === 'follow') {
            modalMessageKey = 'clubPage.follow.successAdded';
        } else {
            modalMessageKey = 'clubPage.follow.successRemoved';
        }
        showSuccessModal = true;
        logger.info(`[ClubPageController toggleFollowCurrentClub] Club follow status update request successful. AuthService will update state. New follow_clubs from backend:`, updatedSessionData.follow_clubs);
      } else {
        logger.error('[ClubPageController toggleFollowCurrentClub] Failed to update club follow status or webhook returned invalid data. Response:', updatedSessionData);
        modalMessageKey = 'clubPage.error.followFailed';
      }
    } catch (error: any) {
      logger.error('[ClubPageController toggleFollowCurrentClub] Error during follow/unfollow request:', error);
      modalMessageKey = 'clubPage.error.followRequestFailed';
    } finally {
      this.setState({ isFollowRequestProcessing: false });
      if (modalMessageKey && (showSuccessModal || modalMessageKey.includes('error'))) {
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
