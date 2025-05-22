// src/features/clubPage/ClubPageController.ts
import logger from '../../utils/logger';
import type { AppServices } from '../../AppController';
// Изменено: ClubStatsRequestPayload больше не импортируется, т.к. метод fetchClubStats принимает club_id
import type { ClubData } from '../../core/webhook.service';
import { subscribeToLangChange, t } from '../../core/i18n.service';

export interface ClubPageControllerState {
  isLoading: boolean;
  error: string | null;
  clubData: ClubData | null;
  clubId: string;
  pageTitle: string;
  expandedBattleId: string | null;
}

export class ClubPageController {
  public state: ClubPageControllerState;
  private services: AppServices;
  private requestGlobalRedraw: () => void;
  private clubId: string;
  private unsubscribeFromLangChange: (() => void) | null = null;

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
    };

    this.unsubscribeFromLangChange = subscribeToLangChange(() => {
        this.updateLocalizedTexts();
        this.requestGlobalRedraw();
    });

    logger.info(`[ClubPageController] Initialized for clubId: ${this.clubId}`);
  }

  public async initializePage(): Promise<void> {
    logger.info(`[ClubPageController] Initializing page for clubId: ${this.clubId}`);
    this.setState({ isLoading: true, error: null, expandedBattleId: null }); 
    this.updateLocalizedTexts();

    try {
      // Изменено: передаем только clubId, а не объект payload
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

  private setState(newState: Partial<ClubPageControllerState>): void {
    this.state = { ...this.state, ...newState };
    this.requestGlobalRedraw();
  }

  public destroy(): void {
    if (this.unsubscribeFromLangChange) {
      this.unsubscribeFromLangChange();
      this.unsubscribeFromLangChange = null;
    }
    logger.info(`[ClubPageController] Destroyed for clubId: ${this.clubId}`);
  }
}
