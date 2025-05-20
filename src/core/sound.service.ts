// src/core/sound.service.ts
import logger from '../utils/logger';

/**
 * Defines all possible sound types that can be played in the application.
 */
export type SoundType =
  | 'move'                     // Standard piece move
  | 'capture'                  // Piece capture
  | 'check'                    // Check
  | 'promote'                  // Pawn promotion
  | 'stalemate'                // Stalemate (uses lachen.wav)
  | 'puzzle_playout_start'     // Start of playout phase in puzzle (finish-him.wav)
  | 'puzzle_user_lost'         // User lost the puzzle (fatality.wav)
  | 'puzzle_user_won'          // User won the puzzle (flawless-victory.wav)
  | 'USER_TACTICAL_FAIL'       // User made an incorrect tactical move (newer_win.WAV)
  | 'DRAW_GENERAL'             // General draw sound (impressiv.WAV)
  | 'PLAYOUT_TIME_UP';         // Playout timer expired (bellding.mp3)

/**
 * Maps SoundType to the path of the audio file in the /public/audio/ directory.
 * Vite automatically serves files from /public at the root path.
 */
const soundFiles: Record<SoundType, string> = {
  move: '/audio/ChessCOM_move.mp3',
  capture: '/audio/ChessCOM_capture.mp3',
  check: '/audio/ChessCOM_check.mp3',
  promote: '/audio/ChessCOM_promote.mp3',
  stalemate: '/audio/lachen.wav',
  puzzle_playout_start: '/audio/finish-him.wav',
  puzzle_user_lost: '/audio/fatality.wav',
  puzzle_user_won: '/audio/flawless-victory.wav',
  USER_TACTICAL_FAIL: '/audio/newer_win.WAV',
  DRAW_GENERAL: '/audio/impressiv.WAV',
  PLAYOUT_TIME_UP: '/audio/bellding.mp3', // New sound for timer expiration
};

class SoundServiceController {
  private audioCache: Map<SoundType, HTMLAudioElement> = new Map();
  private isInitialized: boolean = false;
  private initPromise: Promise<void>;
  private resolveInitPromise!: () => void;
  private rejectInitPromise!: (reason?: any) => void;

  constructor() {
    this.initPromise = new Promise<void>((resolve, reject) => {
      this.resolveInitPromise = resolve;
      this.rejectInitPromise = reject;
    });
    this.initializeAudio();
  }

  /**
   * Asynchronously loads all audio files specified in soundFiles.
   * Uses the 'canplaythrough' event to determine successful loading.
   */
  private async initializeAudio(): Promise<void> {
    logger.info('[SoundService] Initializing audio assets...');
    const loadPromises: Promise<void>[] = [];

    for (const key in soundFiles) {
      const soundName = key as SoundType;
      const path = soundFiles[soundName];
      const audio = new Audio(path);

      const loadPromise = new Promise<void>((resolve, reject) => {
        audio.oncanplaythrough = () => {
          this.audioCache.set(soundName, audio);
          logger.debug(`[SoundService] Audio loaded successfully: ${soundName} from ${path}`);
          resolve();
        };
        audio.onerror = (e) => {
          logger.error(`[SoundService] Error loading audio: ${soundName} from ${path}`, e);
          const error = new Error(`Failed to load audio '${soundName}' from '${path}'. Check path and network.`);
          reject(error);
        };
        audio.preload = 'auto';
      });
      loadPromises.push(loadPromise);
    }

    try {
      await Promise.all(loadPromises);
      this.isInitialized = true;
      logger.info('[SoundService] All audio assets initialized successfully.');
      this.resolveInitPromise();
    } catch (error) {
      logger.error('[SoundService] Failed to initialize one or more audio assets.', error);
      this.rejectInitPromise(error);
    }
  }

  /**
   * Plays the specified sound.
   * @param soundName - The type of sound to play (a key from SoundType).
   */
  public playSound(soundName: SoundType): void {
    if (!this.isInitialized) {
      logger.warn(`[SoundService] Audio not yet initialized. Cannot play: ${soundName}. Waiting for initialization...`);
      this.initPromise.then(() => {
        logger.info(`[SoundService] Initialization complete after waiting. Retrying to play: ${soundName}`);
        this.playSoundInternal(soundName);
      }).catch(error => {
        logger.warn(`[SoundService] Initialization failed, cannot play ${soundName}. Error: ${error?.message || error}`);
      });
      return;
    }
    this.playSoundInternal(soundName);
  }

  /**
   * Internal method to play sound after initialization check.
   */
  private playSoundInternal(soundName: SoundType): void {
    const audio = this.audioCache.get(soundName);
    if (audio) {
      audio.currentTime = 0;
      audio.play().catch(error => {
        logger.warn(`[SoundService] Error playing sound '${soundName}':`, error.message);
      });
    } else {
      logger.warn(`[SoundService] Sound not found in cache: ${soundName}. Was it loaded correctly?`);
    }
  }

  /**
   * Returns a promise that resolves when all sounds are loaded.
   */
  public async ensureInitialized(): Promise<void> {
    if (this.isInitialized) {
      return Promise.resolve();
    }
    return this.initPromise;
  }

  /**
   * Checks if the service has been successfully initialized.
   */
  public get isReady(): boolean {
    return this.isInitialized;
  }
}

export const SoundService = new SoundServiceController();
